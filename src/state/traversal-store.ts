/**
 * Stateless traversal orchestrator. Every public operation loads the stack
 * from the backing StateStore, rebuilds a GraphEngine, executes, and writes
 * back. No in-memory engine state survives between calls.
 */

import crypto from "node:crypto";
import type { ContextCaps } from "../engine/context.js";
import type { HookRunner } from "../engine/hooks.js";
import { GraphEngine } from "../engine/index.js";
import { EngineError } from "../errors.js";
import type {
  AdvanceResult,
  ContextSetResult,
  InspectField,
  InspectResult,
  ResetResult,
  StartResult,
  TraversalInfo,
  TraversalListResult,
  ValidatedGraph,
} from "../types.js";
import type { StateStore, TraversalRecord } from "./db.js";

function generateTraversalId(): string {
  return `tr_${crypto.randomBytes(4).toString("hex")}`;
}

function recordToInfo(row: TraversalRecord): TraversalInfo {
  return {
    traversalId: row.id,
    graphId: row.graphId,
    currentNode: row.currentNode,
    lastUpdated: row.updatedAt,
    stackDepth: row.stackDepth,
    meta: row.meta ?? EMPTY_META,
  };
}

// Shared empty-meta sentinel for normalizing `record.meta` on reads.
// Reusing one frozen object avoids allocating a new `{}` per read and
// signals "intentionally empty" to downstream consumers.
const EMPTY_META: Readonly<Record<string, string>> = Object.freeze({});

export class TraversalStore {
  private state: StateStore;
  private graphs: Map<string, ValidatedGraph>;
  private maxDepth: number;
  private hookRunner: HookRunner;
  private contextCaps?: ContextCaps;

  constructor(
    state: StateStore,
    graphs: Map<string, ValidatedGraph>,
    options: { maxDepth?: number; hookRunner: HookRunner; contextCaps?: ContextCaps },
  ) {
    this.state = state;
    this.graphs = graphs;
    this.maxDepth = options.maxDepth ?? 5;
    this.hookRunner = options.hookRunner;
    this.contextCaps = options.contextCaps;
  }

  close(): void {
    this.state.close();
  }

  updateGraphs(newGraphs: Map<string, ValidatedGraph>): void {
    this.graphs = newGraphs;
  }

  // --- Read operations ---

  listGraphs(): TraversalListResult {
    // Sort by id so `freelance_list` is deterministic across filesystems
    // and runs — eval harnesses diff the output, and readdir order is not
    // stable across platforms.
    const graphList = [];
    for (const [id, vg] of this.graphs) {
      graphList.push({
        id,
        name: vg.definition.name,
        version: vg.definition.version,
        description: vg.definition.description ?? "",
      });
    }
    graphList.sort((a, b) => a.id.localeCompare(b.id));
    return {
      graphs: graphList,
      activeTraversals: this.listTraversals(),
    };
  }

  listTraversals(): TraversalInfo[] {
    return this.state.list().map(recordToInfo);
  }

  /** Check whether any active traversal belongs to one of the given graph IDs. */
  hasActiveTraversalForGraph(...graphIds: string[]): boolean {
    if (graphIds.length === 0) return false;
    const targets = new Set(graphIds);
    return this.state.list().some((r) => targets.has(r.graphId));
  }

  // --- Traversal operations ---

  async createTraversal(
    graphId: string,
    initialContext?: Record<string, unknown>,
    meta?: Record<string, string>,
  ): Promise<{ traversalId: string; meta: Record<string, string> } & StartResult> {
    const id = generateTraversalId();
    const engine = this.newEngine();
    // Collect any meta written by onEnter hooks fired during start, so the
    // initial put below already includes them (avoids a double write).
    const hookMeta: Record<string, string> = {};
    const result = await engine.start(graphId, initialContext, {
      metaCollector: (updates) => Object.assign(hookMeta, updates),
    });

    const stack = engine.getStack();
    const now = new Date().toISOString();
    const active = stack[stack.length - 1];

    // hookMeta wins on key collision — the workflow's own tagging is the
    // later, more specific write. Empty merged object collapses to undefined
    // so the record shape stays "meta absent" rather than "meta: {}".
    const mergedMeta = { ...meta, ...hookMeta };
    const merged = Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined;

    // Enforce graph-declared requiredMeta *after* hook collection, so an
    // onEnter `meta_set` hook on the start node can satisfy a required key
    // derived from context. If still missing after hooks, the record is
    // never persisted — start is transactional.
    const graph = this.graphs.get(graphId);
    const required = graph?.definition.requiredMeta;
    if (required && required.length > 0) {
      const missing = required.filter((k) => !merged || merged[k] === undefined);
      if (missing.length > 0) {
        throw new EngineError(
          `Graph "${graphId}" requires meta keys [${missing.join(", ")}] at start. ` +
            `Pass them via freelance_start's \`meta\` argument, or set them via an ` +
            `onEnter meta_set hook on the start node.`,
          "REQUIRED_META_MISSING",
        );
      }
    }

    const record: TraversalRecord = {
      id,
      stack,
      graphId: active.graphId,
      currentNode: active.currentNode,
      stackDepth: stack.length,
      createdAt: now,
      updatedAt: now,
      ...(merged && { meta: merged }),
    };
    this.state.put(record);

    return { traversalId: id, meta: merged ?? EMPTY_META, ...result };
  }

  async advance(
    traversalId: string,
    edge: string,
    contextUpdates?: Record<string, unknown>,
  ): Promise<{ traversalId: string; meta: Record<string, string> } & AdvanceResult> {
    const { engine, record } = this.loadEngine(traversalId);
    const hookMeta: Record<string, string> = {};
    const result = await engine.advance(edge, contextUpdates, {
      metaCollector: (updates) => Object.assign(hookMeta, updates),
    });
    // Merge collected hook updates into the in-memory record before save —
    // saveEngine carries record.meta forward verbatim, so this is the
    // single point of integration. Avoids a separate setMeta + extra disk
    // write per advance.
    if (Object.keys(hookMeta).length > 0) {
      record.meta = { ...record.meta, ...hookMeta };
    }
    this.saveEngine(record, engine);
    return { traversalId, meta: record.meta ?? EMPTY_META, ...result };
  }

  contextSet(
    traversalId: string,
    updates: Record<string, unknown>,
  ): { traversalId: string } & ContextSetResult {
    const { engine, record } = this.loadEngine(traversalId);
    const result = engine.contextSet(updates);
    this.saveEngine(record, engine);
    return { traversalId, ...result };
  }

  /**
   * Merge opaque tags into a traversal's `meta`. New keys are added, existing
   * keys are overwritten. Pass a non-empty object — Freelance still never
   * interprets keys or values, but rejects empty updates to avoid silent
   * no-op calls.
   */
  setMeta(
    traversalId: string,
    updates: Record<string, string>,
  ): { traversalId: string; meta: Record<string, string> } {
    if (Object.keys(updates).length === 0) {
      throw new EngineError("setMeta requires at least one key=value pair", "INVALID_META");
    }
    const record = this.state.get(traversalId);
    if (!record) {
      throw new EngineError(`Traversal "${traversalId}" not found`, "TRAVERSAL_NOT_FOUND");
    }
    const meta = { ...record.meta, ...updates };
    this.state.put({ ...record, meta, updatedAt: new Date().toISOString() });
    return { traversalId, meta };
  }

  inspect(
    traversalId: string,
    detail?: "position" | "history",
    fields?: readonly InspectField[],
  ): { traversalId: string; meta: Record<string, string> } & InspectResult {
    const { engine, record } = this.loadEngine(traversalId);
    const result = engine.inspect(detail, fields);
    return { traversalId, meta: record.meta ?? EMPTY_META, ...result };
  }

  resetTraversal(traversalId: string): { traversalId: string } & ResetResult {
    const { engine } = this.loadEngine(traversalId);
    const result = engine.reset();
    this.state.delete(traversalId);
    return { traversalId, ...result };
  }

  resolveTraversalId(traversalId?: string): string {
    // Explicit id: defer the existence check to loadEngine's ENOENT path —
    // no need for a redundant stat here.
    if (traversalId) return traversalId;

    const ids = this.state.listIds();
    if (ids.length === 0) {
      throw new EngineError("No active traversals. Call freelance_start first.", "NO_TRAVERSAL");
    }
    if (ids.length === 1) return ids[0];

    // Ambiguous: only now do we need the full records to build a useful error.
    const records = this.state.list();
    const summary = records
      .map((t) => {
        const base = `${t.id} (${t.graphId} @ ${t.currentNode})`;
        return t.meta ? `${base} ${JSON.stringify(t.meta)}` : base;
      })
      .join(", ");
    throw new EngineError(
      `Multiple active traversals. Specify traversalId. Active: ${summary}`,
      "AMBIGUOUS_TRAVERSAL",
    );
  }

  // --- Engine load/save ---

  private newEngine(): GraphEngine {
    return new GraphEngine(this.graphs, {
      maxDepth: this.maxDepth,
      hookRunner: this.hookRunner,
      ...(this.contextCaps ? { contextCaps: this.contextCaps } : {}),
    });
  }

  private loadEngine(traversalId: string): { engine: GraphEngine; record: TraversalRecord } {
    const record = this.state.get(traversalId);
    if (!record) {
      throw new EngineError(`Traversal "${traversalId}" not found`, "TRAVERSAL_NOT_FOUND");
    }

    const engine = this.newEngine();
    engine.restoreStack(record.stack);
    return { engine, record };
  }

  private saveEngine(record: TraversalRecord, engine: GraphEngine): void {
    const stack = engine.getStack();

    if (stack.length === 0) {
      // Engine was reset or completed — remove from store
      this.state.delete(record.id);
      return;
    }

    const active = stack[stack.length - 1];
    const next: TraversalRecord = {
      id: record.id,
      stack,
      graphId: active.graphId,
      currentNode: active.currentNode,
      stackDepth: stack.length,
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // Carry meta forward. Callers that want to update it (setMeta, the
    // meta_set onEnter hook) mutate record.meta *before* calling saveEngine,
    // so reading from `record` here picks up their writes.
    if (record.meta) next.meta = record.meta;
    this.state.put(next);
  }
}

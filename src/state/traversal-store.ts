/**
 * Stateless traversal orchestrator. Every public operation loads the stack
 * from the backing StateStore, rebuilds a GraphEngine, executes, and writes
 * back. No in-memory engine state survives between calls.
 */

import crypto from "node:crypto";
import type { HookRunner } from "../engine/hooks.js";
import { GraphEngine } from "../engine/index.js";
import { EngineError } from "../errors.js";
import type {
  AdvanceResult,
  ContextSetResult,
  InspectPositionResult,
  InspectResult,
  ResetResult,
  ResumeResult,
  StartResult,
  TraversalFindResult,
  TraversalInfo,
  TraversalListResult,
  ValidatedGraph,
} from "../types.js";
import type { StateStore, TraversalRecord } from "./db.js";

function generateTraversalId(): string {
  return `tr_${crypto.randomBytes(4).toString("hex")}`;
}

function recordToInfo(row: TraversalRecord): TraversalInfo {
  const info: TraversalInfo = {
    traversalId: row.id,
    graphId: row.graphId,
    currentNode: row.currentNode,
    lastUpdated: row.updatedAt,
    stackDepth: row.stackDepth,
  };
  return row.meta ? { ...info, meta: row.meta } : info;
}

export class TraversalStore {
  private state: StateStore;
  private graphs: Map<string, ValidatedGraph>;
  private maxDepth: number;
  private hookRunner: HookRunner;

  constructor(
    state: StateStore,
    graphs: Map<string, ValidatedGraph>,
    options: { maxDepth?: number; hookRunner: HookRunner },
  ) {
    this.state = state;
    this.graphs = graphs;
    this.maxDepth = options.maxDepth ?? 5;
    this.hookRunner = options.hookRunner;
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

  /**
   * Find traversals whose `meta` tags match every entry in `query`. Matching
   * is exact string equality on both key and value — Freelance treats the
   * tags as opaque. Returns all matches (multiple phases of the same ticket
   * can share an externalKey, for example) sorted by most-recently-updated.
   */
  findTraversalsByMeta(query: Record<string, string>): TraversalFindResult {
    const entries = Object.entries(query);
    if (entries.length === 0) {
      throw new EngineError(
        "findTraversalsByMeta requires at least one key=value pair",
        "INVALID_QUERY",
      );
    }
    const matches = this.state
      .list()
      .filter((row) => {
        const meta = row.meta;
        if (!meta) return false;
        return entries.every(([k, v]) => meta[k] === v);
      })
      .map(recordToInfo);
    return { query: { ...query }, matches };
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
  ): Promise<{ traversalId: string; meta?: Record<string, string> } & StartResult> {
    const id = generateTraversalId();
    const engine = this.newEngine();
    const result = await engine.start(graphId, initialContext);

    const stack = engine.getStack();
    const now = new Date().toISOString();
    const active = stack[stack.length - 1];

    // Keep `meta` absent (vs present-and-empty) when no tags are supplied —
    // callers treat `undefined` as "no external reference" and we want the
    // JSON records to round-trip cleanly.
    const normalizedMeta = meta && Object.keys(meta).length > 0 ? { ...meta } : undefined;

    const record: TraversalRecord = {
      id,
      stack,
      graphId: active.graphId,
      currentNode: active.currentNode,
      stackDepth: stack.length,
      createdAt: now,
      updatedAt: now,
    };
    if (normalizedMeta) record.meta = normalizedMeta;
    this.state.put(record);

    return normalizedMeta
      ? { traversalId: id, meta: normalizedMeta, ...result }
      : { traversalId: id, ...result };
  }

  async advance(
    traversalId: string,
    edge: string,
    contextUpdates?: Record<string, unknown>,
  ): Promise<{ traversalId: string } & AdvanceResult> {
    const { engine, record } = this.loadEngine(traversalId);
    const result = await engine.advance(edge, contextUpdates);
    this.saveEngine(record, engine);
    return { traversalId, ...result };
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

  inspect(
    traversalId: string,
    detail?: "position" | "full" | "history",
  ): { traversalId: string } & InspectResult {
    const { engine } = this.loadEngine(traversalId);
    const result = engine.inspect(detail);
    return { traversalId, ...result };
  }

  /**
   * Look up a traversal by id and return enough state for a caller to pick it
   * back up: current node, valid edges, full context, meta tags. Read-only —
   * doesn't mutate the stored record.
   */
  resumeTraversal(traversalId: string): ResumeResult {
    const { engine, record } = this.loadEngine(traversalId);
    const inspect = engine.inspect("position") as InspectPositionResult;
    // Build as a plain writable object, then return — TypeScript infers the
    // ResumeResult shape at the return site. Keeps optional fields absent
    // (not present-as-undefined) so the JSON output is tight.
    const result: Record<string, unknown> = {
      status: "resumed",
      traversalId: record.id,
      graphId: inspect.graphId,
      graphName: inspect.graphName,
      currentNode: inspect.currentNode,
      node: inspect.node,
      validTransitions: inspect.validTransitions,
      context: inspect.context,
      stackDepth: inspect.stackDepth,
      stack: inspect.stack,
      lastUpdated: record.updatedAt,
    };
    if (record.meta) result.meta = record.meta;
    if (inspect.graphSources) result.graphSources = inspect.graphSources;
    if (inspect.waitStatus) result.waitStatus = inspect.waitStatus;
    if (inspect.waitingOn) result.waitingOn = inspect.waitingOn;
    if (inspect.timeout) result.timeout = inspect.timeout;
    if (inspect.timeoutAt) result.timeoutAt = inspect.timeoutAt;
    return result as unknown as ResumeResult;
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
    throw new EngineError(
      `Multiple active traversals. Specify traversalId. Active: ${records.map((t) => `${t.id} (${t.graphId} @ ${t.currentNode})`).join(", ")}`,
      "AMBIGUOUS_TRAVERSAL",
    );
  }

  // --- Engine load/save ---

  private newEngine(): GraphEngine {
    return new GraphEngine(this.graphs, {
      maxDepth: this.maxDepth,
      hookRunner: this.hookRunner,
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
    // meta is immutable after createTraversal — carry it forward verbatim.
    if (record.meta) next.meta = record.meta;
    this.state.put(next);
  }
}

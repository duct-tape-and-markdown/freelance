/**
 * Stateless traversal orchestrator. Every public operation loads the stack
 * from the backing StateStore, rebuilds a GraphEngine, executes, and writes
 * back. No in-memory engine state survives between calls.
 */

import crypto from "node:crypto";
import type { ContextCaps, InspectHistoryOptions, ResponseMode } from "../engine/context.js";
import type { HookRunner } from "../engine/hooks.js";
import { GraphEngine } from "../engine/index.js";
import { EC, EngineError } from "../errors.js";
import type {
  AdvanceMinimalResult,
  AdvanceResult,
  ContextSetMinimalResult,
  ContextSetResult,
  InspectField,
  InspectMinimalResult,
  InspectResult,
  LoadError,
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
  private readonly loadErrors: readonly LoadError[];
  // Per-id async mutex tails, keyed by traversal id. See `withLock`.
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    state: StateStore,
    graphs: Map<string, ValidatedGraph>,
    options: {
      maxDepth?: number;
      hookRunner: HookRunner;
      contextCaps?: ContextCaps;
      loadErrors?: readonly LoadError[];
    },
  ) {
    this.state = state;
    this.graphs = graphs;
    this.maxDepth = options.maxDepth ?? 5;
    this.hookRunner = options.hookRunner;
    this.contextCaps = options.contextCaps;
    this.loadErrors = options.loadErrors ?? [];
  }

  /**
   * Run `fn` under the per-id lock. Subsequent calls for the same id
   * queue behind the current one. The map entry is cleared when the
   * last waiter settles so an idle id carries no memory cost.
   *
   * The tail-marker stored in `this.locks` is a rejection-swallowing
   * derivative of the result promise — a failure in `fn` doesn't
   * poison subsequent operations on the same id. The rejection still
   * propagates to the immediate caller via the awaited result.
   */
  private async withLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    // Stored tails already swallow rejections, so `prior` always
    // resolves; chaining with a single continuation is enough.
    const prior = this.locks.get(id) ?? Promise.resolve();
    const result = prior.then(fn);
    const tail = result.catch(() => {});
    this.locks.set(id, tail);
    try {
      return await result;
    } finally {
      // Only evict if we're still the tail — another caller may have
      // appended behind us while we awaited.
      if (this.locks.get(id) === tail) {
        this.locks.delete(id);
      }
    }
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

    // Split active vs. orphaned. An orphan is a traversal whose top-of-
    // stack graphId isn't among the currently-loaded graphs — the yaml
    // was deleted/renamed/failed to parse between `start` and this read.
    // `advance`/`inspect` on an orphan fails with GRAPH_NOT_FOUND; the
    // split surfaces them on `status` so the skill can suggest reset.
    const active: TraversalInfo[] = [];
    const orphaned: TraversalInfo[] = [];
    for (const t of this.listTraversals()) {
      (this.graphs.has(t.graphId) ? active : orphaned).push(t);
    }

    return {
      graphs: graphList,
      activeTraversals: active,
      ...(this.loadErrors.length > 0 && { loadErrors: this.loadErrors }),
      ...(orphaned.length > 0 && { orphanedTraversals: orphaned }),
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
          EC.REQUIRED_META_MISSING,
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
    options?: { responseMode?: ResponseMode },
  ): Promise<
    { traversalId: string; meta: Record<string, string> } & (AdvanceResult | AdvanceMinimalResult)
  > {
    // advance() is the only traversal-mutating path that awaits (hooks
    // run mid-call), so two concurrent invocations on the same id can
    // interleave their load → mutate → save sequences within one
    // process. The mutex gives them clean sequential semantics; the
    // sync methods (contextSet/setMeta) can't interleave within a
    // process and rely on putIfVersion alone for cross-process races.
    return this.withLock(traversalId, async () => {
      const { engine, record } = this.loadEngine(traversalId);
      const hookMeta: Record<string, string> = {};
      const metaCollector = (updates: Record<string, string>) => Object.assign(hookMeta, updates);

      // Phase 1: transition + gate checks. On a gate-block ("early"),
      // session state is already final and runArrivalHooks is a
      // pass-through. On a committed transition, currentNode has
      // moved; we save THAT state before hooks run so a hook throw
      // leaves disk on the new node, not the stale pre-advance one.
      // See docs/decisions.md § "Observable state transitions are
      // durable before side effects".
      const commit = engine.advanceTransition(edge, contextUpdates, {
        ...(options?.responseMode ? { responseMode: options.responseMode } : {}),
      });
      this.saveEngine(record, engine);

      // Phase 2: onEnter hooks + response construction. persistBetween
      // is only consumed by the subgraph-push branch: maybePushSubgraph
      // pushes the child, invokes it (so disk reflects the push), then
      // fires child-start hooks. Standard-arrival runArrivalHooks
      // ignores the callback — the pre-hook save above is the boundary
      // for that branch.
      const persistBetween = () => this.saveEngine(record, engine);
      let result: AdvanceResult | AdvanceMinimalResult;
      try {
        result = await engine.runArrivalHooks(commit, { metaCollector, persistBetween });
      } catch (e) {
        // Post-transition hook throw. Attach the envelope-sibling
        // snapshot (currentNode, validTransitions, context / contextDelta)
        // so the CLI surfaces the same recover-or-stop fields as a
        // gate-block response — HOOK_FAILED callers are in the same
        // state. The hook attribution on `context.hook` is already set
        // by the hook runner.
        if (e instanceof EngineError) {
          const minimal = options?.responseMode === "minimal";
          const writesBefore =
            commit.kind === "standard" || commit.kind === "subgraph-push"
              ? commit.writesBefore
              : undefined;
          const extras = engine.captureHookFailureEnvelope({
            minimal,
            ...(writesBefore !== undefined && { writesBefore }),
          });
          if (extras) {
            e.context = { ...e.context, envelopeSlots: extras };
          }
        }
        throw e;
      }

      // Merge collected hook updates into the in-memory record before
      // the final save.
      if (Object.keys(hookMeta).length > 0) {
        record.meta = { ...record.meta, ...hookMeta };
      }
      this.saveEngine(record, engine);
      return { traversalId, meta: record.meta ?? EMPTY_META, ...result };
    });
  }

  contextSet(
    traversalId: string,
    updates: Record<string, unknown>,
    options?: { responseMode?: ResponseMode },
  ): { traversalId: string } & (ContextSetResult | ContextSetMinimalResult) {
    const { engine, record } = this.loadEngine(traversalId);
    const result = engine.contextSet(
      updates,
      options?.responseMode ? { responseMode: options.responseMode } : undefined,
    );
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
      throw new EngineError("setMeta requires at least one key=value pair", EC.INVALID_META);
    }
    const record = this.state.get(traversalId);
    if (!record) {
      throw new EngineError(`Traversal "${traversalId}" not found`, EC.TRAVERSAL_NOT_FOUND);
    }
    const meta = { ...record.meta, ...updates };
    this.state.putIfVersion(
      { ...record, meta, updatedAt: new Date().toISOString() },
      record.version ?? 0,
    );
    return { traversalId, meta };
  }

  inspect(
    traversalId: string,
    detail?: "position" | "history",
    fields?: readonly InspectField[],
    historyOpts?: InspectHistoryOptions,
    options?: { responseMode?: ResponseMode },
  ): { traversalId: string; meta: Record<string, string> } & (
    | InspectResult
    | InspectMinimalResult
  ) {
    const { engine, record } = this.loadEngine(traversalId);
    const result = engine.inspect(
      detail,
      fields,
      historyOpts,
      options?.responseMode ? { responseMode: options.responseMode } : undefined,
    );
    return { traversalId, meta: record.meta ?? EMPTY_META, ...result };
  }

  resetTraversal(traversalId: string): { traversalId: string } & ResetResult {
    // Reset is the documented recovery path for orphaned traversals
    // (loadEngine's error message points here), so it must succeed even
    // when the graph isn't loaded. We open-code the record fetch rather
    // than going through loadEngine, which would throw GRAPH_NOT_FOUND
    // and make orphan recovery unreachable. Engine hydration isn't
    // needed — reset() only reads the stored stack to build its
    // ResetResult.
    const record = this.state.get(traversalId);
    if (!record) {
      throw new EngineError(`Traversal "${traversalId}" not found`, EC.TRAVERSAL_NOT_FOUND);
    }

    if (!this.graphs.has(record.graphId)) {
      this.state.delete(traversalId);
      const root = record.stack[0];
      const clearedStack = record.stack.map((s) => ({
        graphId: s.graphId,
        node: s.currentNode,
      }));
      return {
        traversalId,
        status: "reset",
        previousGraph: root?.graphId ?? null,
        previousNode: root?.currentNode ?? null,
        message: `Cleared orphaned traversal (graph "${record.graphId}" was not loaded).`,
        ...(clearedStack.length > 1 && { clearedStack }),
      };
    }

    const engine = this.newEngine();
    engine.restoreStack(record.stack);
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
      throw new EngineError("No active traversals. Call freelance_start first.", EC.NO_TRAVERSAL);
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
      EC.AMBIGUOUS_TRAVERSAL,
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
      throw new EngineError(`Traversal "${traversalId}" not found`, EC.TRAVERSAL_NOT_FOUND);
    }

    // Orphan check — the traversal record exists but its graph doesn't
    // resolve. Throw TRAVERSAL_ORPHANED so the catalog's recoveryVerb
    // (`reset {traversalId} --confirm`) renders to a runnable command;
    // the start-typo case stays on GRAPH_NOT_FOUND (verb: null) because
    // there's no stale state to clear there.
    if (!this.graphs.has(record.graphId)) {
      throw new EngineError(
        `Graph "${record.graphId}" not found. Traversal "${traversalId}" is orphaned — ` +
          `its workflow yaml is missing, renamed, or failed to parse.`,
        EC.TRAVERSAL_ORPHANED,
        { envelopeSlots: { traversalId } },
      );
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
    // `record.version` is what we observed at loadEngine() time —
    // putIfVersion throws TRAVERSAL_CONFLICT if another writer bumped
    // the version meanwhile. `version ?? 0` handles legacy records
    // written before the field existed. Track the bumped version in
    // place so repeat saveEngine calls within one advance (the
    // log-then-apply bracket around hook execution) don't trip
    // conflict on themselves.
    const written = this.state.putIfVersion(next, record.version ?? 0);
    record.version = written.version;
  }
}

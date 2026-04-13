/**
 * Stateless traversal orchestrator. Every public operation loads the stack
 * from the backing StateStore, rebuilds a GraphEngine, executes, and writes
 * back. No in-memory engine state survives between calls.
 */

import crypto from "node:crypto";
import { GraphEngine } from "../engine/index.js";
import type { OpContext, OpsRegistry } from "../engine/operations.js";
import { EngineError } from "../errors.js";
import type {
  AdvanceResult,
  ContextSetResult,
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

export interface TraversalStoreOptions {
  maxDepth?: number;
  /**
   * Ops registry passed through to every GraphEngine instance constructed
   * for load/create/advance operations. Required for any workflow that
   * contains programmatic nodes; graphs without them work without one.
   */
  opsRegistry?: OpsRegistry;
  /**
   * Host capabilities passed alongside opsRegistry to op handlers during
   * programmatic drain. Must be provided whenever opsRegistry is provided
   * (the drain loop refuses to run ops without both).
   */
  opContext?: OpContext;
}

export class TraversalStore {
  private state: StateStore;
  private graphs: Map<string, ValidatedGraph>;
  private maxDepth: number;
  private opsRegistry?: OpsRegistry;
  private opContext?: OpContext;

  constructor(
    state: StateStore,
    graphs: Map<string, ValidatedGraph>,
    options?: TraversalStoreOptions,
  ) {
    this.state = state;
    this.graphs = graphs;
    this.maxDepth = options?.maxDepth ?? 5;
    this.opsRegistry = options?.opsRegistry;
    this.opContext = options?.opContext;
  }

  private makeEngine(): GraphEngine {
    return new GraphEngine(this.graphs, {
      maxDepth: this.maxDepth,
      opsRegistry: this.opsRegistry,
      opContext: this.opContext,
    });
  }

  close(): void {
    this.state.close();
  }

  updateGraphs(newGraphs: Map<string, ValidatedGraph>): void {
    this.graphs = newGraphs;
  }

  // --- Read operations ---

  listGraphs(): TraversalListResult {
    const graphList = [];
    for (const [id, vg] of this.graphs) {
      graphList.push({
        id,
        name: vg.definition.name,
        version: vg.definition.version,
        description: vg.definition.description ?? "",
      });
    }
    return {
      graphs: graphList,
      activeTraversals: this.listTraversals(),
    };
  }

  listTraversals(): TraversalInfo[] {
    return this.state.list().map((row) => ({
      traversalId: row.id,
      graphId: row.graphId,
      currentNode: row.currentNode,
      lastUpdated: row.updatedAt,
      stackDepth: row.stackDepth,
    }));
  }

  /** Check whether any active traversal belongs to one of the given graph IDs. */
  hasActiveTraversalForGraph(...graphIds: string[]): boolean {
    if (graphIds.length === 0) return false;
    const targets = new Set(graphIds);
    return this.state.list().some((r) => targets.has(r.graphId));
  }

  // --- Traversal operations ---

  createTraversal(
    graphId: string,
    initialContext?: Record<string, unknown>,
  ): { traversalId: string } & StartResult {
    const id = generateTraversalId();
    const engine = this.makeEngine();
    const result = engine.start(graphId, initialContext);

    const stack = engine.getStack();
    const now = new Date().toISOString();
    const active = stack[stack.length - 1];

    this.state.put({
      id,
      stack,
      graphId: active.graphId,
      currentNode: active.currentNode,
      stackDepth: stack.length,
      createdAt: now,
      updatedAt: now,
    });

    return { traversalId: id, ...result };
  }

  advance(
    traversalId: string,
    edge: string,
    contextUpdates?: Record<string, unknown>,
  ): { traversalId: string } & AdvanceResult {
    const { engine, record } = this.loadEngine(traversalId);
    const result = engine.advance(edge, contextUpdates);
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

  private loadEngine(traversalId: string): { engine: GraphEngine; record: TraversalRecord } {
    const record = this.state.get(traversalId);
    if (!record) {
      throw new EngineError(`Traversal "${traversalId}" not found`, "TRAVERSAL_NOT_FOUND");
    }

    const engine = this.makeEngine();
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
    this.state.put({
      id: record.id,
      stack,
      graphId: active.graphId,
      currentNode: active.currentNode,
      stackDepth: stack.length,
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }
}

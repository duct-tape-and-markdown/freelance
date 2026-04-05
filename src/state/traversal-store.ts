/**
 * Stateless traversal store backed by SQLite.
 *
 * Every operation loads the traversal stack from the database,
 * rebuilds a GraphEngine, executes, and persists back.
 * No in-memory state survives between calls.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { GraphEngine } from "../engine/index.js";
import { EngineError } from "../errors.js";
import type {
  ValidatedGraph,
  StartResult,
  AdvanceResult,
  ContextSetResult,
  InspectResult,
  ResetResult,
  TraversalInfo,
  TraversalListResult,
  SessionState,
} from "../types.js";

function generateTraversalId(): string {
  return "tr_" + crypto.randomBytes(4).toString("hex");
}

interface TraversalRow {
  id: string;
  stack: string; // JSON
  graph_id: string;
  current_node: string;
  stack_depth: number;
  created_at: string;
  updated_at: string;
}

/**
 * Snapshot graph definitions so in-flight traversals are pinned to the
 * definitions they were created with.
 */
function snapshotGraphs(
  graphs: Map<string, ValidatedGraph>
): Map<string, ValidatedGraph> {
  const snapshot = new Map<string, ValidatedGraph>();
  for (const [id, vg] of graphs) {
    snapshot.set(id, {
      definition: structuredClone(vg.definition),
      graph: vg.graph,
    });
  }
  return snapshot;
}

export class TraversalStore {
  private db: Database.Database;
  private graphs: Map<string, ValidatedGraph>;
  private maxDepth: number;

  constructor(
    db: Database.Database,
    graphs: Map<string, ValidatedGraph>,
    options?: { maxDepth?: number }
  ) {
    this.db = db;
    this.graphs = graphs;
    this.maxDepth = options?.maxDepth ?? 5;
  }

  close(): void {
    this.db.close();
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
    const rows = this.db.prepare(
      "SELECT id, graph_id, current_node, updated_at, stack_depth FROM traversals ORDER BY updated_at DESC"
    ).all() as TraversalRow[];

    return rows.map((row) => ({
      traversalId: row.id,
      graphId: row.graph_id,
      currentNode: row.current_node,
      lastUpdated: row.updated_at,
      stackDepth: row.stack_depth,
    }));
  }

  // --- Traversal operations ---

  createTraversal(
    graphId: string,
    initialContext?: Record<string, unknown>
  ): { traversalId: string } & StartResult {
    const id = generateTraversalId();
    const snapshot = snapshotGraphs(this.graphs);
    const engine = new GraphEngine(snapshot, { maxDepth: this.maxDepth });
    const result = engine.start(graphId, initialContext);

    const stack = engine.getStack();
    const now = new Date().toISOString();
    const active = stack[stack.length - 1];

    this.db.prepare(
      `INSERT INTO traversals (id, stack, graph_id, current_node, stack_depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, JSON.stringify(stack), active.graphId, active.currentNode, stack.length, now, now);

    return { traversalId: id, ...result };
  }

  advance(
    traversalId: string,
    edge: string,
    contextUpdates?: Record<string, unknown>
  ): { traversalId: string } & AdvanceResult {
    const engine = this.loadEngine(traversalId);
    const result = engine.advance(edge, contextUpdates);
    this.saveEngine(traversalId, engine);
    return { traversalId, ...result };
  }

  contextSet(
    traversalId: string,
    updates: Record<string, unknown>
  ): { traversalId: string } & ContextSetResult {
    const engine = this.loadEngine(traversalId);
    const result = engine.contextSet(updates);
    this.saveEngine(traversalId, engine);
    return { traversalId, ...result };
  }

  inspect(
    traversalId: string,
    detail?: "position" | "full" | "history"
  ): { traversalId: string } & InspectResult {
    const engine = this.loadEngine(traversalId);
    const result = engine.inspect(detail);
    return { traversalId, ...result };
  }

  resetTraversal(traversalId: string): { traversalId: string } & ResetResult {
    const engine = this.loadEngine(traversalId);
    const result = engine.reset();
    this.db.prepare("DELETE FROM traversals WHERE id = ?").run(traversalId);
    return { traversalId, ...result };
  }

  resolveTraversalId(traversalId?: string): string {
    if (traversalId) {
      const exists = this.db.prepare(
        "SELECT id FROM traversals WHERE id = ?"
      ).get(traversalId) as { id: string } | undefined;
      if (!exists) {
        throw new EngineError(
          `Traversal "${traversalId}" not found`,
          "TRAVERSAL_NOT_FOUND"
        );
      }
      return traversalId;
    }

    const rows = this.db.prepare(
      "SELECT id, graph_id, current_node FROM traversals"
    ).all() as TraversalRow[];

    if (rows.length === 0) {
      throw new EngineError(
        "No active traversals. Call freelance_start first.",
        "NO_TRAVERSAL"
      );
    }
    if (rows.length === 1) {
      return rows[0].id;
    }
    throw new EngineError(
      `Multiple active traversals. Specify traversalId. Active: ${rows.map((t) => `${t.id} (${t.graph_id} @ ${t.current_node})`).join(", ")}`,
      "AMBIGUOUS_TRAVERSAL"
    );
  }

  // --- Engine load/save ---

  private loadEngine(traversalId: string): GraphEngine {
    const row = this.db.prepare(
      "SELECT stack FROM traversals WHERE id = ?"
    ).get(traversalId) as { stack: string } | undefined;

    if (!row) {
      throw new EngineError(
        `Traversal "${traversalId}" not found`,
        "TRAVERSAL_NOT_FOUND"
      );
    }

    const stack: SessionState[] = JSON.parse(row.stack);
    const snapshot = snapshotGraphs(this.graphs);
    const engine = new GraphEngine(snapshot, { maxDepth: this.maxDepth });
    engine.restoreStack(stack);
    return engine;
  }

  private saveEngine(traversalId: string, engine: GraphEngine): void {
    const stack = engine.getStack();

    if (stack.length === 0) {
      // Engine was reset or completed — remove from DB
      this.db.prepare("DELETE FROM traversals WHERE id = ?").run(traversalId);
      return;
    }

    const active = stack[stack.length - 1];
    this.db.prepare(
      `UPDATE traversals SET stack = ?, graph_id = ?, current_node = ?, stack_depth = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(stack),
      active.graphId,
      active.currentNode,
      stack.length,
      new Date().toISOString(),
      traversalId
    );
  }
}

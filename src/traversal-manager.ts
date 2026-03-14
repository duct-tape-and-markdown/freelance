import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GraphEngine } from "./engine/index.js";
import { EngineError } from "./errors.js";
import type {
  ValidatedGraph,
  StartResult,
  AdvanceResult,
  ContextSetResult,
  InspectResult,
  ResetResult,
  TraversalInfo,
  TraversalListResult,
  SerializedTraversal,
} from "./types.js";

function generateTraversalId(): string {
  return "tr_" + crypto.randomBytes(4).toString("hex");
}

export class TraversalManager {
  private traversals = new Map<string, GraphEngine>();
  private metadata = new Map<string, { createdAt: string; lastUpdated: string }>();
  private persistDir: string | null;

  constructor(
    private graphs: Map<string, ValidatedGraph>,
    private options: { maxDepth?: number; persistDir?: string } = {}
  ) {
    this.persistDir = options.persistDir ?? null;
    if (this.persistDir) {
      fs.mkdirSync(this.persistDir, { recursive: true });
      this.restoreAll();
    }
  }

  listGraphs(): TraversalListResult {
    const engine = new GraphEngine(this.graphs, this.options);
    const { graphs } = engine.list();
    return {
      graphs,
      activeTraversals: this.listTraversals(),
    };
  }

  listTraversals(): TraversalInfo[] {
    const result: TraversalInfo[] = [];
    for (const [id, engine] of this.traversals) {
      const meta = this.metadata.get(id)!;
      const stack = engine.getStack();
      if (stack.length === 0) continue;
      const active = stack[stack.length - 1];
      result.push({
        traversalId: id,
        graphId: active.graphId,
        currentNode: active.currentNode,
        lastUpdated: meta.lastUpdated,
        stackDepth: stack.length,
      });
    }
    return result;
  }

  createTraversal(
    graphId: string,
    initialContext?: Record<string, unknown>
  ): { traversalId: string } & StartResult {
    const id = generateTraversalId();
    const engine = new GraphEngine(this.graphs, this.options);
    const result = engine.start(graphId, initialContext);
    const now = new Date().toISOString();
    this.traversals.set(id, engine);
    this.metadata.set(id, { createdAt: now, lastUpdated: now });
    this.persist(id);
    return { traversalId: id, ...result };
  }

  advance(
    traversalId: string,
    edge: string,
    contextUpdates?: Record<string, unknown>
  ): { traversalId: string } & AdvanceResult {
    const engine = this.requireTraversal(traversalId);
    const result = engine.advance(edge, contextUpdates);
    this.touch(traversalId);
    this.persist(traversalId);
    return { traversalId, ...result };
  }

  contextSet(
    traversalId: string,
    updates: Record<string, unknown>
  ): { traversalId: string } & ContextSetResult {
    const engine = this.requireTraversal(traversalId);
    const result = engine.contextSet(updates);
    this.touch(traversalId);
    this.persist(traversalId);
    return { traversalId, ...result };
  }

  inspect(
    traversalId: string,
    detail?: "position" | "full" | "history"
  ): { traversalId: string } & InspectResult {
    const engine = this.requireTraversal(traversalId);
    const result = engine.inspect(detail);
    return { traversalId, ...result };
  }

  resetTraversal(traversalId: string): { traversalId: string } & ResetResult {
    const engine = this.requireTraversal(traversalId);
    const result = engine.reset();
    this.traversals.delete(traversalId);
    this.metadata.delete(traversalId);
    this.deletePersisted(traversalId);
    return { traversalId, ...result };
  }

  resolveTraversalId(traversalId?: string): string {
    if (traversalId) {
      if (!this.traversals.has(traversalId)) {
        throw new EngineError(
          `Traversal "${traversalId}" not found`,
          "TRAVERSAL_NOT_FOUND"
        );
      }
      return traversalId;
    }

    const active = this.listTraversals();
    if (active.length === 0) {
      throw new EngineError(
        "No active traversals. Call graph_start first.",
        "NO_TRAVERSAL"
      );
    }
    if (active.length === 1) {
      return active[0].traversalId;
    }
    throw new EngineError(
      `Multiple active traversals. Specify traversalId. Active: ${active.map((t) => `${t.traversalId} (${t.graphId} @ ${t.currentNode})`).join(", ")}`,
      "AMBIGUOUS_TRAVERSAL"
    );
  }

  // --- Persistence ---

  private touch(traversalId: string): void {
    this.metadata.get(traversalId)!.lastUpdated = new Date().toISOString();
  }

  private persist(traversalId: string): void {
    if (!this.persistDir) return;
    const engine = this.traversals.get(traversalId)!;
    const meta = this.metadata.get(traversalId)!;

    const data: SerializedTraversal = {
      traversalId,
      stack: engine.getStack(),
      createdAt: meta.createdAt,
      lastUpdated: meta.lastUpdated,
    };

    const filePath = path.join(this.persistDir, `${traversalId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  private deletePersisted(traversalId: string): void {
    if (!this.persistDir) return;
    const filePath = path.join(this.persistDir, `${traversalId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private restoreAll(): void {
    if (!this.persistDir) return;

    const files = fs.readdirSync(this.persistDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const filePath = path.join(this.persistDir, file);
        const raw = fs.readFileSync(filePath, "utf-8");
        const data: SerializedTraversal = JSON.parse(raw);

        if (!data.traversalId || !data.stack || data.stack.length === 0) {
          continue;
        }

        const engine = new GraphEngine(this.graphs, this.options);
        engine.restoreStack(data.stack);
        this.traversals.set(data.traversalId, engine);
        this.metadata.set(data.traversalId, {
          createdAt: data.createdAt,
          lastUpdated: data.lastUpdated,
        });
      } catch {
        // Skip corrupted files
      }
    }
  }

  private requireTraversal(traversalId: string): GraphEngine {
    const engine = this.traversals.get(traversalId);
    if (!engine) {
      throw new EngineError(
        `Traversal "${traversalId}" not found`,
        "TRAVERSAL_NOT_FOUND"
      );
    }
    return engine;
  }
}

/**
 * TraversalStore plumbing tests for programmatic nodes.
 *
 * Verifies that opsRegistry + opContext passed to TraversalStore's
 * constructor reach the GraphEngine instances created by
 * createTraversal() and loadEngine(), and that a programmatic drain
 * survives the stateless load/save cycle the store enforces on each
 * operation.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestOpsRegistry, type OpHandler } from "../src/engine/operations.js";
import { buildAndValidateGraph } from "../src/graph-construction.js";
import { openStateStore, TraversalStore } from "../src/state/index.js";
import type { GraphDefinition, ValidatedGraph } from "../src/types.js";

function buildGraphs(def: GraphDefinition): Map<string, ValidatedGraph> {
  const graph = buildAndValidateGraph(def, "<test>");
  return new Map([[def.id, { definition: def, graph }]]);
}

function store(def: GraphDefinition, handlers: Record<string, OpHandler> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-prog-"));
  const state = openStateStore(path.join(tmpDir, "traversals"));
  return new TraversalStore(state, buildGraphs(def), {
    opsRegistry: createTestOpsRegistry({
      set_value: (args) => ({ value: args.value }),
      noop: () => ({}),
      ...handlers,
    }),
    opContext: { memoryStore: {} as never },
  });
}

describe("TraversalStore + programmatic nodes", () => {
  const simpleChainGraph: GraphDefinition = {
    id: "ts-prog-chain",
    version: "1.0.0",
    name: "TS Prog Chain",
    description: "test",
    startNode: "prep",
    strictContext: false,
    nodes: {
      prep: {
        type: "programmatic",
        description: "pre-populate",
        operation: { name: "set_value", args: { value: "prepared" } },
        contextUpdates: { data: "value" },
        edges: [{ label: "ready", target: "work" }],
      },
      work: {
        type: "action",
        description: "agent work",
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "terminal", description: "done" },
    },
  };

  it("drains a programmatic start node via createTraversal", () => {
    const ts = store(simpleChainGraph);
    const result = ts.createTraversal("ts-prog-chain");
    expect(result.status).toBe("started");
    expect(result.currentNode).toBe("work");
    expect(result.context.data).toBe("prepared");
    expect(result.traversalId).toMatch(/^tr_/);
  });

  it("drains a mid-traversal programmatic chain on advance", () => {
    const graph: GraphDefinition = {
      id: "ts-mid",
      version: "1.0.0",
      name: "Mid",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: {
          type: "action",
          description: "agent",
          edges: [{ label: "go", target: "prep" }],
        },
        prep: {
          type: "programmatic",
          description: "prep",
          operation: { name: "set_value", args: { value: "mid" } },
          contextUpdates: { data: "value" },
          edges: [{ label: "ready", target: "work" }],
        },
        work: {
          type: "action",
          description: "work",
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    };
    const ts = store(graph);
    const start = ts.createTraversal("ts-mid");
    expect(start.currentNode).toBe("a");
    const result = ts.advance(start.traversalId, "go");
    if (result.isError) throw new Error("unexpected error");
    expect(result.currentNode).toBe("work");
    expect(result.context.data).toBe("mid");
  });

  it("survives load/save cycle — history preserves programmatic entries", () => {
    const ts = store(simpleChainGraph);
    const start = ts.createTraversal("ts-prog-chain");
    const history = ts.inspect(start.traversalId, "history");
    if (!("traversalHistory" in history)) throw new Error("expected history result");
    expect(history.traversalHistory).toHaveLength(1);
    expect(history.traversalHistory[0]).toMatchObject({
      node: "prep",
      edge: "ready",
      operation: { name: "set_value" },
    });
  });

  it("programmatic state persists across multiple advance calls", () => {
    const graph: GraphDefinition = {
      id: "ts-multi",
      version: "1.0.0",
      name: "Multi",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: {
          type: "action",
          description: "1",
          edges: [{ label: "g1", target: "p1" }],
        },
        p1: {
          type: "programmatic",
          description: "p1",
          operation: { name: "set_value", args: { value: "first" } },
          contextUpdates: { v1: "value" },
          edges: [{ label: "next", target: "b" }],
        },
        b: {
          type: "action",
          description: "2",
          edges: [{ label: "g2", target: "p2" }],
        },
        p2: {
          type: "programmatic",
          description: "p2",
          operation: { name: "set_value", args: { value: "second" } },
          contextUpdates: { v2: "value" },
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    };
    const ts = store(graph);
    const s = ts.createTraversal("ts-multi");
    expect(s.currentNode).toBe("a");
    const r1 = ts.advance(s.traversalId, "g1");
    if (r1.isError) throw new Error("unexpected error");
    expect(r1.currentNode).toBe("b");
    expect(r1.context.v1).toBe("first");
    const r2 = ts.advance(s.traversalId, "g2");
    if (r2.isError) throw new Error("unexpected error");
    expect(r2.status).toBe("complete");
    expect(r2.context.v1).toBe("first");
    expect(r2.context.v2).toBe("second");
  });

  it("throws at createTraversal when no registry is configured but a programmatic node exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-prog-"));
    const state = openStateStore(path.join(tmpDir, "traversals"));
    // No opsRegistry/opContext on the store
    const ts = new TraversalStore(state, buildGraphs(simpleChainGraph));
    expect(() => ts.createTraversal("ts-prog-chain")).toThrow(/no ops registry/);
  });
});

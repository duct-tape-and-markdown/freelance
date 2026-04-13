import { describe, expect, it } from "vitest";
import { toNodeInfo } from "../src/engine/helpers.js";
import { GraphEngine } from "../src/engine/index.js";
import { createTestOpsRegistry } from "../src/engine/operations.js";
import type { NodeDefinition } from "../src/types.js";
import { buildSingleGraphMap } from "./helpers.js";

describe("toNodeInfo — programmatic node rendering", () => {
  it("exposes operation and contextUpdates for a programmatic node", () => {
    const node: NodeDefinition = {
      type: "programmatic",
      description: "fetch status",
      operation: {
        name: "memory_browse",
        args: { collection: "context.collection", limit: 50 },
      },
      contextUpdates: { manifest: "entities", total: "total" },
      edges: [{ label: "ready", target: "next" }],
    };
    const info = toNodeInfo(node);
    expect(info.type).toBe("programmatic");
    expect(info.operation).toEqual({
      name: "memory_browse",
      args: { collection: "context.collection", limit: 50 },
    });
    expect(info.contextUpdates).toEqual({ manifest: "entities", total: "total" });
  });

  it("leaves operation and contextUpdates undefined on non-programmatic nodes", () => {
    const action: NodeDefinition = {
      type: "action",
      description: "plain action",
      edges: [{ label: "go", target: "end" }],
    };
    const info = toNodeInfo(action);
    expect(info.operation).toBeUndefined();
    expect(info.contextUpdates).toBeUndefined();
  });

  it("serializes operation.args as-is (no normalization)", () => {
    const node: NodeDefinition = {
      type: "programmatic",
      description: "literal args",
      operation: {
        name: "test_op",
        args: { str: "literal", num: 42, bool: true, arr: [1, 2], obj: { k: "v" } },
      },
      edges: [{ label: "done", target: "end" }],
    };
    const info = toNodeInfo(node);
    expect(info.operation?.args).toEqual({
      str: "literal",
      num: 42,
      bool: true,
      arr: [1, 2],
      obj: { k: "v" },
    });
  });
});

describe("inspect --detail history — programmatic hop metadata", () => {
  it("surfaces HistoryEntry.operation.appliedUpdates through the full pipeline", () => {
    const graphs = buildSingleGraphMap({
      id: "insp-hist",
      version: "1.0.0",
      name: "Inspect History",
      description: "test",
      startNode: "prep",
      strictContext: false,
      nodes: {
        prep: {
          type: "programmatic",
          description: "fetch",
          operation: { name: "set_value", args: { value: "ready" } },
          contextUpdates: { status: "value" },
          edges: [{ label: "done", target: "work" }],
        },
        work: {
          type: "action",
          description: "agent work",
          edges: [{ label: "finish", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: createTestOpsRegistry({ set_value: (args) => ({ value: args.value }) }),
      opContext: { memoryStore: {} as never },
    });
    engine.start("insp-hist");
    const inspect = engine.inspect("history");
    if (!("traversalHistory" in inspect)) throw new Error("expected history result");
    expect(inspect.traversalHistory).toHaveLength(1);
    const entry = inspect.traversalHistory[0];
    expect(entry.node).toBe("prep");
    expect(entry.edge).toBe("done");
    expect(entry.operation?.name).toBe("set_value");
    expect(entry.operation?.appliedUpdates).toEqual({ status: "ready" });
  });

  it("history omits operation field for agent-driven hops", () => {
    const graphs = buildSingleGraphMap({
      id: "insp-agent",
      version: "1.0.0",
      name: "Agent Hop",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: { type: "action", description: "a", edges: [{ label: "go", target: "b" }] },
        b: { type: "terminal", description: "b" },
      },
    });
    const engine = new GraphEngine(graphs);
    engine.start("insp-agent");
    engine.advance("go");
    const inspect = engine.inspect("history");
    if (!("traversalHistory" in inspect)) throw new Error("expected history result");
    expect(inspect.traversalHistory[0].operation).toBeUndefined();
  });
});

describe("inspect --detail full — programmatic node in definition", () => {
  it("round-trips programmatic node schema fields through inspect full", () => {
    const graphs = buildSingleGraphMap({
      id: "insp-full",
      version: "1.0.0",
      name: "Full",
      description: "test",
      startNode: "prep",
      strictContext: false,
      nodes: {
        prep: {
          type: "programmatic",
          description: "x",
          operation: { name: "noop" },
          contextUpdates: { k: "v" },
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: createTestOpsRegistry({ noop: () => ({ v: 1 }) }),
      opContext: { memoryStore: {} as never },
    });
    engine.start("insp-full");
    const inspect = engine.inspect("full");
    if (!("definition" in inspect)) throw new Error("expected full result");
    const prepNode = inspect.definition.nodes.prep;
    expect(prepNode.type).toBe("programmatic");
    expect(prepNode.operation).toEqual({ name: "noop" });
    expect(prepNode.contextUpdates).toEqual({ k: "v" });
  });
});

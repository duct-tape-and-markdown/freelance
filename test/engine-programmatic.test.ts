import { describe, expect, it } from "vitest";
import { GraphEngine } from "../src/engine/index.js";
import { createTestOpsRegistry, type OpHandler } from "../src/engine/operations.js";
import { buildSingleGraphMap } from "./helpers.js";

function testOps(handlers: Record<string, OpHandler> = {}) {
  return createTestOpsRegistry({
    set_value: (args) => ({ value: args.value }),
    set_flag: () => ({ flag: true }),
    ...handlers,
  });
}

describe("GraphEngine + programmatic nodes — start()", () => {
  it("drains a programmatic chain from the start node", () => {
    const graphs = buildSingleGraphMap({
      id: "start-drain",
      version: "1.0.0",
      name: "Start Drain",
      description: "test",
      startNode: "prep",
      strictContext: false,
      nodes: {
        prep: {
          type: "programmatic",
          description: "pre-populate manifest",
          operation: { name: "set_value", args: { value: "manifest-data" } },
          contextUpdates: { manifest: "value" },
          edges: [{ label: "ready", target: "work" }],
        },
        work: {
          type: "action",
          description: "agent work",
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    const result = engine.start("start-drain");
    expect(result.currentNode).toBe("work");
    expect(result.node.type).toBe("action");
    expect(result.context.manifest).toBe("manifest-data");
  });

  it("chains multiple programmatic nodes from start", () => {
    const graphs = buildSingleGraphMap({
      id: "multi-start",
      version: "1.0.0",
      name: "Multi",
      description: "test",
      startNode: "step1",
      strictContext: false,
      nodes: {
        step1: {
          type: "programmatic",
          description: "first",
          operation: { name: "set_value", args: { value: 1 } },
          contextUpdates: { a: "value" },
          edges: [{ label: "next", target: "step2" }],
        },
        step2: {
          type: "programmatic",
          description: "second",
          operation: { name: "set_value", args: { value: 2 } },
          contextUpdates: { b: "value" },
          edges: [{ label: "next", target: "landing" }],
        },
        landing: {
          type: "action",
          description: "agent lands here",
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    const result = engine.start("multi-start");
    expect(result.currentNode).toBe("landing");
    expect(result.context).toMatchObject({ a: 1, b: 2 });
  });

  it("start() works unchanged for graphs without programmatic nodes", () => {
    const graphs = buildSingleGraphMap({
      id: "no-programmatic",
      version: "1.0.0",
      name: "Plain",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: { type: "action", description: "a", edges: [{ label: "go", target: "b" }] },
        b: { type: "terminal", description: "b" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    const result = engine.start("no-programmatic");
    expect(result.currentNode).toBe("a");
  });
});

describe("GraphEngine + programmatic nodes — advance()", () => {
  function setupChainGraph() {
    return buildSingleGraphMap({
      id: "chain",
      version: "1.0.0",
      name: "Chain",
      description: "test",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action",
          description: "agent kicks off",
          edges: [{ label: "go", target: "prep" }],
        },
        prep: {
          type: "programmatic",
          description: "prep data",
          operation: { name: "set_value", args: { value: "prepared" } },
          contextUpdates: { data: "value" },
          edges: [{ label: "ready", target: "analyze" }],
        },
        analyze: {
          type: "programmatic",
          description: "analyze",
          operation: { name: "set_flag" },
          contextUpdates: { ready: "flag" },
          edges: [{ label: "done", target: "agent-work" }],
        },
        "agent-work": {
          type: "action",
          description: "agent sees this",
          edges: [{ label: "finish", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
  }

  it("drains a chain after the agent's edge choice", () => {
    const engine = new GraphEngine(setupChainGraph(), {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("chain");
    const result = engine.advance("go");
    expect(result.status).toBe("advanced");
    if (result.isError) throw new Error("unexpected error");
    expect(result.currentNode).toBe("agent-work");
    expect(result.previousNode).toBe("start");
    expect(result.edgeTaken).toBe("go");
    expect(result.context).toMatchObject({ data: "prepared", ready: true });
  });

  it("records every programmatic hop in history", () => {
    const engine = new GraphEngine(setupChainGraph(), {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("chain");
    engine.advance("go");
    const inspect = engine.inspect("history");
    if (!("traversalHistory" in inspect)) throw new Error("expected history result");
    const nodes = inspect.traversalHistory.map((h) => h.node);
    expect(nodes).toEqual(["start", "prep", "analyze"]);
    // First entry is the agent-driven hop (no operation field).
    expect(inspect.traversalHistory[0].operation).toBeUndefined();
    // Subsequent entries are programmatic hops.
    expect(inspect.traversalHistory[1].operation).toMatchObject({
      name: "set_value",
      appliedUpdates: { data: "prepared" },
    });
    expect(inspect.traversalHistory[2].operation).toMatchObject({
      name: "set_flag",
      appliedUpdates: { ready: true },
    });
  });

  it("agent update before programmatic chain is visible to op args", () => {
    const graphs = buildSingleGraphMap({
      id: "agent-into-prog",
      version: "1.0.0",
      name: "Agent → Programmatic",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: {
          type: "action",
          description: "agent sets collection",
          edges: [{ label: "next", target: "lookup" }],
        },
        lookup: {
          type: "programmatic",
          description: "lookup with agent-provided arg",
          operation: { name: "set_value", args: { value: "context.collection" } },
          contextUpdates: { lookupResult: "value" },
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "action", description: "end", edges: [{ label: "fin", target: "final" }] },
        final: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("agent-into-prog");
    const result = engine.advance("next", { collection: "alpha" });
    if (result.isError) throw new Error("unexpected error");
    expect(result.currentNode).toBe("end");
    expect(result.context.lookupResult).toBe("alpha");
  });

  it("drain loop lands at a terminal and returns complete", () => {
    const graphs = buildSingleGraphMap({
      id: "prog-to-terminal",
      version: "1.0.0",
      name: "Programmatic → Terminal",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: { type: "action", description: "a", edges: [{ label: "go", target: "p" }] },
        p: {
          type: "programmatic",
          description: "final programmatic hop",
          operation: { name: "set_value", args: { value: "done" } },
          contextUpdates: { result: "value" },
          edges: [{ label: "fin", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("prog-to-terminal");
    const result = engine.advance("go");
    if (result.isError) throw new Error("unexpected error");
    expect(result.status).toBe("complete");
    expect(result.currentNode).toBe("end");
    expect(result.context.result).toBe("done");
  });

  it("drain loop lands at a wait node and returns waiting", () => {
    const graphs = buildSingleGraphMap({
      id: "prog-to-wait",
      version: "1.0.0",
      name: "Programmatic → Wait",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: { type: "action", description: "a", edges: [{ label: "go", target: "p" }] },
        p: {
          type: "programmatic",
          description: "flip a signal",
          operation: { name: "set_value", args: { value: "pending" } },
          contextUpdates: { status: "value" },
          edges: [{ label: "wait-for-it", target: "w" }],
        },
        w: {
          type: "wait",
          description: "wait for signal",
          waitOn: [{ key: "externalSignal", type: "boolean" }],
          edges: [{ label: "resume", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("prog-to-wait");
    const result = engine.advance("go");
    if (result.isError) throw new Error("unexpected error");
    expect(result.status).toBe("waiting");
    expect(result.currentNode).toBe("w");
  });
});

describe("GraphEngine + programmatic nodes — no registry configured", () => {
  it("throws when hitting a programmatic node without an ops registry", () => {
    const graphs = buildSingleGraphMap({
      id: "needs-registry",
      version: "1.0.0",
      name: "Needs Registry",
      description: "test",
      startNode: "p",
      strictContext: false,
      nodes: {
        p: {
          type: "programmatic",
          description: "x",
          operation: { name: "whatever" },
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    // Note: no opsRegistry/opContext on the engine
    const engine = new GraphEngine(graphs);
    expect(() => engine.start("needs-registry")).toThrow(/no ops registry/);
  });

  it("graphs without programmatic nodes run fine without a registry", () => {
    const graphs = buildSingleGraphMap({
      id: "plain",
      version: "1.0.0",
      name: "Plain",
      description: "test",
      startNode: "a",
      strictContext: false,
      nodes: {
        a: { type: "action", description: "a", edges: [{ label: "go", target: "b" }] },
        b: { type: "terminal", description: "b" },
      },
    });
    const engine = new GraphEngine(graphs); // no registry
    const result = engine.start("plain");
    expect(result.currentNode).toBe("a");
  });
});

describe("GraphEngine + programmatic nodes — subgraph push drains child startNode", () => {
  function buildParentWithProgrammaticChild(): Map<
    string,
    ReturnType<typeof buildSingleGraphMap> extends Map<string, infer V> ? V : never
  > {
    const child = buildSingleGraphMap({
      id: "child-prog",
      version: "1.0.0",
      name: "Child",
      description: "programmatic startNode",
      startNode: "prep",
      strictContext: false,
      nodes: {
        prep: {
          type: "programmatic",
          description: "drain on push",
          operation: { name: "set_value", args: { value: "child-prepped" } },
          contextUpdates: { prepared: "value" },
          edges: [{ label: "ready", target: "landing" }],
        },
        landing: {
          type: "action",
          description: "child landing",
          edges: [{ label: "done", target: "child-end" }],
        },
        "child-end": { type: "terminal", description: "child terminal" },
      },
    });
    const parent = buildSingleGraphMap({
      id: "parent",
      version: "1.0.0",
      name: "Parent",
      description: "parent",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action",
          description: "agent kicks off",
          edges: [{ label: "go", target: "with-subgraph" }],
        },
        "with-subgraph": {
          type: "action",
          description: "subgraph host",
          subgraph: { graphId: "child-prog" },
          edges: [{ label: "resume", target: "after" }],
        },
        after: { type: "terminal", description: "after" },
      },
    });
    // Merge the two graph maps.
    const merged = new Map(parent);
    for (const [k, v] of child) merged.set(k, v);
    return merged;
  }

  it("runs the child's drain so the agent lands past the programmatic prep node", () => {
    const graphs = buildParentWithProgrammaticChild();
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("parent");
    const result = engine.advance("go");
    if (result.isError) throw new Error("unexpected error");
    // Without the fix, currentNode would still be "prep" (the child's
    // startNode) and context.prepared would be undefined. With the fix,
    // maybePushSubgraph drained through "prep" to "landing".
    expect(result.currentNode).toBe("landing");
    expect(result.context.prepared).toBe("child-prepped");
    expect(result.subgraphPushed?.graphId).toBe("child-prog");
  });
});

describe("GraphEngine + programmatic nodes — start() sets waitArrivedAt when drain lands on wait", () => {
  it("sets waitArrivedAt on the active session when startNode-chain lands on a wait node", () => {
    const graphs = buildSingleGraphMap({
      id: "start-to-wait",
      version: "1.0.0",
      name: "Start to Wait",
      description: "test",
      startNode: "prep",
      strictContext: false,
      nodes: {
        prep: {
          type: "programmatic",
          description: "set signal default",
          operation: { name: "set_value", args: { value: "pending" } },
          contextUpdates: { signal: "value" },
          edges: [{ label: "ready", target: "wait-for-it" }],
        },
        "wait-for-it": {
          type: "wait",
          description: "wait for external signal",
          waitOn: [{ key: "externalReady", type: "boolean" }],
          timeout: "1h",
          edges: [{ label: "resume", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    const engine = new GraphEngine(graphs, {
      opsRegistry: testOps(),
      opContext: { memoryStore: {} as never },
    });
    engine.start("start-to-wait");
    const inspect = engine.inspect("position");
    if (!("waitStatus" in inspect)) throw new Error("expected position result");
    expect(inspect.currentNode).toBe("wait-for-it");
    // Without the fix, waitStatus is undefined because waitArrivedAt is unset.
    expect(inspect.waitStatus).toBe("waiting");
    expect(inspect.timeoutAt).toBeDefined();
  });
});

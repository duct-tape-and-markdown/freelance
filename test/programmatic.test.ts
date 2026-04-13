import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestOpsRegistry, type OpHandler } from "../src/engine/operations.js";
import {
  drainProgrammaticChain,
  MAX_PROGRAMMATIC_STEPS,
  pickOutgoingEdge,
  projectOpResult,
  resolveOpArgs,
} from "../src/engine/programmatic.js";
import { EngineError } from "../src/errors.js";
import type { GraphDefinition, NodeDefinition, SessionState } from "../src/types.js";

function makeSession(startNode: string, context: Record<string, unknown> = {}): SessionState {
  return {
    graphId: "test-graph",
    currentNode: startNode,
    context,
    history: [],
    contextHistory: [],
    turnCount: 0,
    startedAt: new Date().toISOString(),
  };
}

function makeGraph(nodes: Record<string, NodeDefinition>, strictContext = false): GraphDefinition {
  return {
    id: "test-graph",
    version: "1.0.0",
    name: "Test Graph",
    description: "drain loop fixture",
    startNode: Object.keys(nodes)[0],
    strictContext,
    nodes,
  };
}

describe("resolveOpArgs", () => {
  it("passes literal strings through unchanged", () => {
    expect(resolveOpArgs({ kind: "class" }, {})).toEqual({ kind: "class" });
  });

  it("passes literal numbers, booleans, nulls, arrays through unchanged", () => {
    expect(resolveOpArgs({ a: 42, b: true, c: null, d: [1, 2] }, {})).toEqual({
      a: 42,
      b: true,
      c: null,
      d: [1, 2],
    });
  });

  it("resolves a context path string", () => {
    expect(resolveOpArgs({ collection: "context.col" }, { col: "alpha" })).toEqual({
      collection: "alpha",
    });
  });

  it("resolves a nested context path", () => {
    expect(resolveOpArgs({ name: "context.entity.name" }, { entity: { name: "Engine" } })).toEqual({
      name: "Engine",
    });
  });

  it("mixes literals and references in one call", () => {
    const context = { col: "alpha", max: 100 };
    expect(resolveOpArgs({ collection: "context.col", limit: 50, kind: "fn" }, context)).toEqual({
      collection: "alpha",
      limit: 50,
      kind: "fn",
    });
  });

  it("passes literal strings that merely contain 'context.' through", () => {
    // Only whole-value matches are treated as references.
    expect(resolveOpArgs({ note: "see context.foo for details" }, { foo: "X" })).toEqual({
      note: "see context.foo for details",
    });
  });

  it("resolves a missing context path to null", () => {
    expect(resolveOpArgs({ collection: "context.missing" }, {})).toEqual({ collection: null });
  });
});

describe("projectOpResult", () => {
  it("picks named fields from a result object", () => {
    const result = { total: 42, valid: 40, stale: 2 };
    const mapping = { propositionCount: "total", validCount: "valid" };
    expect(projectOpResult(result, mapping, "memory_status", "check-memory")).toEqual({
      propositionCount: 42,
      validCount: 40,
    });
  });

  it("returns an empty projection when mapping is empty", () => {
    expect(projectOpResult({ a: 1 }, {}, "op", "node")).toEqual({});
  });

  it("throws EngineError when a mapped field is missing from the result", () => {
    expect(() => projectOpResult({ total: 42 }, { count: "nonexistent" }, "op", "node")).toThrow(
      EngineError,
    );
  });

  it("preserves null fields", () => {
    const result = { value: null as unknown };
    expect(projectOpResult(result, { v: "value" }, "op", "node")).toEqual({ v: null });
  });

  it("preserves arrays", () => {
    const result = { entities: [{ id: "a" }, { id: "b" }] };
    expect(projectOpResult(result, { manifest: "entities" }, "op", "node")).toEqual({
      manifest: [{ id: "a" }, { id: "b" }],
    });
  });
});

describe("pickOutgoingEdge", () => {
  const makeProgNode = (edges: NodeDefinition["edges"]): NodeDefinition => ({
    type: "programmatic",
    description: "test",
    operation: { name: "noop" },
    edges,
  });

  it("picks the single unconditional edge", () => {
    const node = makeProgNode([{ label: "next", target: "B" }]);
    expect(pickOutgoingEdge(node, {}, "A")).toEqual({ label: "next", target: "B" });
  });

  it("picks the first edge whose condition is met", () => {
    const node = makeProgNode([
      { label: "low", target: "L", condition: "context.n < 10" },
      { label: "high", target: "H", condition: "context.n >= 10" },
    ]);
    expect(pickOutgoingEdge(node, { n: 5 }, "A")).toEqual({ label: "low", target: "L" });
    expect(pickOutgoingEdge(node, { n: 20 }, "A")).toEqual({ label: "high", target: "H" });
  });

  it("picks a default edge when no conditional edge matches", () => {
    const node = makeProgNode([
      { label: "cond", target: "C", condition: "context.x == 1" },
      { label: "fallback", target: "F", default: true },
    ]);
    expect(pickOutgoingEdge(node, { x: 2 }, "A")).toEqual({ label: "fallback", target: "F" });
  });

  it("prefers a matching conditional edge over a default edge", () => {
    const node = makeProgNode([
      { label: "fallback", target: "F", default: true },
      { label: "cond", target: "C", condition: "context.x == 1" },
    ]);
    expect(pickOutgoingEdge(node, { x: 1 }, "A")).toEqual({ label: "cond", target: "C" });
  });

  it("throws when the node has no edges", () => {
    const node = makeProgNode(undefined);
    expect(() => pickOutgoingEdge(node, {}, "A")).toThrow(EngineError);
  });

  it("throws when the node has an empty edges array", () => {
    const node = makeProgNode([]);
    expect(() => pickOutgoingEdge(node, {}, "A")).toThrow(EngineError);
  });

  it("throws when no edge condition matches and there's no default", () => {
    const node = makeProgNode([
      { label: "a", target: "A", condition: "context.x == 1" },
      { label: "b", target: "B", condition: "context.x == 2" },
    ]);
    expect(() => pickOutgoingEdge(node, { x: 99 }, "N")).toThrow(EngineError);
  });
});

describe("drainProgrammaticChain — single node", () => {
  let setCall: ReturnType<typeof vi.fn>;
  let ops: ReturnType<typeof createTestOpsRegistry>;

  beforeEach(() => {
    setCall = vi.fn();
    const test_set: OpHandler = (args) => {
      setCall(args);
      return { value: args.value };
    };
    ops = createTestOpsRegistry({ test_set });
  });

  it("returns 0 steps when the current node is not programmatic", () => {
    const graph = makeGraph({
      idle: { type: "action", description: "agent", edges: [] },
    });
    const session = makeSession("idle");
    const steps = drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(steps).toBe(0);
    expect(session.history).toHaveLength(0);
  });

  it("executes a single programmatic node and advances to its target", () => {
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "set a value",
        operation: { name: "test_set", args: { value: "hello" } },
        contextUpdates: { greeting: "value" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("start");
    const steps = drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(steps).toBe(1);
    expect(session.currentNode).toBe("end");
    expect(session.context.greeting).toBe("hello");
    expect(session.history).toHaveLength(1);
    expect(session.history[0]).toMatchObject({
      node: "start",
      edge: "done",
      operation: {
        name: "test_set",
        appliedUpdates: { greeting: "hello" },
      },
    });
  });

  it("records the op's appliedUpdates in the history entry", () => {
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "set multiple",
        operation: { name: "test_set", args: { value: 42 } },
        contextUpdates: { count: "value" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("start");
    drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(session.history[0].operation).toEqual({
      name: "test_set",
      appliedUpdates: { count: 42 },
    });
  });

  it("leaves contextHistory populated with projected keys", () => {
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "set",
        operation: { name: "test_set", args: { value: "x" } },
        contextUpdates: { result: "value" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("start");
    drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(session.contextHistory).toHaveLength(1);
    expect(session.contextHistory[0]).toMatchObject({
      key: "result",
      value: "x",
      setAt: "start",
    });
  });

  it("passes resolved context paths as op args", () => {
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "set using context ref",
        operation: { name: "test_set", args: { value: "context.src" } },
        contextUpdates: { mirror: "value" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("start", { src: "resolved-value" });
    drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(setCall).toHaveBeenCalledWith({ value: "resolved-value" });
    expect(session.context.mirror).toBe("resolved-value");
  });

  it("turnCount is reset to 0 after draining", () => {
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "set",
        operation: { name: "test_set", args: { value: 1 } },
        contextUpdates: { v: "value" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("start");
    session.turnCount = 7;
    drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(session.turnCount).toBe(0);
  });
});

describe("drainProgrammaticChain — chained", () => {
  it("chains through multiple programmatic nodes to a non-programmatic landing", () => {
    const ops = createTestOpsRegistry({
      set_a: () => ({ v: "a" }),
      set_b: () => ({ v: "b" }),
      set_c: () => ({ v: "c" }),
    });
    const graph = makeGraph({
      n1: {
        type: "programmatic",
        description: "step 1",
        operation: { name: "set_a" },
        contextUpdates: { step1: "v" },
        edges: [{ label: "next", target: "n2" }],
      },
      n2: {
        type: "programmatic",
        description: "step 2",
        operation: { name: "set_b" },
        contextUpdates: { step2: "v" },
        edges: [{ label: "next", target: "n3" }],
      },
      n3: {
        type: "programmatic",
        description: "step 3",
        operation: { name: "set_c" },
        contextUpdates: { step3: "v" },
        edges: [{ label: "done", target: "landing" }],
      },
      landing: { type: "action", description: "agent sees this", edges: [] },
    });
    const session = makeSession("n1");
    const steps = drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(steps).toBe(3);
    expect(session.currentNode).toBe("landing");
    expect(session.context).toMatchObject({ step1: "a", step2: "b", step3: "c" });
    expect(session.history).toHaveLength(3);
    expect(session.history.map((h) => h.node)).toEqual(["n1", "n2", "n3"]);
    expect(session.history.map((h) => h.operation?.name)).toEqual(["set_a", "set_b", "set_c"]);
  });

  it("branches on context set by an earlier programmatic node in the same chain", () => {
    const ops = createTestOpsRegistry({
      flag_on: () => ({ flag: true }),
    });
    const graph = makeGraph({
      start: {
        type: "programmatic",
        description: "flip a flag",
        operation: { name: "flag_on" },
        contextUpdates: { flag: "flag" },
        edges: [
          { label: "to-a", target: "a", condition: "context.flag == true" },
          { label: "to-b", target: "b", default: true },
        ],
      },
      a: { type: "action", description: "branch a", edges: [] },
      b: { type: "action", description: "branch b", edges: [] },
    });
    const session = makeSession("start", { flag: false });
    drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(session.currentNode).toBe("a");
  });

  it("chain ending at a terminal exits cleanly (main dispatch handles the terminal)", () => {
    const ops = createTestOpsRegistry({ noop: () => ({}) });
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "one step",
        operation: { name: "noop" },
        edges: [{ label: "to-end", target: "end" }],
      },
      end: { type: "terminal", description: "done" },
    });
    const session = makeSession("p");
    const steps = drainProgrammaticChain(session, graph, ops, { memoryStore: {} as never });
    expect(steps).toBe(1);
    expect(session.currentNode).toBe("end");
    // Drain loop exits because terminal is non-programmatic; main dispatch
    // would handle the terminal from here.
  });
});

describe("drainProgrammaticChain — errors", () => {
  const ctx = { memoryStore: {} as never };

  it("throws when an unknown op is referenced", () => {
    const ops = createTestOpsRegistry({});
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "x",
        operation: { name: "nonexistent" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("p");
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(EngineError);
  });

  it("throws when the op handler throws", () => {
    const ops = createTestOpsRegistry({
      boom: () => {
        throw new Error("deliberate failure");
      },
    });
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "x",
        operation: { name: "boom" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("p");
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(
      /Operation "boom" failed.*deliberate failure/,
    );
  });

  it("throws when no opsRegistry is provided but a programmatic node exists", () => {
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "x",
        operation: { name: "anything" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("p");
    expect(() => drainProgrammaticChain(session, graph, undefined, undefined)).toThrow(
      /no ops registry/,
    );
  });

  it("throws when projectOpResult is given a missing field", () => {
    const ops = createTestOpsRegistry({ partial: () => ({ a: 1 }) });
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "x",
        operation: { name: "partial" },
        contextUpdates: { key: "nonexistent" },
        edges: [{ label: "done", target: "end" }],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("p");
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(
      /returned no field "nonexistent"/,
    );
  });

  it("throws when no outgoing edge matches and there's no default", () => {
    const ops = createTestOpsRegistry({ noop: () => ({}) });
    const graph = makeGraph({
      p: {
        type: "programmatic",
        description: "x",
        operation: { name: "noop" },
        edges: [
          { label: "a", target: "end", condition: "context.x == 1" },
          { label: "b", target: "end", condition: "context.x == 2" },
        ],
      },
      end: { type: "action", description: "end", edges: [] },
    });
    const session = makeSession("p", { x: 99 });
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(
      /No valid outgoing edge/,
    );
  });

  it("enforces strictContext on programmatic writes", () => {
    const ops = createTestOpsRegistry({ set: () => ({ v: "x" }) });
    const graph = makeGraph(
      {
        p: {
          type: "programmatic",
          description: "x",
          operation: { name: "set" },
          contextUpdates: { undeclared: "v" },
          edges: [{ label: "done", target: "end" }],
        },
        end: { type: "action", description: "end", edges: [] },
      },
      true, // strictContext
    );
    // Graph declares no keys in context, so "undeclared" violates strict mode.
    graph.context = { declared: null };
    const session = makeSession("p", { declared: null });
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(
      /STRICT_CONTEXT_VIOLATION|not declared/,
    );
  });

  it("bounded by MAX_PROGRAMMATIC_STEPS when authoring-time cycle detection fails", () => {
    // Build a cycle manually — in production this is rejected at load time,
    // but we verify the runtime cap catches it if something slipped through.
    const ops = createTestOpsRegistry({ noop: () => ({}) });
    const graph = makeGraph({
      a: {
        type: "programmatic",
        description: "loop-a",
        operation: { name: "noop" },
        edges: [{ label: "to-b", target: "b" }],
      },
      b: {
        type: "programmatic",
        description: "loop-b",
        operation: { name: "noop" },
        edges: [{ label: "to-a", target: "a" }],
      },
    });
    const session = makeSession("a");
    expect(() => drainProgrammaticChain(session, graph, ops, ctx)).toThrow(/exceeded .* steps/);
  });
});

describe("MAX_PROGRAMMATIC_STEPS", () => {
  it("is exposed as a constant for documentation and test parity", () => {
    expect(typeof MAX_PROGRAMMATIC_STEPS).toBe("number");
    expect(MAX_PROGRAMMATIC_STEPS).toBeGreaterThan(0);
  });
});

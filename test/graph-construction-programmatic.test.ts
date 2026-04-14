import { describe, expect, it } from "vitest";
import { buildAndValidateGraph } from "../src/graph-construction.js";
import type { GraphDefinition } from "../src/types.js";

function graph(overrides: Partial<GraphDefinition>): GraphDefinition {
  return {
    id: "t",
    version: "1.0.0",
    name: "t",
    description: "t",
    startNode: "start",
    strictContext: false,
    nodes: {},
    ...overrides,
  };
}

describe("graph-construction — programmatic node: required fields", () => {
  it("rejects a programmatic node with no operation", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "missing op",
          // @ts-expect-error — intentionally omitting operation
          operation: undefined,
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<test>")).toThrow(
      /programmatic node must declare an operation/,
    );
  });

  it("accepts a programmatic node with a valid operation (op-name check is not structural)", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "ok",
          operation: { name: "memory_status" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    // Op-name validation is a post-pass (see src/ops-validation.ts).
    // buildAndValidateGraph accepts any op name; the reference is
    // checked by validateOps once a live registry is available.
    expect(() => buildAndValidateGraph(def, "<test>")).not.toThrow();
  });
});

describe("graph-construction — programmatic node: forbidden fields", () => {
  const base = (extra: Partial<Record<string, unknown>>): GraphDefinition =>
    graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "x",
          operation: { name: "test_op" },
          edges: [{ label: "go", target: "end" }],
          ...extra,
        } as GraphDefinition["nodes"][string],
        end: { type: "terminal", description: "end" },
      },
    });

  it("rejects instructions", () => {
    expect(() => buildAndValidateGraph(base({ instructions: "do the thing" }), "<t>")).toThrow(
      /must not have "instructions"/,
    );
  });

  it("rejects suggestedTools", () => {
    expect(() => buildAndValidateGraph(base({ suggestedTools: ["tool"] }), "<t>")).toThrow(
      /must not have "suggestedTools"/,
    );
  });

  it("rejects maxTurns", () => {
    expect(() => buildAndValidateGraph(base({ maxTurns: 5 }), "<t>")).toThrow(
      /must not have "maxTurns"/,
    );
  });

  it("rejects readOnly", () => {
    expect(() => buildAndValidateGraph(base({ readOnly: true }), "<t>")).toThrow(
      /must not have "readOnly"/,
    );
  });

  it("rejects validations", () => {
    expect(() =>
      buildAndValidateGraph(base({ validations: [{ expr: "true", message: "nope" }] }), "<t>"),
    ).toThrow(/must not have "validations"/);
  });

  it("rejects returns", () => {
    expect(() =>
      buildAndValidateGraph(base({ returns: { required: { x: { type: "string" } } } }), "<t>"),
    ).toThrow(/must not have "returns"/);
  });

  it("rejects subgraph", () => {
    expect(() => buildAndValidateGraph(base({ subgraph: { graphId: "child" } }), "<t>")).toThrow(
      /must not have "subgraph"/,
    );
  });

  it("rejects waitOn", () => {
    expect(() =>
      buildAndValidateGraph(base({ waitOn: [{ key: "sig", type: "boolean" }] }), "<t>"),
    ).toThrow(/must not have "waitOn"/);
  });

  it("rejects timeout", () => {
    expect(() => buildAndValidateGraph(base({ timeout: "5m" }), "<t>")).toThrow(
      /must not have "timeout"/,
    );
  });
});

describe("graph-construction — non-programmatic nodes: operation/contextUpdates forbidden", () => {
  it("rejects operation on action nodes", () => {
    const def = graph({
      nodes: {
        start: {
          type: "action",
          description: "bad action",
          operation: { name: "x" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /only programmatic nodes may have "operation"/,
    );
  });

  it("rejects operation on decision nodes", () => {
    const def = graph({
      nodes: {
        start: {
          type: "decision",
          description: "bad decision",
          operation: { name: "x" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /only programmatic nodes may have "operation"/,
    );
  });

  it("rejects contextUpdates on action nodes", () => {
    const def = graph({
      nodes: {
        start: {
          type: "action",
          description: "bad action",
          contextUpdates: { x: "y" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /only programmatic nodes may have "contextUpdates"/,
    );
  });

  it("rejects contextUpdates on gate nodes", () => {
    const def = graph({
      nodes: {
        start: {
          type: "gate",
          description: "bad gate",
          validations: [{ expr: "true", message: "ok" }],
          contextUpdates: { x: "y" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "end" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /only programmatic nodes may have "contextUpdates"/,
    );
  });
});

describe("graph-construction — pure-programmatic cycles rejected by existing breaking-node rule", () => {
  it("rejects a two-node pure-programmatic cycle", () => {
    const def = graph({
      startNode: "a",
      nodes: {
        a: {
          type: "programmatic",
          description: "loop-a",
          operation: { name: "op" },
          edges: [{ label: "to-b", target: "b" }],
        },
        b: {
          type: "programmatic",
          description: "loop-b",
          operation: { name: "op" },
          edges: [{ label: "to-a", target: "a" }],
        },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /Cycle detected.*no decision, gate, or wait node/,
    );
  });

  it("rejects a programmatic self-loop", () => {
    const def = graph({
      startNode: "a",
      nodes: {
        a: {
          type: "programmatic",
          description: "self-loop",
          operation: { name: "op" },
          edges: [{ label: "self", target: "a" }],
        },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /Cycle detected.*no decision, gate, or wait node/,
    );
  });

  it("accepts a programmatic node in a cycle that has a decision breaker", () => {
    const def = graph({
      startNode: "entry",
      nodes: {
        entry: {
          type: "action",
          description: "start",
          edges: [{ label: "go", target: "d" }],
        },
        d: {
          type: "decision",
          description: "breaker",
          edges: [
            { label: "loop", target: "p", condition: "context.more == true" },
            { label: "exit", target: "end", default: true },
          ],
        },
        p: {
          type: "programmatic",
          description: "work",
          operation: { name: "op" },
          edges: [{ label: "back", target: "d" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).not.toThrow();
  });
});

describe("graph-construction — programmatic node: edge requirements", () => {
  it("rejects a programmatic node with no outgoing edges (existing non-terminal rule)", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "no edges",
          operation: { name: "op" },
        },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(
      /non-terminal node of type "programmatic" must have at least one outgoing edge/,
    );
  });

  it("rejects a programmatic node whose edge targets a missing node (existing rule)", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "bad target",
          operation: { name: "op" },
          edges: [{ label: "go", target: "nowhere" }],
        },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(/targets undefined node "nowhere"/);
  });
});

describe("graph-construction — programmatic node: multi-edge ambiguity", () => {
  it("accepts a single unconditional edge", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "one-edge",
          operation: { name: "op" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).not.toThrow();
  });

  it("accepts multiple conditional edges plus a default", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "conditional branching",
          operation: { name: "op" },
          edges: [
            { label: "a", target: "aTarget", condition: "context.x == 1" },
            { label: "b", target: "bTarget", condition: "context.x == 2" },
            { label: "fallback", target: "aTarget", default: true },
          ],
        },
        aTarget: { type: "terminal", description: "a" },
        bTarget: { type: "terminal", description: "b" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).not.toThrow();
  });

  it("rejects two unconditional edges", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "ambiguous",
          operation: { name: "op" },
          edges: [
            { label: "a", target: "end" },
            { label: "b", target: "end" },
          ],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(/cannot have unconditional edges/);
  });

  it("rejects an unconditional edge alongside a conditional", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "mixed",
          operation: { name: "op" },
          edges: [
            { label: "cond", target: "end", condition: "context.x == 1" },
            { label: "any", target: "end" },
          ],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(/cannot have unconditional edges/);
  });

  it("rejects two default edges", () => {
    const def = graph({
      nodes: {
        start: {
          type: "programmatic",
          description: "two defaults",
          operation: { name: "op" },
          edges: [
            { label: "a", target: "end", default: true },
            { label: "b", target: "end", default: true },
          ],
        },
        end: { type: "terminal", description: "done" },
      },
    });
    expect(() => buildAndValidateGraph(def, "<t>")).toThrow(/2 default edges/);
  });
});

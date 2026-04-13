import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/builder.js";

describe("GraphBuilder", () => {
  it("builds a minimal valid graph", () => {
    const result = new GraphBuilder("test-minimal", "Test")
      .setDescription("A minimal test graph")
      .node("start", {
        description: "Starting node",
        edges: [{ target: "done" }],
      })
      .node("done", {
        type: "terminal",
        description: "End",
      })
      .build();

    expect(result.definition.id).toBe("test-minimal");
    expect(result.definition.name).toBe("Test");
    expect(result.definition.startNode).toBe("start");
    expect(result.graph.nodeCount()).toBe(2);
  });

  it("first node becomes startNode by default", () => {
    const result = new GraphBuilder("test-auto-start")
      .setDescription("Auto start")
      .node("alpha", {
        description: "First added",
        edges: [{ target: "omega" }],
      })
      .node("omega", {
        type: "terminal",
        description: "End",
      })
      .build();

    expect(result.definition.startNode).toBe("alpha");
  });

  it("explicit startNode overrides default", () => {
    const result = new GraphBuilder("test-explicit-start")
      .setDescription("Explicit start")
      .setContext({ route: "" })
      .node("a", {
        type: "decision",
        description: "Decision node",
        edges: [
          { target: "b", label: "to-b" },
          { target: "c", label: "to-c" },
        ],
      })
      .node("b", {
        description: "The real start",
        edges: [{ target: "a" }, { target: "c" }],
      })
      .node("c", {
        type: "terminal",
        description: "End",
      })
      .startNode("b")
      .build();

    expect(result.definition.startNode).toBe("b");
  });

  it("auto-generates edge labels from target names", () => {
    const result = new GraphBuilder("test-labels")
      .setDescription("Auto labels")
      .node("start", {
        description: "Start",
        edges: [{ target: "done" }],
      })
      .node("done", {
        type: "terminal",
        description: "End",
      })
      .build();

    expect(result.definition.nodes.start.edges![0].label).toBe("done");
  });

  it("preserves explicit edge labels", () => {
    const result = new GraphBuilder("test-explicit-labels")
      .setDescription("Explicit labels")
      .node("start", {
        description: "Start",
        edges: [{ target: "done", label: "finish" }],
      })
      .node("done", {
        type: "terminal",
        description: "End",
      })
      .build();

    expect(result.definition.nodes.start.edges![0].label).toBe("finish");
  });

  it("infers terminal type from no edges", () => {
    const result = new GraphBuilder("test-infer-terminal")
      .setDescription("Infer terminal")
      .node("start", {
        description: "Start",
        edges: [{ target: "end" }],
      })
      .node("end", {
        description: "Should be terminal",
      })
      .build();

    expect(result.definition.nodes.end.type).toBe("terminal");
  });

  it("supports context definition", () => {
    const result = new GraphBuilder("test-context")
      .setDescription("With context")
      .setContext({ count: 0, ready: false })
      .node("start", {
        description: "Start",
        edges: [{ target: "done", condition: "context.ready == true" }],
      })
      .node("done", {
        type: "terminal",
        description: "End",
      })
      .build();

    expect(result.definition.context).toEqual({ count: 0, ready: false });
  });

  it("supports decision nodes with conditions", () => {
    const result = new GraphBuilder("test-decision")
      .setDescription("Decision graph")
      .setContext({ score: 0 })
      .node("check", {
        type: "decision",
        description: "Check score",
        edges: [
          { target: "pass", label: "high", condition: "context.score > 80" },
          { target: "fail", label: "low", condition: "context.score <= 80" },
        ],
      })
      .node("pass", { type: "terminal", description: "Passed" })
      .node("fail", { type: "terminal", description: "Failed" })
      .build();

    expect(result.definition.nodes.check.type).toBe("decision");
    expect(result.graph.nodeCount()).toBe(3);
  });

  it("validates edge targets exist", () => {
    expect(() =>
      new GraphBuilder("test-bad-target")
        .setDescription("Bad target")
        .node("start", {
          description: "Start",
          edges: [{ target: "nonexistent" }],
        })
        .build(),
    ).toThrow("nonexistent");
  });

  it("validates unreachable nodes", () => {
    expect(() =>
      new GraphBuilder("test-orphan")
        .setDescription("Orphan node")
        .node("start", {
          description: "Start",
          edges: [{ target: "done" }],
        })
        .node("done", { type: "terminal", description: "End" })
        .node("orphan", { type: "terminal", description: "Unreachable" })
        .build(),
    ).toThrow("unreachable");
  });

  it("rejects empty builder", () => {
    expect(() => new GraphBuilder("test-empty").build()).toThrow("no nodes added");
  });

  it("validates expressions at build time", () => {
    expect(() =>
      new GraphBuilder("test-bad-expr")
        .setDescription("Bad expression")
        .node("start", {
          description: "Start",
          edges: [{ target: "done", condition: "context.foo === true" }],
        })
        .node("done", { type: "terminal", description: "End" })
        .build(),
    ).toThrow();
  });

  it("builds a graph with a programmatic node", () => {
    const result = new GraphBuilder("test-programmatic")
      .setDescription("Programmatic node")
      .node("prep", {
        type: "programmatic",
        description: "fetch status",
        operation: { name: "memory_status" },
        contextUpdates: { count: "total_propositions" },
        edges: [{ target: "work", label: "ready" }],
      })
      .node("work", {
        type: "action",
        description: "agent step",
        edges: [{ target: "end", label: "done" }],
      })
      .node("end", { type: "terminal", description: "done" })
      .build();

    expect(result.definition.nodes.prep.type).toBe("programmatic");
    expect(result.definition.nodes.prep.operation).toEqual({ name: "memory_status" });
    expect(result.definition.nodes.prep.contextUpdates).toEqual({ count: "total_propositions" });
  });

  it("passes programmatic operation.args through to the validated definition", () => {
    const result = new GraphBuilder("test-programmatic-args")
      .setDescription("Args")
      .node("prep", {
        type: "programmatic",
        description: "browse with args",
        operation: {
          name: "memory_browse",
          args: { collection: "context.collection", limit: 50 },
        },
        contextUpdates: { manifest: "entities" },
        edges: [{ target: "end" }],
      })
      .node("end", { type: "terminal", description: "done" })
      .build();

    expect(result.definition.nodes.prep.operation?.args).toEqual({
      collection: "context.collection",
      limit: 50,
    });
  });

  it("rejects a programmatic node with no operation (enforced by graph-construction)", () => {
    expect(() =>
      new GraphBuilder("test-missing-op")
        .setDescription("Missing")
        .node("prep", {
          type: "programmatic",
          description: "no op",
          edges: [{ target: "end" }],
        })
        .node("end", { type: "terminal", description: "done" })
        .build(),
    ).toThrow(/programmatic node must declare an operation/);
  });

  it("rejects operation on a non-programmatic node", () => {
    expect(() =>
      new GraphBuilder("test-wrong-type")
        .setDescription("Wrong type")
        .node("start", {
          type: "action",
          description: "shouldn't have op",
          operation: { name: "anything" },
          edges: [{ target: "end" }],
        })
        .node("end", { type: "terminal", description: "done" })
        .build(),
    ).toThrow(/only programmatic nodes may have "operation"/);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphEngine } from "../src/engine/index.js";
import { EngineError } from "../src/errors.js";
import { loadFixtureGraphs, makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

const loadFixtures = (...files: string[]) =>
  loadFixtureGraphs(FIXTURES_DIR, "engine-test-", ...files);
const makeEngine = (...files: string[]): GraphEngine =>
  sharedMakeEngine(FIXTURES_DIR, "engine-test-", ...files);

describe("list()", () => {
  it("returns all loaded graphs", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    const result = engine.list();
    expect(result.graphs).toHaveLength(2);
    const ids = result.graphs.map((g) => g.id).sort();
    expect(ids).toEqual(["valid-branching", "valid-simple"]);
  });

  it("includes correct metadata", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = engine.list();
    expect(result.graphs[0]).toEqual({
      id: "valid-simple",
      name: "Simple Workflow",
      version: "1.0.0",
      description: "A minimal valid graph for testing",
    });
  });

  it("works before and after starting a traversal", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    expect(engine.list().graphs).toHaveLength(1);
    await engine.start("valid-simple");
    expect(engine.list().graphs).toHaveLength(1);
  });
});

describe("start()", () => {
  it("returns start node with correct info", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = await engine.start("valid-simple");
    expect(result.status).toBe("started");
    expect(result.isError).toBe(false);
    expect(result.graphId).toBe("valid-simple");
    expect(result.currentNode).toBe("start");
    expect(result.node.type).toBe("action");
    expect(result.node.description).toBe("Begin the task");
  });

  it("initializes context with graph defaults", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = await engine.start("valid-simple");
    expect(result.context).toEqual({ taskStarted: false });
  });

  it("merges initialContext overrides", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = await engine.start("valid-simple", { taskStarted: true, extra: 42 });
    expect(result.context.taskStarted).toBe(true);
    expect(result.context.extra).toBe(42);
  });

  it("throws GRAPH_NOT_FOUND for unknown graphId", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await expect(engine.start("nonexistent")).rejects.toThrow(EngineError);
    try {
      await engine.start("nonexistent");
    } catch (e) {
      expect((e as EngineError).code).toBe("GRAPH_NOT_FOUND");
    }
  });

  it("throws TRAVERSAL_ACTIVE if already started", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await expect(engine.start("valid-simple")).rejects.toThrow(EngineError);
    try {
      await engine.start("valid-simple");
    } catch (e) {
      expect((e as EngineError).code).toBe("TRAVERSAL_ACTIVE");
    }
  });
});

describe("advance() — happy path", () => {
  it("advances through simple graph to terminal", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");

    // start → review (gate)
    const r1 = await engine.advance("work-done", { taskStarted: true });
    expect(r1.isError).toBe(false);
    if (!r1.isError) {
      expect(r1.status).toBe("advanced");
      expect(r1.previousNode).toBe("start");
      expect(r1.edgeTaken).toBe("work-done");
      expect(r1.currentNode).toBe("review");
    }

    // review → done (terminal)
    const r2 = await engine.advance("approved");
    expect(r2.isError).toBe(false);
    if (!r2.isError) {
      expect(r2.status).toBe("complete");
      expect(r2.currentNode).toBe("done");
      expect(r2.node.type).toBe("terminal");
      expect(r2.traversalHistory).toEqual(["start", "review", "done"]);
    }
  });

  it("builds history correctly", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done", { taskStarted: true });

    const hist = engine.inspect("history");
    if ("traversalHistory" in hist) {
      expect(hist.traversalHistory).toHaveLength(1);
      expect(hist.traversalHistory[0].node).toBe("start");
      expect(hist.traversalHistory[0].edge).toBe("work-done");
    }
  });
});

describe("advance() — context updates persist on failure", () => {
  it("applies contextUpdates even when validation fails", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done"); // advance to review gate without setting taskStarted

    // Try to advance from gate with context updates — validation should fail
    // but context updates should persist
    const result = await engine.advance("approved", { someKey: "persisted" });
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("Task must be started");
      expect(result.context.someKey).toBe("persisted");
    }
  });
});

describe("advance() — contextUpdates increment turnCount", () => {
  it("increments turnCount on failed advance with contextUpdates", async () => {
    const engine = makeEngine("valid-strict.workflow.yaml");
    await engine.start("valid-strict");

    // Advance to gate (check node) — taskDone is still false, validation will fail
    await engine.advance("finished");

    // Two failed advances with contextUpdates should increment turnCount
    await engine.advance("approved", { progress: 1 });
    await engine.advance("approved", { progress: 2 });

    // Verify turnCount via inspect
    const pos = engine.inspect("position");
    if ("turnCount" in pos) {
      expect(pos.turnCount).toBe(2);
    }
  });
});

describe("advance() — gate enforcement", () => {
  it("blocks advance when gate validation fails", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done"); // at review gate, taskStarted still false

    const result = await engine.advance("approved");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("Task must be started");
      expect(result.currentNode).toBe("review");
    }
  });

  it("allows advance after satisfying gate validation", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done");

    // Set context to pass validation
    engine.contextSet({ taskStarted: true });

    const result = await engine.advance("approved");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("done");
    }
  });
});

describe("advance() — conditional edges", () => {
  it("succeeds when condition is met", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized"); // at choose-path
    engine.contextSet({ path: "left" });

    const result = await engine.advance("go-left");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("left-work");
    }
  });

  it("returns error when condition is not met", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized"); // at choose-path
    engine.contextSet({ path: "left" });

    const result = await engine.advance("go-right");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("condition not met");
    }
  });
});

describe("advance() — unified error envelope", () => {
  it("emits error.code + kind on gate-block (validation failure)", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done");

    const result = await engine.advance("approved");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.error.code).toBe("VALIDATION_FAILED");
      expect(result.error.kind).toBe("blocked");
      expect(result.error.message).toBe(result.reason);
    }
  });

  it("emits EDGE_CONDITION_NOT_MET on edge-condition block", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized");
    engine.contextSet({ path: "left" });

    const result = await engine.advance("go-right");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.error.code).toBe("EDGE_CONDITION_NOT_MET");
      expect(result.error.kind).toBe("blocked");
    }
  });
});

describe("advance() — default edges", () => {
  it("default edge conditionMet is true when no conditional edge matches", async () => {
    const engine = makeEngine("valid-default-edge.workflow.yaml");
    await engine.start("valid-default-edge");

    // route is null, so special condition is false → default should be conditionMet: true
    const pos = engine.inspect("position");
    if ("validTransitions" in pos) {
      const defaultEdge = pos.validTransitions.find((t) => t.label === "default-route");
      const specialEdge = pos.validTransitions.find((t) => t.label === "special-route");
      expect(defaultEdge?.conditionMet).toBe(true);
      expect(specialEdge?.conditionMet).toBe(false);
    }
  });

  it("default edge conditionMet is false when a conditional edge matches", async () => {
    const engine = makeEngine("valid-default-edge.workflow.yaml");
    await engine.start("valid-default-edge");
    engine.contextSet({ route: "special" });

    const pos = engine.inspect("position");
    if ("validTransitions" in pos) {
      const defaultEdge = pos.validTransitions.find((t) => t.label === "default-route");
      const specialEdge = pos.validTransitions.find((t) => t.label === "special-route");
      expect(specialEdge?.conditionMet).toBe(true);
      expect(defaultEdge?.conditionMet).toBe(false);
    }
  });
});

describe("contextSet()", () => {
  it("updates context correctly", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const result = engine.contextSet({ taskStarted: true });
    expect(result.status).toBe("updated");
    expect(result.context.taskStarted).toBe(true);
  });

  it("returns updated transitions", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized"); // at choose-path

    const result = engine.contextSet({ path: "left" });
    const leftEdge = result.validTransitions.find((t) => t.label === "go-left");
    expect(leftEdge?.conditionMet).toBe(true);
  });

  it("increments turnCount", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const r1 = engine.contextSet({ taskStarted: true });
    expect(r1.turnCount).toBe(1);
    const r2 = engine.contextSet({ taskStarted: true });
    expect(r2.turnCount).toBe(2);
  });

  it("returns turnWarning when maxTurns reached", async () => {
    const engine = makeEngine("valid-strict.workflow.yaml");
    await engine.start("valid-strict");

    engine.contextSet({ progress: 1 });
    engine.contextSet({ progress: 2 });
    const r3 = engine.contextSet({ progress: 3 });
    expect(r3.turnCount).toBe(3);
    expect(r3.turnWarning).toContain("Turn budget reached");
    expect(r3.turnWarning).toContain("3/3");
  });

  it("rejects unknown keys with strictContext", async () => {
    const engine = makeEngine("valid-strict.workflow.yaml");
    await engine.start("valid-strict");

    expect(() => engine.contextSet({ unknownKey: true })).toThrow(EngineError);
    try {
      engine.contextSet({ unknownKey: true });
    } catch (e) {
      expect((e as EngineError).code).toBe("STRICT_CONTEXT_VIOLATION");
    }
  });
});

describe("inspect()", () => {
  it("position returns current node and context", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const result = engine.inspect("position");
    expect("graphName" in result).toBe(true);
    if ("graphName" in result) {
      expect(result.currentNode).toBe("start");
      expect(result.graphName).toBe("Simple Workflow");
      expect(result.turnCount).toBe(0);
      expect(result.turnWarning).toBeNull();
    }
  });

  it("history returns traversal and context history", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    engine.contextSet({ taskStarted: true });
    await engine.advance("work-done");

    const result = engine.inspect("history");
    if ("traversalHistory" in result) {
      expect(result.traversalHistory).toHaveLength(1);
      expect(result.contextHistory.length).toBeGreaterThan(0);
      expect(result.contextHistory[0].key).toBe("taskStarted");
    }
  });

  it("fields: ['definition'] returns the complete graph definition", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const result = engine.inspect("position", ["definition"]);
    expect(result.definition).toBeDefined();
    expect(result.definition?.id).toBe("valid-simple");
    expect(result.definition?.nodes).toBeDefined();
  });

  it("throws when no traversal active", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    expect(() => engine.inspect("position")).toThrow(EngineError);
  });
});

describe("reset()", () => {
  it("clears state and returns previous info", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.previousGraph).toBe("valid-simple");
    expect(result.previousNode).toBe("start");
  });

  it("allows starting again after reset", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    engine.reset();
    const result = await engine.start("valid-simple");
    expect(result.status).toBe("started");
  });

  it("returns gracefully with no active traversal", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.previousGraph).toBeNull();
  });

  it("after reset, advance/contextSet/inspect throw NO_TRAVERSAL", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    engine.reset();
    await expect(engine.advance("work-done")).rejects.toThrow(EngineError);
    expect(() => engine.contextSet({ x: 1 })).toThrow(EngineError);
    expect(() => engine.inspect("position")).toThrow(EngineError);
  });
});

describe("conditionMet evaluation", () => {
  it("edges with no condition → conditionMet: true", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = await engine.start("valid-simple");
    expect(result.validTransitions[0].conditionMet).toBe(true);
  });

  it("edges with true condition → conditionMet: true", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized");
    engine.contextSet({ path: "left" });
    const pos = engine.inspect("position");
    if ("validTransitions" in pos) {
      const left = pos.validTransitions.find((t) => t.label === "go-left");
      expect(left?.conditionMet).toBe(true);
    }
  });

  it("edges with false condition → conditionMet: false", async () => {
    const engine = makeEngine("valid-branching.workflow.yaml");
    await engine.start("valid-branching");
    await engine.advance("initialized");
    engine.contextSet({ path: "left" });
    const pos = engine.inspect("position");
    if ("validTransitions" in pos) {
      const right = pos.validTransitions.find((t) => t.label === "go-right");
      expect(right?.conditionMet).toBe(false);
    }
  });
});

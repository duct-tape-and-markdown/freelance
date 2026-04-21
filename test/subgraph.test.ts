import path from "node:path";
import { describe, expect, it } from "vitest";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import { EngineError } from "../src/errors.js";
import { graphDefinitionSchema } from "../src/schema/graph-schema.js";
import { loadFixtureGraphs, makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

const loadFixtures = (...files: string[]) =>
  loadFixtureGraphs(FIXTURES_DIR, "subgraph-test-", ...files);
const makeEngine = (...files: string[]): GraphEngine =>
  sharedMakeEngine(FIXTURES_DIR, "subgraph-test-", ...files);

// =============================================================================
// ENGINE UNIT TESTS — Subgraph Push/Pop Mechanics
// =============================================================================

describe("subgraph — push mechanics", () => {
  it("pushes child graph when advancing to a subgraph node", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    const result = await engine.advance("work-done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // Should have pushed the child graph
      expect(result.subgraphPushed).toBeDefined();
      expect(result.subgraphPushed!.graphId).toBe("child-review");
      expect(result.subgraphPushed!.startNode).toBe("check-security");
      expect(result.subgraphPushed!.stackDepth).toBe(2);
      // Current node should be the child's start node
      expect(result.currentNode).toBe("check-security");
      expect(result.node.description).toBe("Check for security issues");
    }
  });

  it("contextMap copies parent context to child initial context", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    const result = await engine.advance("work-done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // contextMap: { taskDone: parentTaskDone }
      // Parent's context.taskDone (true) should be copied to child's context.parentTaskDone
      expect(result.context.parentTaskDone).toBe(true);
    }
  });

  it("after push, contextSet operates on child session", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    // Now contextSet should operate on the child's context
    const result = engine.contextSet({ securityPass: true });
    expect(result.context.securityPass).toBe(true);
    // Parent context key should not be visible
    expect(result.context.reviewPassed).toBeUndefined();
  });

  it("after push, advance operates on child graph edges", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child, now at check-security

    const result = await engine.advance("done"); // check-security → check-tests
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("check-tests");
    }
  });
});

describe("subgraph — pop mechanics", () => {
  it("pops back to parent when child reaches terminal", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    // Traverse child to completion
    engine.contextSet({ securityPass: true });
    await engine.advance("done"); // → check-tests
    engine.contextSet({ testsPass: true, approved: true });
    await engine.advance("done"); // → review-gate
    const result = await engine.advance("approved"); // → complete (terminal) → pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("subgraph_complete");
      expect(result.completedGraph).toBe("child-review");
      expect(result.stackDepth).toBe(1);
      expect(result.resumedNode).toBe("quality-gate");
      expect(result.currentNode).toBe("quality-gate");
    }
  });

  it("returnMap copies child context to parent context on pop", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    // Complete child with approved = true
    engine.contextSet({ securityPass: true });
    await engine.advance("done");
    engine.contextSet({ testsPass: true, approved: true });
    await engine.advance("done");
    const result = await engine.advance("approved"); // pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      // returnMap: { approved: reviewPassed }
      expect(result.returnedContext).toEqual({ reviewPassed: true });
      expect(result.context.reviewPassed).toBe(true);
    }
  });

  it("after pop, parent edges are available and parent can advance", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    // Complete child
    engine.contextSet({ securityPass: true });
    await engine.advance("done");
    engine.contextSet({ testsPass: true, approved: true });
    await engine.advance("done");
    await engine.advance("approved"); // pop back to quality-gate

    // Now advance on the parent's edge
    const result = await engine.advance("pass");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("complete");
      expect(result.currentNode).toBe("finalize");
    }
  });
});

describe("subgraph — inspect shows stack", () => {
  it("inspect shows stack depth and entries during subgraph", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    const pos = engine.inspect("position");
    if ("stackDepth" in pos) {
      expect(pos.stackDepth).toBe(2);
      expect(pos.stack).toHaveLength(2);
      expect(pos.stack[0].graphId).toBe("parent-workflow");
      expect(pos.stack[0].suspendedAt).toBe("quality-gate");
      expect(pos.stack[1].graphId).toBe("child-review");
      expect(pos.stack[1].currentNode).toBe("check-security");
    }
  });

  it("inspect shows stack depth 1 for single graph", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");

    const pos = engine.inspect("position");
    if ("stackDepth" in pos) {
      expect(pos.stackDepth).toBe(1);
      expect(pos.stack).toHaveLength(1);
      expect(pos.stack[0].graphId).toBe("parent-workflow");
      expect(pos.stack[0].currentNode).toBe("start");
    }
  });
});

describe("subgraph — reset clears full stack", () => {
  it("reset during subgraph clears entire stack", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    await engine.advance("work-done"); // pushes child

    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.clearedStack).toBeDefined();
    expect(result.clearedStack).toHaveLength(2);
    expect(result.clearedStack![0].graphId).toBe("parent-workflow");
    expect(result.clearedStack![0].node).toBe("quality-gate");
    expect(result.clearedStack![1].graphId).toBe("child-review");
    expect(result.clearedStack![1].node).toBe("check-security");

    // Can start a new graph after reset
    const startResult = await engine.start("parent-workflow");
    expect(startResult.status).toBe("started");
  });

  it("reset with single graph does not include clearedStack", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");

    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.clearedStack).toBeUndefined();
    expect(result.previousGraph).toBe("parent-workflow");
  });
});

describe("subgraph — stack depth enforcement", () => {
  it("throws STACK_DEPTH_EXCEEDED when maxDepth reached", async () => {
    const graphs = loadFixtures("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    // Set maxDepth to 1 — no nesting allowed
    const engine = new GraphEngine(graphs, { maxDepth: 1, hookRunner: new HookRunner() });
    await engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    await expect(engine.advance("work-done")).rejects.toThrow(EngineError);
    try {
      await engine.advance("work-done");
    } catch (e) {
      expect((e as EngineError).code).toBe("STACK_DEPTH_EXCEEDED");
    }
  });
});

describe("subgraph — conditional subgraph", () => {
  it("skips subgraph when condition is false", async () => {
    const engine = makeEngine(
      "parent-conditional-subgraph.workflow.yaml",
      "child-review.workflow.yaml",
    );
    await engine.start("parent-conditional", { skipReview: true });

    const result = await engine.advance("done"); // → maybe-review
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // Subgraph should NOT be pushed because skipReview == true
      expect(result.subgraphPushed).toBeUndefined();
      expect(result.currentNode).toBe("maybe-review");
    }
  });

  it("pushes subgraph when condition is true", async () => {
    const engine = makeEngine(
      "parent-conditional-subgraph.workflow.yaml",
      "child-review.workflow.yaml",
    );
    await engine.start("parent-conditional"); // skipReview defaults to false

    const result = await engine.advance("done"); // → maybe-review, condition true → push
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.subgraphPushed).toBeDefined();
      expect(result.subgraphPushed!.graphId).toBe("child-review");
    }
  });
});

describe("subgraph — child works identically standalone vs as subgraph", () => {
  it("child graph traverses the same way standalone", async () => {
    const engine = makeEngine("child-review.workflow.yaml");
    const startResult = await engine.start("child-review");
    expect(startResult.currentNode).toBe("check-security");

    engine.contextSet({ securityPass: true });
    const a1 = await engine.advance("done");
    expect(a1.isError).toBe(false);
    if (!a1.isError) expect(a1.currentNode).toBe("check-tests");

    engine.contextSet({ testsPass: true, approved: true });
    const a2 = await engine.advance("done");
    expect(a2.isError).toBe(false);
    if (!a2.isError) expect(a2.currentNode).toBe("review-gate");

    const a3 = await engine.advance("approved");
    expect(a3.isError).toBe(false);
    if (!a3.isError) {
      expect(a3.status).toBe("complete");
      expect(a3.currentNode).toBe("complete");
    }
  });
});

// =============================================================================
// LOADER VALIDATION TESTS
// =============================================================================

describe("subgraph — loader validation", () => {
  it("rejects circular subgraph references", async () => {
    expect(() =>
      loadFixtures(
        "invalid-circular-subgraph-a.workflow.yaml",
        "invalid-circular-subgraph-b.workflow.yaml",
      ),
    ).toThrow(/circular/i);
  });

  it("rejects subgraph referencing unknown graph", async () => {
    // parent-with-subgraph references child-review, which we don't load
    expect(() => loadFixtures("parent-with-subgraph.workflow.yaml")).toThrow(/unknown graph/i);
  });

  it("accepts valid subgraph references", async () => {
    const graphs = loadFixtures("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    expect(graphs.size).toBe(2);
  });
});

// =============================================================================
// SHORTHAND contextMap / returnMap — Array Syntax (#21)
// =============================================================================

describe("subgraph — shorthand array syntax for contextMap/returnMap", () => {
  it("loads graph with array shorthand contextMap and returnMap", async () => {
    const graphs = loadFixtures(
      "parent-shorthand-maps.workflow.yaml",
      "child-review.workflow.yaml",
    );
    expect(graphs.has("parent-shorthand")).toBe(true);

    // Verify normalization: arrays expanded to {key: key} objects
    const def = graphs.get("parent-shorthand")!.definition;
    const reviewNode = def.nodes.review;
    expect(reviewNode.subgraph).toBeDefined();
    expect(reviewNode.subgraph!.contextMap).toEqual({ securityPass: "securityPass" });
    expect(reviewNode.subgraph!.returnMap).toEqual({ approved: "approved" });
  });

  it("shorthand contextMap copies context correctly at push", async () => {
    const engine = makeEngine("parent-shorthand-maps.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-shorthand");
    engine.contextSet({ securityPass: true });

    const result = await engine.advance("work-done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.subgraphPushed).toBeDefined();
      // securityPass should be copied to child's securityPass (same name)
      expect(result.context.securityPass).toBe(true);
    }
  });

  it("shorthand returnMap copies context correctly at pop", async () => {
    const engine = makeEngine("parent-shorthand-maps.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-shorthand");
    engine.contextSet({ securityPass: true });
    await engine.advance("work-done"); // pushes child

    // Complete child graph
    await engine.advance("done"); // check-security → check-tests
    engine.contextSet({ testsPass: true, approved: true });
    await engine.advance("done"); // → review-gate
    const result = await engine.advance("approved"); // → complete (terminal) → pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("subgraph_complete");
      // approved should be copied back to parent's approved (same name)
      expect(result.context.approved).toBe(true);
    }
  });
});

describe("subgraph — shorthand schema validation", () => {
  it("rejects mixed array elements (non-string)", async () => {
    // graphDefinitionSchema imported at top of file
    const graph = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          subgraph: {
            graphId: "child",
            contextMap: ["valid", 123],
          },
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };
    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(false);
  });

  it("accepts object syntax alongside shorthand (backward compat)", async () => {
    // graphDefinitionSchema imported at top of file
    const graph = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          subgraph: {
            graphId: "child",
            contextMap: { parentKey: "childKey" },
            returnMap: ["sameNameField"],
          },
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };
    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(true);
    if (result.success) {
      const sub = result.data.nodes.start.subgraph!;
      expect(sub.contextMap).toEqual({ parentKey: "childKey" });
      expect(sub.returnMap).toEqual({ sameNameField: "sameNameField" });
    }
  });
});

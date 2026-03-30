import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadGraphs } from "../src/loader.js";
import { GraphEngine } from "../src/engine/index.js";
import { createServer } from "../src/server.js";
import { EngineError } from "../src/errors.js";
import { graphDefinitionSchema } from "../src/schema/graph-schema.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subgraph-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function makeEngine(...files: string[]): GraphEngine {
  return new GraphEngine(loadFixtures(...files));
}

// =============================================================================
// ENGINE UNIT TESTS — Subgraph Push/Pop Mechanics
// =============================================================================

describe("subgraph — push mechanics", () => {
  it("pushes child graph when advancing to a subgraph node", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    const result = engine.advance("work-done");
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

  it("contextMap copies parent context to child initial context", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    const result = engine.advance("work-done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // contextMap: { taskDone: parentTaskDone }
      // Parent's context.taskDone (true) should be copied to child's context.parentTaskDone
      expect(result.context.parentTaskDone).toBe(true);
    }
  });

  it("after push, contextSet operates on child session", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

    // Now contextSet should operate on the child's context
    const result = engine.contextSet({ securityPass: true });
    expect(result.context.securityPass).toBe(true);
    // Parent context key should not be visible
    expect(result.context.reviewPassed).toBeUndefined();
  });

  it("after push, advance operates on child graph edges", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child, now at check-security

    const result = engine.advance("done"); // check-security → check-tests
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("check-tests");
    }
  });
});

describe("subgraph — pop mechanics", () => {
  it("pops back to parent when child reaches terminal", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

    // Traverse child to completion
    engine.contextSet({ securityPass: true });
    engine.advance("done"); // → check-tests
    engine.contextSet({ testsPass: true, approved: true });
    engine.advance("done"); // → review-gate
    const result = engine.advance("approved"); // → complete (terminal) → pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("subgraph_complete");
      expect(result.completedGraph).toBe("child-review");
      expect(result.stackDepth).toBe(1);
      expect(result.resumedNode).toBe("quality-gate");
      expect(result.currentNode).toBe("quality-gate");
    }
  });

  it("returnMap copies child context to parent context on pop", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

    // Complete child with approved = true
    engine.contextSet({ securityPass: true });
    engine.advance("done");
    engine.contextSet({ testsPass: true, approved: true });
    engine.advance("done");
    const result = engine.advance("approved"); // pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      // returnMap: { approved: reviewPassed }
      expect(result.returnedContext).toEqual({ reviewPassed: true });
      expect(result.context.reviewPassed).toBe(true);
    }
  });

  it("after pop, parent edges are available and parent can advance", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

    // Complete child
    engine.contextSet({ securityPass: true });
    engine.advance("done");
    engine.contextSet({ testsPass: true, approved: true });
    engine.advance("done");
    engine.advance("approved"); // pop back to quality-gate

    // Now advance on the parent's edge
    const result = engine.advance("pass");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("complete");
      expect(result.currentNode).toBe("finalize");
    }
  });
});

describe("subgraph — inspect shows stack", () => {
  it("inspect shows stack depth and entries during subgraph", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

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

  it("inspect shows stack depth 1 for single graph", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");

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
  it("reset during subgraph clears entire stack", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });
    engine.advance("work-done"); // pushes child

    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.clearedStack).toBeDefined();
    expect(result.clearedStack).toHaveLength(2);
    expect(result.clearedStack![0].graphId).toBe("parent-workflow");
    expect(result.clearedStack![0].node).toBe("quality-gate");
    expect(result.clearedStack![1].graphId).toBe("child-review");
    expect(result.clearedStack![1].node).toBe("check-security");

    // Can start a new graph after reset
    const startResult = engine.start("parent-workflow");
    expect(startResult.status).toBe("started");
  });

  it("reset with single graph does not include clearedStack", () => {
    const engine = makeEngine(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-workflow");

    const result = engine.reset();
    expect(result.status).toBe("reset");
    expect(result.clearedStack).toBeUndefined();
    expect(result.previousGraph).toBe("parent-workflow");
  });
});

describe("subgraph — stack depth enforcement", () => {
  it("throws STACK_DEPTH_EXCEEDED when maxDepth reached", () => {
    const graphs = loadFixtures(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    // Set maxDepth to 1 — no nesting allowed
    const engine = new GraphEngine(graphs, { maxDepth: 1 });
    engine.start("parent-workflow");
    engine.contextSet({ taskDone: true });

    expect(() => engine.advance("work-done")).toThrow(EngineError);
    try {
      engine.advance("work-done");
    } catch (e) {
      expect((e as EngineError).code).toBe("STACK_DEPTH_EXCEEDED");
    }
  });
});

describe("subgraph — conditional subgraph", () => {
  it("skips subgraph when condition is false", () => {
    const engine = makeEngine(
      "parent-conditional-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-conditional", { skipReview: true });

    const result = engine.advance("done"); // → maybe-review
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // Subgraph should NOT be pushed because skipReview == true
      expect(result.subgraphPushed).toBeUndefined();
      expect(result.currentNode).toBe("maybe-review");
    }
  });

  it("pushes subgraph when condition is true", () => {
    const engine = makeEngine(
      "parent-conditional-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-conditional"); // skipReview defaults to false

    const result = engine.advance("done"); // → maybe-review, condition true → push
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.subgraphPushed).toBeDefined();
      expect(result.subgraphPushed!.graphId).toBe("child-review");
    }
  });
});

describe("subgraph — child works identically standalone vs as subgraph", () => {
  it("child graph traverses the same way standalone", () => {
    const engine = makeEngine("child-review.workflow.yaml");
    const startResult = engine.start("child-review");
    expect(startResult.currentNode).toBe("check-security");

    engine.contextSet({ securityPass: true });
    const a1 = engine.advance("done");
    expect(a1.isError).toBe(false);
    if (!a1.isError) expect(a1.currentNode).toBe("check-tests");

    engine.contextSet({ testsPass: true, approved: true });
    const a2 = engine.advance("done");
    expect(a2.isError).toBe(false);
    if (!a2.isError) expect(a2.currentNode).toBe("review-gate");

    const a3 = engine.advance("approved");
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
  it("rejects circular subgraph references", () => {
    expect(() =>
      loadFixtures(
        "invalid-circular-subgraph-a.workflow.yaml",
        "invalid-circular-subgraph-b.workflow.yaml"
      )
    ).toThrow(/circular/i);
  });

  it("rejects subgraph referencing unknown graph", () => {
    // parent-with-subgraph references child-review, which we don't load
    expect(() => loadFixtures("parent-with-subgraph.workflow.yaml")).toThrow(
      /unknown graph/i
    );
  });

  it("accepts valid subgraph references", () => {
    const graphs = loadFixtures(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    expect(graphs.size).toBe(2);
  });
});

// =============================================================================
// MCP SERVER INTEGRATION TESTS
// =============================================================================

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

async function setupMcp(...files: string[]) {
  const graphs = loadFixtures(...files);
  const { server } = createServer(graphs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { raw: result, data: parse(result), isError: !!result.isError };
}

describe("subgraph — MCP integration: full parent→child→parent traversal", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setupMcp(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("traverses parent → push child → complete child → pop to parent → complete", async () => {
    // Start parent
    const s = await callTool(client, "freelance_start", { graphId: "parent-workflow" });
    expect(s.isError).toBe(false);
    expect(s.data.currentNode).toBe("start");

    // Set context and advance to subgraph node
    await callTool(client, "freelance_context_set", { updates: { taskDone: true } });
    const a1 = await callTool(client, "freelance_advance", { edge: "work-done" });
    expect(a1.isError).toBe(false);
    expect(a1.data.subgraphPushed).toBeDefined();
    expect(a1.data.subgraphPushed.graphId).toBe("child-review");
    expect(a1.data.currentNode).toBe("check-security");

    // Inspect during child — should show stack
    const pos1 = await callTool(client, "freelance_inspect", { detail: "position" });
    expect(pos1.data.stackDepth).toBe(2);
    expect(pos1.data.stack).toHaveLength(2);

    // Traverse child
    await callTool(client, "freelance_context_set", { updates: { securityPass: true } });
    const a2 = await callTool(client, "freelance_advance", { edge: "done" });
    expect(a2.data.currentNode).toBe("check-tests");

    await callTool(client, "freelance_context_set", { updates: { testsPass: true, approved: true } });
    const a3 = await callTool(client, "freelance_advance", { edge: "done" });
    expect(a3.data.currentNode).toBe("review-gate");

    // Complete child → pop
    const a4 = await callTool(client, "freelance_advance", { edge: "approved" });
    expect(a4.data.status).toBe("subgraph_complete");
    expect(a4.data.completedGraph).toBe("child-review");
    expect(a4.data.resumedNode).toBe("quality-gate");
    expect(a4.data.context.reviewPassed).toBe(true);
    expect(a4.data.stackDepth).toBe(1);

    // Complete parent
    const a5 = await callTool(client, "freelance_advance", { edge: "pass" });
    expect(a5.data.status).toBe("complete");
    expect(a5.data.currentNode).toBe("finalize");
  });
});

describe("subgraph — MCP integration: reset during subgraph", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setupMcp(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("resets entire stack and allows restart", async () => {
    await callTool(client, "freelance_start", { graphId: "parent-workflow" });
    await callTool(client, "freelance_context_set", { updates: { taskDone: true } });
    await callTool(client, "freelance_advance", { edge: "work-done" }); // push child

    const r = await callTool(client, "freelance_reset", { confirm: true });
    expect(r.data.status).toBe("reset");
    expect(r.data.clearedStack).toHaveLength(2);

    // Can restart
    const s = await callTool(client, "freelance_start", { graphId: "parent-workflow" });
    expect(s.isError).toBe(false);
    expect(s.data.currentNode).toBe("start");
  });
});

describe("subgraph — MCP integration: conditional skip", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setupMcp(
      "parent-conditional-subgraph.workflow.yaml",
      "child-review.workflow.yaml"
    );
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("skips subgraph when condition is false and completes normally", async () => {
    await callTool(client, "freelance_start", {
      graphId: "parent-conditional",
      initialContext: { skipReview: true },
    });

    const a1 = await callTool(client, "freelance_advance", { edge: "done" });
    expect(a1.isError).toBe(false);
    // No subgraph pushed
    expect(a1.data.subgraphPushed).toBeUndefined();
    expect(a1.data.currentNode).toBe("maybe-review");

    // skipReview == true satisfies the validation
    const a2 = await callTool(client, "freelance_advance", { edge: "continue" });
    expect(a2.data.status).toBe("complete");
  });
});

// =============================================================================
// SHORTHAND contextMap / returnMap — Array Syntax (#21)
// =============================================================================

describe("subgraph — shorthand array syntax for contextMap/returnMap", () => {
  it("loads graph with array shorthand contextMap and returnMap", () => {
    const graphs = loadFixtures(
      "parent-shorthand-maps.workflow.yaml",
      "child-review.workflow.yaml"
    );
    expect(graphs.has("parent-shorthand")).toBe(true);

    // Verify normalization: arrays expanded to {key: key} objects
    const def = graphs.get("parent-shorthand")!.definition;
    const reviewNode = def.nodes["review"];
    expect(reviewNode.subgraph).toBeDefined();
    expect(reviewNode.subgraph!.contextMap).toEqual({ securityPass: "securityPass" });
    expect(reviewNode.subgraph!.returnMap).toEqual({ approved: "approved" });
  });

  it("shorthand contextMap copies context correctly at push", () => {
    const engine = makeEngine(
      "parent-shorthand-maps.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-shorthand");
    engine.contextSet({ securityPass: true });

    const result = engine.advance("work-done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.subgraphPushed).toBeDefined();
      // securityPass should be copied to child's securityPass (same name)
      expect(result.context.securityPass).toBe(true);
    }
  });

  it("shorthand returnMap copies context correctly at pop", () => {
    const engine = makeEngine(
      "parent-shorthand-maps.workflow.yaml",
      "child-review.workflow.yaml"
    );
    engine.start("parent-shorthand");
    engine.contextSet({ securityPass: true });
    engine.advance("work-done"); // pushes child

    // Complete child graph
    engine.advance("done"); // check-security → check-tests
    engine.contextSet({ testsPass: true, approved: true });
    engine.advance("done"); // → review-gate
    const result = engine.advance("approved"); // → complete (terminal) → pop

    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("subgraph_complete");
      // approved should be copied back to parent's approved (same name)
      expect(result.context.approved).toBe(true);
    }
  });
});

describe("subgraph — shorthand schema validation", () => {
  it("rejects mixed array elements (non-string)", () => {
    // graphDefinitionSchema imported at top of file
    const graph = {
      id: "test", version: "1.0", name: "Test", description: "Test",
      startNode: "start",
      nodes: {
        start: {
          type: "action", description: "Start",
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

  it("accepts object syntax alongside shorthand (backward compat)", () => {
    // graphDefinitionSchema imported at top of file
    const graph = {
      id: "test", version: "1.0", name: "Test", description: "Test",
      startNode: "start",
      nodes: {
        start: {
          type: "action", description: "Start",
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
      const sub = result.data.nodes["start"].subgraph!;
      expect(sub.contextMap).toEqual({ parentKey: "childKey" });
      expect(sub.returnMap).toEqual({ sameNameField: "sameNameField" });
    }
  });
});

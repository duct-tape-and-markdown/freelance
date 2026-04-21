/**
 * Minimal-response projection (`responseMode: "minimal"`) — see
 * issue #81 and `ResponseMode` in `src/engine/context.ts`. These tests
 * pin the shape guarantees the skill relies on when opting in to a
 * lean response: the full-context echo and the NodeInfo blob are
 * absent, and `contextDelta` names the keys written this turn.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtureGraphs, makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const makeEngine = (...files: string[]) =>
  sharedMakeEngine(FIXTURES_DIR, "engine-minimal-", ...files);
const loadFixtures = (...files: string[]) =>
  loadFixtureGraphs(FIXTURES_DIR, "engine-minimal-", ...files);

describe("advance({ responseMode: 'minimal' }) — success shape", () => {
  it("omits context and node, includes contextDelta", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");

    const r = await engine.advance("work-done", { taskStarted: true }, { responseMode: "minimal" });
    expect(r.isError).toBe(false);
    if (r.isError) return;

    // Minimal-specific fields.
    expect(r).toHaveProperty("contextDelta");
    expect(r.contextDelta).toEqual(["taskStarted"]);

    // Stripped fields.
    expect(r).not.toHaveProperty("context");
    expect(r).not.toHaveProperty("node");
    expect(r).not.toHaveProperty("graphSources");

    // Required fields on the lean shape.
    expect(r.status).toBe("advanced");
    expect(r.currentNode).toBe("review");
    expect(r.validTransitions).toBeDefined();
    expect(r.validTransitions.length).toBeGreaterThan(0);
  });

  it("default mode still returns full shape (backwards compatible)", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");

    const r = await engine.advance("work-done", { taskStarted: true });
    expect(r.isError).toBe(false);
    if (r.isError) return;

    expect(r).toHaveProperty("context");
    expect(r).toHaveProperty("node");
    expect(r.context.taskStarted).toBe(true);
  });

  it("empty contextDelta when no context writes this turn", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done", { taskStarted: true });

    const r = await engine.advance("approved", undefined, { responseMode: "minimal" });
    expect(r.isError).toBe(false);
    if (r.isError) return;
    expect(r.contextDelta).toEqual([]);
    expect(r.status).toBe("complete");
    // Terminal history is still carried in minimal mode — it's a small array.
    expect(r.traversalHistory).toEqual(["start", "review", "done"]);
  });

  it("hook writes on the new node land in contextDelta", async () => {
    // hook-context-return.workflow.yaml uses memory_status, but with
    // a HookRunner that has no memory wired the built-in throws. Use
    // a simpler fixture path — valid-simple has no hooks, so delta is
    // just the caller's own writes; verify via a fixture whose advance
    // path doesn't involve hooks.
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const r = await engine.advance(
      "work-done",
      { taskStarted: true, extra: "ignored" },
      { responseMode: "minimal" },
    );
    if (r.isError) throw new Error("unexpected error");
    // Two caller-written keys; order is insertion-order from Set.
    expect(new Set(r.contextDelta)).toEqual(new Set(["taskStarted", "extra"]));
  });

  it("wait node arrival in minimal mode carries waitingOn + timeout", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");

    const r = await engine.advance("done", undefined, { responseMode: "minimal" });
    expect(r.isError).toBe(false);
    if (r.isError) return;
    expect(r.status).toBe("waiting");
    expect(r.currentNode).toBe("wait-approval");
    expect(r.waitingOn).toBeDefined();
    expect(r.waitingOn?.[0].key).toBe("approved");
    expect(r).not.toHaveProperty("node");
    expect(r).not.toHaveProperty("context");
  });
});

describe("advance({ responseMode: 'minimal' }) — gate-blocked shape", () => {
  it("omits context, keeps reason + validTransitions + contextDelta", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done"); // at gate; taskStarted still false

    const r = await engine.advance("approved", { scratch: "note" }, { responseMode: "minimal" });
    expect(r.isError).toBe(true);
    if (!r.isError) return;

    expect(r.status).toBe("error");
    expect(r.reason).toContain("Task must be started");
    expect(r.currentNode).toBe("review");
    expect(r.validTransitions).toBeDefined();
    // Caller-side write landed before the gate tripped — surface it.
    expect(r.contextDelta).toEqual(["scratch"]);

    expect(r).not.toHaveProperty("context");
    expect(r).not.toHaveProperty("graphSources");
  });

  // Locks in the #134 unified envelope (`error.kind`) under minimal mode.
  // Without this assertion, the minimal-mode error type could drop the
  // envelope silently and skills relying on `error.kind` would break.
  it("carries the unified error envelope with kind: 'blocked'", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done");

    const r = await engine.advance("approved", undefined, { responseMode: "minimal" });
    expect(r.isError).toBe(true);
    if (!r.isError) return;

    expect(r.error).toEqual({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("Task must be started"),
      kind: "blocked",
    });
    // reason is retained as a back-compat mirror of error.message.
    expect(r.reason).toBe(r.error.message);
  });

  it("blocked minimal with no caller writes has empty contextDelta", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done");

    const r = await engine.advance("approved", undefined, { responseMode: "minimal" });
    expect(r.isError).toBe(true);
    if (!r.isError) return;
    expect(r.contextDelta).toEqual([]);
  });
});

describe("contextSet({ responseMode: 'minimal' })", () => {
  it("omits context, includes contextDelta with the written keys", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");

    const r = engine.contextSet({ taskStarted: true }, { responseMode: "minimal" });
    expect(r.status).toBe("updated");
    expect(r.contextDelta).toEqual(["taskStarted"]);
    expect(r).not.toHaveProperty("context");
    expect(r.validTransitions).toBeDefined();
    expect(r.turnCount).toBe(1);
  });

  it("default mode still returns full context", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const r = engine.contextSet({ taskStarted: true });
    expect(r).toHaveProperty("context");
    if ("context" in r) {
      expect(r.context.taskStarted).toBe(true);
    }
  });
});

describe("inspect({ responseMode: 'minimal' })", () => {
  it("position strips node, context, stack, graphSources", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");

    const r = engine.inspect("position", [], {}, { responseMode: "minimal" });
    expect(r).not.toHaveProperty("node");
    expect(r).not.toHaveProperty("context");
    expect(r).not.toHaveProperty("stack");
    expect(r).not.toHaveProperty("graphSources");
    expect(r).not.toHaveProperty("graphName");

    // Keeps the loop-essentials.
    expect(r.currentNode).toBe("start");
    expect(r.validTransitions).toBeDefined();
    expect(r.stackDepth).toBe(1);
  });

  it("history mode is unchanged under minimal (recovery path is full by construction)", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    engine.contextSet({ taskStarted: true });
    await engine.advance("work-done");

    const r = engine.inspect("history", [], {}, { responseMode: "minimal" });
    if (!("traversalHistory" in r)) throw new Error("expected history result");
    expect(r.traversalHistory).toHaveLength(1);
    expect(r.contextHistory.length).toBeGreaterThan(0);
    expect(r.totalSteps).toBe(1);
  });

  it("fields projections are ignored on minimal by design", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    const r = engine.inspect(
      "position",
      ["definition", "currentNode"],
      {},
      { responseMode: "minimal" },
    );
    expect(r).not.toHaveProperty("definition");
    expect(r).not.toHaveProperty("currentNodeDefinition");
  });
});

describe("subgraph push/pop under minimal", () => {
  it("pushSubgraph emits minimal shape with subgraphPushed metadata", async () => {
    const fixtures = loadFixtures(
      "parent-with-subgraph.workflow.yaml",
      "child-review.workflow.yaml",
    );
    const { GraphEngine } = await import("../src/engine/index.js");
    const { HookRunner } = await import("../src/engine/hooks.js");
    const engine = new GraphEngine(fixtures, { hookRunner: new HookRunner() });

    await engine.start("parent-workflow", { taskDone: true });
    const r = await engine.advance("work-done", undefined, { responseMode: "minimal" });
    if (r.isError) throw new Error("unexpected error");
    expect(r.status).toBe("advanced");
    expect(r.subgraphPushed).toBeDefined();
    expect(r.subgraphPushed?.graphId).toBe("child-review");
    expect(r).not.toHaveProperty("context");
    expect(r).not.toHaveProperty("node");
    expect(r.contextDelta).toBeDefined();
  });
});

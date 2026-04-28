/**
 * End-to-end traversal scenarios driven directly against `GraphEngine`.
 *
 * Exercises the spec-example workflows (data-pipeline, change-request)
 * through complete paths — gate enforcement, cycle behavior, recovery
 * from blocked advances, reset, and compaction recovery via `inspect`.
 * Engine-direct: the CLI and any agent-facing surface wrap the same
 * methods, so the behavior locked in here is what every caller sees.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import type { InspectPositionResult, TransitionInfo } from "../src/types.js";
import { loadFixtureGraphs } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function newEngine(): GraphEngine {
  const graphs = loadFixtureGraphs(
    FIXTURES_DIR,
    "integ-test-",
    "data-pipeline.workflow.yaml",
    "change-request.workflow.yaml",
  );
  return new GraphEngine(graphs, { hookRunner: new HookRunner() });
}

function position(engine: GraphEngine): InspectPositionResult {
  return engine.inspect("position") as InspectPositionResult;
}

function edge(transitions: readonly TransitionInfo[], label: string): TransitionInfo {
  const t = transitions.find((x) => x.label === label);
  if (!t) throw new Error(`expected validTransition with label "${label}"`);
  return t;
}

// =============================================================================
// DATA PIPELINE
// =============================================================================

describe("Data pipeline — happy path (full traversal)", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });
  afterEach(() => {
    engine.reset();
  });

  it("traverses from scan-sources to complete", async () => {
    // 1. list
    const list = engine.list();
    expect(list.graphs.some((g) => g.id === "data-pipeline")).toBe(true);

    // 2. Start
    const s = await engine.start("data-pipeline");
    expect(s.isError).toBe(false);
    expect(s.currentNode).toBe("scan-sources");

    // 3. Set sourceCount
    const ctx1 = engine.contextSet({ sourceCount: 10 });
    expect(ctx1.context.sourceCount).toBe(10);

    // 4. scan-complete → assess
    const a1 = await engine.advance("scan-complete");
    expect(a1.isError).toBe(false);
    if (a1.isError) return;
    expect(a1.currentNode).toBe("assess");

    // 5. Set remainingItems, check conditionMet
    const ctx2 = engine.contextSet({ remainingItems: 5 });
    expect(edge(ctx2.validTransitions, "gaps-found").conditionMet).toBe(true);

    // 6. gaps-found → plan
    const a2 = await engine.advance("gaps-found");
    expect(a2.isError).toBe(false);
    if (a2.isError) return;
    expect(a2.currentNode).toBe("plan");

    // 7. plan-ready → execute
    const a3 = await engine.advance("plan-ready");
    expect(a3.isError).toBe(false);
    if (a3.isError) return;
    expect(a3.currentNode).toBe("execute");

    // 8. Set processedCount, check turnCount
    const ctx3 = engine.contextSet({ processedCount: 5 });
    expect(ctx3.turnCount).toBe(1);

    // 9. batch-complete → verify
    const a4 = await engine.advance("batch-complete");
    expect(a4.isError).toBe(false);
    if (a4.isError) return;
    expect(a4.currentNode).toBe("verify");

    // 10. Set verification context
    const ctx4 = engine.contextSet({ verificationPassed: true, qualityScore: 90 });
    expect(edge(ctx4.validTransitions, "verified").conditionMet).toBe(true);

    // 11. verified → cycle-check
    const a5 = await engine.advance("verified");
    expect(a5.isError).toBe(false);
    if (a5.isError) return;
    expect(a5.currentNode).toBe("cycle-check");

    // 12. Exhaust cycle, take done edge
    const ctx5 = engine.contextSet({ cycleCount: 1, remainingItems: 0 });
    expect(edge(ctx5.validTransitions, "done").conditionMet).toBe(true);

    // 13. done → complete
    const a6 = await engine.advance("done");
    expect(a6.isError).toBe(false);
    if (a6.isError) return;
    expect(a6.status).toBe("complete");
    expect(a6.traversalHistory).toBeDefined();
    expect(a6.traversalHistory!.length).toBeGreaterThan(1);
  });
});

describe("Data pipeline — gate enforcement", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("blocks advance until both validations pass", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });
    await engine.advance("scan-complete");
    await engine.advance("gaps-found");
    await engine.advance("plan-ready");
    await engine.advance("batch-complete");
    // Now at verify

    engine.contextSet({ verificationPassed: false, qualityScore: 50 });

    const fail1 = await engine.advance("verified");
    expect(fail1.isError).toBe(true);
    if (fail1.isError) {
      expect(fail1.error.message).toContain("verification failed");
    }

    engine.contextSet({ verificationPassed: true });
    const fail2 = await engine.advance("verified");
    expect(fail2.isError).toBe(true);
    if (fail2.isError) {
      expect(fail2.error.message).toContain("Quality score");
    }

    engine.contextSet({ qualityScore: 85 });
    const pass = await engine.advance("verified");
    expect(pass.isError).toBe(false);
    if (!pass.isError) expect(pass.currentNode).toBe("cycle-check");
  });
});

describe("Data pipeline — cycle behavior", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("cycles back to assess and eventually completes", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });
    await engine.advance("scan-complete");
    await engine.advance("gaps-found");
    await engine.advance("plan-ready");
    engine.contextSet({ processedCount: 5 });
    await engine.advance("batch-complete");
    engine.contextSet({ verificationPassed: true, qualityScore: 90 });
    await engine.advance("verified");
    // At cycle-check

    engine.contextSet({ cycleCount: 1, remainingItems: 3 });
    const pos1 = position(engine);
    expect(edge(pos1.validTransitions, "more-cycles").conditionMet).toBe(true);

    const cyc = await engine.advance("more-cycles");
    expect(cyc.isError).toBe(false);
    if (!cyc.isError) expect(cyc.currentNode).toBe("assess");

    // Work through to cycle-check again
    engine.contextSet({ remainingItems: 2 });
    await engine.advance("gaps-found");
    await engine.advance("plan-ready");
    engine.contextSet({ processedCount: 7 });
    await engine.advance("batch-complete");
    engine.contextSet({ verificationPassed: true, qualityScore: 95 });
    await engine.advance("verified");
    // At cycle-check again

    engine.contextSet({ cycleCount: 3, remainingItems: 3 });
    const pos2 = position(engine);
    expect(edge(pos2.validTransitions, "more-cycles").conditionMet).toBe(false);
    expect(edge(pos2.validTransitions, "done").conditionMet).toBe(true);

    const fin = await engine.advance("done");
    expect(fin.isError).toBe(false);
    if (!fin.isError) expect(fin.status).toBe("complete");
  });
});

describe("Data pipeline — skip-to-verify path", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("skips plan/execute when remainingItems == 0", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 5 });
    await engine.advance("scan-complete");
    engine.contextSet({ remainingItems: 0 });

    const pos = position(engine);
    expect(edge(pos.validTransitions, "all-current").conditionMet).toBe(true);

    const a = await engine.advance("all-current");
    expect(a.isError).toBe(false);
    if (!a.isError) expect(a.currentNode).toBe("verify");
  });
});

// =============================================================================
// CHANGE REQUEST
// =============================================================================

describe("Change request — standard path", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("traverses classify → setup-standard → implement → quality-gate → finalize → complete", async () => {
    await engine.start("change-request");
    engine.contextSet({ changeType: "standard" });

    const a1 = await engine.advance("standard");
    if (!a1.isError) expect(a1.currentNode).toBe("setup-standard");

    engine.contextSet({ targetBranch: "develop" });

    const a2 = await engine.advance("ready");
    if (!a2.isError) expect(a2.currentNode).toBe("implement");

    engine.contextSet({ testsPass: true, lintPass: true });

    const a3 = await engine.advance("done");
    if (!a3.isError) expect(a3.currentNode).toBe("quality-gate");

    const a4 = await engine.advance("pass");
    if (!a4.isError) expect(a4.currentNode).toBe("finalize");

    engine.contextSet({ outputUrl: "https://example.com/pr/1" });

    const a5 = await engine.advance("finalized");
    if (!a5.isError) {
      expect(a5.currentNode).toBe("complete");
      expect(a5.status).toBe("complete");
    }
  });
});

describe("Change request — urgent path", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("routes through setup-urgent then completes normally", async () => {
    await engine.start("change-request");
    engine.contextSet({ changeType: "urgent" });

    const a1 = await engine.advance("urgent");
    if (!a1.isError) expect(a1.currentNode).toBe("setup-urgent");

    engine.contextSet({ targetBranch: "hotfix/prod" });
    const a2 = await engine.advance("ready");
    if (!a2.isError) expect(a2.currentNode).toBe("implement");

    engine.contextSet({ testsPass: true, lintPass: true });
    await engine.advance("done");
    await engine.advance("pass");

    engine.contextSet({ outputUrl: "https://example.com/hotfix/1" });
    const fin = await engine.advance("finalized");
    if (!fin.isError) expect(fin.status).toBe("complete");
  });
});

describe("Change request — gate failure and recovery loop", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("fails at quality-gate, recovers by fixing context, then passes", async () => {
    await engine.start("change-request");
    engine.contextSet({ changeType: "standard" });
    await engine.advance("standard");
    engine.contextSet({ targetBranch: "develop" });
    await engine.advance("ready");
    engine.contextSet({ testsPass: false, lintPass: true });
    await engine.advance("done");
    // At quality-gate

    const fail = await engine.advance("pass");
    expect(fail.isError).toBe(true);
    if (fail.isError) {
      expect(fail.error.message).toContain("Tests must pass");
    }

    // Fix the issue and pass the gate.
    engine.contextSet({ testsPass: true });

    const pass = await engine.advance("pass");
    expect(pass.isError).toBe(false);
    if (!pass.isError) expect(pass.currentNode).toBe("finalize");
  });
});

describe("Change request — scope check detour", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("detours through scope-check and returns to implement", async () => {
    await engine.start("change-request");
    engine.contextSet({ changeType: "cosmetic" });
    await engine.advance("cosmetic");
    await engine.advance("ready");
    // At implement

    engine.contextSet({ scopeQuestionRaised: true });
    const pos = position(engine);
    expect(edge(pos.validTransitions, "scope-question").conditionMet).toBe(true);

    const a1 = await engine.advance("scope-question");
    if (!a1.isError) expect(a1.currentNode).toBe("scope-check");

    engine.contextSet({ scopeQuestionRaised: false });
    const a2 = await engine.advance("out-of-scope");
    if (!a2.isError) expect(a2.currentNode).toBe("implement");
  });
});

describe("Change request — validation blocks missing target branch", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("blocks advance from setup-standard without targetBranch", async () => {
    await engine.start("change-request");
    engine.contextSet({ changeType: "standard" });
    await engine.advance("standard");
    // At setup-standard, targetBranch still null

    const fail = await engine.advance("ready");
    expect(fail.isError).toBe(true);
    if (fail.isError) {
      expect(fail.error.message).toContain("Target branch must be set");
    }
  });
});

// =============================================================================
// CROSS-CUTTING
// =============================================================================

describe("Compaction recovery simulation", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("inspect provides enough info to continue after context loss", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });
    await engine.advance("scan-complete");
    await engine.advance("gaps-found");
    // At plan

    // Simulate compaction — agent calls inspect to re-orient
    const pos = position(engine);
    expect(pos.currentNode).toBe("plan");
    expect(pos.node.instructions).toBeDefined();
    expect(pos.validTransitions.length).toBeGreaterThan(0);
    expect(pos.context.remainingItems).toBe(5);

    const hist = engine.inspect("history");
    if ("traversalHistory" in hist) {
      expect(hist.traversalHistory.length).toBe(2);
      expect(hist.traversalHistory[0].node).toBe("scan-sources");
      expect(hist.traversalHistory[1].node).toBe("assess");
    }

    // Continue using only info from inspect
    const a = await engine.advance(pos.validTransitions[0].label);
    expect(a.isError).toBe(false);
    if (!a.isError) expect(a.currentNode).toBe("execute");
  });
});

describe("Reset and restart", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("resets mid-traversal and starts a different graph", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 5 });
    await engine.advance("scan-complete");

    const r = engine.reset();
    expect(r.status).toBe("reset");
    expect(r.previousGraph).toBe("data-pipeline");

    const s = await engine.start("change-request");
    expect(s.isError).toBe(false);
    expect(s.currentNode).toBe("classify");

    // Advance to completion
    engine.contextSet({ changeType: "cosmetic" });
    await engine.advance("cosmetic");
    await engine.advance("ready");
    engine.contextSet({ testsPass: true, lintPass: true });
    await engine.advance("done");
    await engine.advance("pass");
    engine.contextSet({ outputUrl: "https://example.com" });
    const fin = await engine.advance("finalized");
    if (!fin.isError) expect(fin.status).toBe("complete");
  });
});

describe("Context updates persist on failed advance", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = newEngine();
  });

  it("preserves contextUpdates even when validation blocks advance", async () => {
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });
    await engine.advance("scan-complete");
    await engine.advance("gaps-found");
    await engine.advance("plan-ready");
    await engine.advance("batch-complete");
    // At verify, validations will fail

    const fail = await engine.advance("verified", {
      verificationPassed: false,
      qualityScore: 42,
    });
    expect(fail.isError).toBe(true);

    // Context was updated despite failure.
    const pos = position(engine);
    expect(pos.context.qualityScore).toBe(42);
    expect(pos.context.verificationPassed).toBe(false);
  });
});

/**
 * Re-arrival NodeInfo elision (issue #227). Full-mode `advance` ships
 * the `node` blob (instructions, suggestedTools, sources) on first
 * arrival to a node and omits it on re-arrival within the same
 * traversal — the agent recovers from earlier transcript or
 * `freelance inspect`. These tests pin the wire-shape contract that
 * agents and the SKILL.md framing rely on.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const makeEngine = (...files: string[]) =>
  sharedMakeEngine(FIXTURES_DIR, "engine-rearrival-", ...files);

describe("advance — full-mode NodeInfo elision on re-arrival", () => {
  it("ships node on first arrival, omits it on re-arrival via cycle", async () => {
    const engine = makeEngine("data-pipeline.workflow.yaml");
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });

    // First arrival at `assess`.
    const firstAssess = await engine.advance("scan-complete");
    expect(firstAssess.isError).toBe(false);
    if (firstAssess.isError) return;
    expect(firstAssess.currentNode).toBe("assess");
    expect(firstAssess).toHaveProperty("node");
    expect(firstAssess.node?.instructions).toContain("Compare cataloged sources");

    // Walk back to `assess` via the cycle: assess → plan → execute → verify → cycle-check → assess.
    await engine.advance("gaps-found");
    await engine.advance("plan-ready");
    engine.contextSet({ processedCount: 5 });
    await engine.advance("batch-complete");
    engine.contextSet({ verificationPassed: true, qualityScore: 90 });
    await engine.advance("verified");
    engine.contextSet({ cycleCount: 1, remainingItems: 3 });

    const reArrival = await engine.advance("more-cycles");
    expect(reArrival.isError).toBe(false);
    if (reArrival.isError) return;
    expect(reArrival.currentNode).toBe("assess");
    expect(reArrival).not.toHaveProperty("node");

    // Context echo and validTransitions still present — full mode contract.
    expect(reArrival).toHaveProperty("context");
    expect(reArrival.validTransitions.length).toBeGreaterThan(0);
  });

  it("minimal mode is unchanged — node never present regardless of arrival", async () => {
    const engine = makeEngine("data-pipeline.workflow.yaml");
    await engine.start("data-pipeline");
    engine.contextSet({ sourceCount: 10, remainingItems: 5 });

    const r = await engine.advance("scan-complete", undefined, { responseMode: "minimal" });
    expect(r.isError).toBe(false);
    if (r.isError) return;
    expect(r).not.toHaveProperty("node");
    expect(r).toHaveProperty("contextDelta");
  });

  it("subgraph pop ships parent host's node — agent only saw child startNode on push", async () => {
    const engine = makeEngine("parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await engine.start("parent-workflow");

    // start → quality-gate triggers subgraph push; response carries child startNode,
    // not the host's. The host (`quality-gate`) was never a departure point in the
    // parent frame — `history` contains only `start`.
    const push = await engine.advance("work-done", { taskDone: true });
    expect(push.isError).toBe(false);
    if (push.isError) return;
    expect(push.subgraphPushed?.graphId).toBe("child-review");

    // Walk the child to its terminal so it pops back to the parent host.
    engine.contextSet({ securityPass: true });
    await engine.advance("done");
    engine.contextSet({ testsPass: true });
    await engine.advance("done");
    engine.contextSet({ approved: true });
    const pop = await engine.advance("approved");
    expect(pop.isError).toBe(false);
    if (pop.isError) return;
    expect(pop.status).toBe("subgraph_complete");
    expect(pop.currentNode).toBe("quality-gate");
    // Host's node info was never delivered during the push — ship it now.
    expect(pop).toHaveProperty("node");
    expect(pop.node?.description).toBe("Run quality checks via subgraph");
  });
});

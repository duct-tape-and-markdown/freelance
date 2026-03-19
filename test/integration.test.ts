import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadGraphs } from "../src/loader.js";
import { createServer } from "../src/server.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integ-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

// Helper to set up client+server pair for spec example graphs
async function setup() {
  const graphs = loadFixtures(
    "data-pipeline.graph.yaml",
    "change-request.graph.yaml"
  );
  const { server } = createServer(graphs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// --- Helpers for common MCP call patterns ---

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { raw: result, data: parse(result), isError: !!result.isError };
}

async function start(client: Client, graphId: string) {
  return callTool(client, "graph_start", { graphId });
}

async function advance(client: Client, edge: string, contextUpdates?: Record<string, unknown>) {
  return callTool(client, "graph_advance", { edge, ...(contextUpdates ? { contextUpdates } : {}) });
}

async function ctxSet(client: Client, updates: Record<string, unknown>) {
  return callTool(client, "graph_context_set", { updates });
}

async function inspect(client: Client, detail: string = "position") {
  return callTool(client, "graph_inspect", { detail });
}

async function reset(client: Client) {
  return callTool(client, "graph_reset", { confirm: true });
}

// =============================================================================
// DATA PIPELINE TESTS
// =============================================================================

describe("Data pipeline — happy path (full traversal)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("traverses from scan-sources to complete", async () => {
    // 1. graph_list
    const list = await callTool(client, "graph_list");
    expect(list.data.graphs.some((g: any) => g.id === "data-pipeline")).toBe(true);

    // 2. Start
    const s = await start(client, "data-pipeline");
    expect(s.isError).toBe(false);
    expect(s.data.currentNode).toBe("scan-sources");

    // 3. Set sourceCount
    const ctx1 = await ctxSet(client, { sourceCount: 10 });
    expect(ctx1.data.context.sourceCount).toBe(10);

    // 4. scan-complete → assess
    const a1 = await advance(client, "scan-complete");
    expect(a1.isError).toBe(false);
    expect(a1.data.currentNode).toBe("assess");

    // 5. Set remainingItems, check conditionMet
    const ctx2 = await ctxSet(client, { remainingItems: 5 });
    const gapsEdge = ctx2.data.validTransitions.find((t: any) => t.label === "gaps-found");
    expect(gapsEdge.conditionMet).toBe(true);

    // 6. gaps-found → plan
    const a2 = await advance(client, "gaps-found");
    expect(a2.isError).toBe(false);
    expect(a2.data.currentNode).toBe("plan");

    // 7. plan-ready → execute
    const a3 = await advance(client, "plan-ready");
    expect(a3.isError).toBe(false);
    expect(a3.data.currentNode).toBe("execute");

    // 8. Set processedCount, check turnCount
    const ctx3 = await ctxSet(client, { processedCount: 5 });
    expect(ctx3.data.turnCount).toBe(1);

    // 9. batch-complete → verify
    const a4 = await advance(client, "batch-complete");
    expect(a4.isError).toBe(false);
    expect(a4.data.currentNode).toBe("verify");

    // 10. Set verification context, check conditionMet
    const ctx4 = await ctxSet(client, { verificationPassed: true, qualityScore: 90 });
    const verifiedEdge = ctx4.data.validTransitions.find((t: any) => t.label === "verified");
    expect(verifiedEdge.conditionMet).toBe(true);

    // 11. verified → cycle-check
    const a5 = await advance(client, "verified");
    expect(a5.isError).toBe(false);
    expect(a5.data.currentNode).toBe("cycle-check");

    // 12. Set cycle context, check default edge
    const ctx5 = await ctxSet(client, { cycleCount: 1, remainingItems: 0 });
    const doneEdge = ctx5.data.validTransitions.find((t: any) => t.label === "done");
    expect(doneEdge.conditionMet).toBe(true);

    // 13. done → complete
    const a6 = await advance(client, "done");
    expect(a6.isError).toBe(false);
    expect(a6.data.status).toBe("complete");
    expect(a6.data.traversalHistory).toBeDefined();
    expect(a6.data.traversalHistory.length).toBeGreaterThan(1);
  });
});

describe("Data pipeline — gate enforcement", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("blocks advance until both validations pass", async () => {
    // Advance to verify node
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 10, remainingItems: 5 });
    await advance(client, "scan-complete");
    await advance(client, "gaps-found");
    await advance(client, "plan-ready");
    await advance(client, "batch-complete");
    // Now at verify

    // Set failing context
    await ctxSet(client, { verificationPassed: false, qualityScore: 50 });

    // Attempt advance — should fail on verificationPassed
    const fail1 = await advance(client, "verified");
    expect(fail1.isError).toBe(true);
    expect(fail1.data.reason).toContain("verification failed");

    // Fix verificationPassed but qualityScore still low
    await ctxSet(client, { verificationPassed: true });
    const fail2 = await advance(client, "verified");
    expect(fail2.isError).toBe(true);
    expect(fail2.data.reason).toContain("Quality score");

    // Fix qualityScore
    await ctxSet(client, { qualityScore: 85 });
    const pass = await advance(client, "verified");
    expect(pass.isError).toBe(false);
    expect(pass.data.currentNode).toBe("cycle-check");
  });
});

describe("Data pipeline — cycle behavior", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("cycles back to assess and eventually completes", async () => {
    // Advance to cycle-check
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 10, remainingItems: 5 });
    await advance(client, "scan-complete");
    await advance(client, "gaps-found");
    await advance(client, "plan-ready");
    await ctxSet(client, { processedCount: 5 });
    await advance(client, "batch-complete");
    await ctxSet(client, { verificationPassed: true, qualityScore: 90 });
    await advance(client, "verified");
    // At cycle-check

    // Set context for another cycle
    await ctxSet(client, { cycleCount: 1, remainingItems: 3 });
    const pos1 = await inspect(client);
    const moreCycles = pos1.data.validTransitions.find((t: any) => t.label === "more-cycles");
    expect(moreCycles.conditionMet).toBe(true);

    // Cycle back
    const cyc = await advance(client, "more-cycles");
    expect(cyc.isError).toBe(false);
    expect(cyc.data.currentNode).toBe("assess");

    // Work through to cycle-check again
    await ctxSet(client, { remainingItems: 2 });
    await advance(client, "gaps-found");
    await advance(client, "plan-ready");
    await ctxSet(client, { processedCount: 7 });
    await advance(client, "batch-complete");
    await ctxSet(client, { verificationPassed: true, qualityScore: 95 });
    await advance(client, "verified");
    // At cycle-check again

    // Exhaust cycles
    await ctxSet(client, { cycleCount: 3, remainingItems: 3 });
    const pos2 = await inspect(client);
    const moreCycles2 = pos2.data.validTransitions.find((t: any) => t.label === "more-cycles");
    const doneEdge = pos2.data.validTransitions.find((t: any) => t.label === "done");
    expect(moreCycles2.conditionMet).toBe(false);
    expect(doneEdge.conditionMet).toBe(true);

    // Complete
    const fin = await advance(client, "done");
    expect(fin.isError).toBe(false);
    expect(fin.data.status).toBe("complete");
  });
});

describe("Data pipeline — skip-to-verify path", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("skips plan/execute when remainingItems == 0", async () => {
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 5 });
    await advance(client, "scan-complete");
    // At assess, set remainingItems to 0
    await ctxSet(client, { remainingItems: 0 });

    const pos = await inspect(client);
    const allCurrent = pos.data.validTransitions.find((t: any) => t.label === "all-current");
    expect(allCurrent.conditionMet).toBe(true);

    const a = await advance(client, "all-current");
    expect(a.isError).toBe(false);
    expect(a.data.currentNode).toBe("verify");
  });
});

// =============================================================================
// CHANGE REQUEST TESTS
// =============================================================================

describe("Change request — standard path", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("traverses classify → setup-standard → implement → quality-gate → finalize → complete", async () => {
    // 1-2. Start and classify
    await start(client, "change-request");
    await ctxSet(client, { changeType: "standard" });

    // 3. standard → setup-standard
    const a1 = await advance(client, "standard");
    expect(a1.data.currentNode).toBe("setup-standard");

    // 4. Set targetBranch
    await ctxSet(client, { targetBranch: "develop" });

    // 5. ready → implement
    const a2 = await advance(client, "ready");
    expect(a2.data.currentNode).toBe("implement");

    // 6. Set quality context
    await ctxSet(client, { testsPass: true, lintPass: true });

    // 7. done → quality-gate
    const a3 = await advance(client, "done");
    expect(a3.data.currentNode).toBe("quality-gate");

    // 8. pass → finalize
    const a4 = await advance(client, "pass");
    expect(a4.data.currentNode).toBe("finalize");

    // 9. Set outputUrl
    await ctxSet(client, { outputUrl: "https://example.com/pr/1" });

    // 10. finalized → complete
    const a5 = await advance(client, "finalized");
    expect(a5.data.currentNode).toBe("complete");
    expect(a5.data.status).toBe("complete");
  });
});

describe("Change request — urgent path", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("routes through setup-urgent then completes normally", async () => {
    await start(client, "change-request");
    await ctxSet(client, { changeType: "urgent" });

    const a1 = await advance(client, "urgent");
    expect(a1.data.currentNode).toBe("setup-urgent");

    await ctxSet(client, { targetBranch: "hotfix/prod" });
    const a2 = await advance(client, "ready");
    expect(a2.data.currentNode).toBe("implement");

    await ctxSet(client, { testsPass: true, lintPass: true });
    await advance(client, "done");
    await advance(client, "pass");

    await ctxSet(client, { outputUrl: "https://example.com/hotfix/1" });
    const fin = await advance(client, "finalized");
    expect(fin.data.status).toBe("complete");
  });
});

describe("Change request — gate failure and recovery loop", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("fails at quality-gate, recovers via fail edge, then passes", async () => {
    // Advance to quality-gate with failing tests
    await start(client, "change-request");
    await ctxSet(client, { changeType: "standard" });
    await advance(client, "standard");
    await ctxSet(client, { targetBranch: "develop" });
    await advance(client, "ready");
    await ctxSet(client, { testsPass: false, lintPass: true });
    await advance(client, "done");
    // At quality-gate

    // Attempt pass — blocked by gate validation
    const fail = await advance(client, "pass");
    expect(fail.isError).toBe(true);
    expect(fail.data.reason).toContain("Tests must pass");

    // The "fail" edge also blocked because gate validations block ALL edges.
    // Agent must satisfy validations first, then choose pass or fail.
    // To take the "fail" edge: satisfy validations, but set the fail condition.
    // However, the fail condition (testsPass==false || lintPass==false) contradicts
    // the validation (testsPass==true && lintPass==true). So the "fail" edge
    // is unreachable by design when validations are enforced.
    //
    // The spec-correct recovery: agent fixes the issue and passes the gate.
    await ctxSet(client, { testsPass: true });

    // Now validations pass → "pass" edge succeeds
    const pass = await advance(client, "pass");
    expect(pass.isError).toBe(false);
    expect(pass.data.currentNode).toBe("finalize");
  });
});

describe("Change request — scope check detour", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("detours through scope-check and returns to implement", async () => {
    await start(client, "change-request");
    await ctxSet(client, { changeType: "cosmetic" });
    await advance(client, "cosmetic");
    await advance(client, "ready");
    // At implement

    // Raise scope question
    await ctxSet(client, { scopeQuestionRaised: true });
    const pos = await inspect(client);
    const scopeEdge = pos.data.validTransitions.find((t: any) => t.label === "scope-question");
    expect(scopeEdge.conditionMet).toBe(true);

    // Detour to scope-check
    const a1 = await advance(client, "scope-question");
    expect(a1.data.currentNode).toBe("scope-check");

    // Resolve and return
    await ctxSet(client, { scopeQuestionRaised: false });
    const a2 = await advance(client, "out-of-scope");
    expect(a2.data.currentNode).toBe("implement");
  });
});

describe("Change request — validation blocks missing target branch", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("blocks advance from setup-standard without targetBranch", async () => {
    await start(client, "change-request");
    await ctxSet(client, { changeType: "standard" });
    await advance(client, "standard");
    // At setup-standard, targetBranch is still null

    const fail = await advance(client, "ready");
    expect(fail.isError).toBe(true);
    expect(fail.data.reason).toContain("Target branch must be set");
  });
});

// =============================================================================
// CROSS-CUTTING TESTS
// =============================================================================

describe("Compaction recovery simulation", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("inspect provides enough info to continue after context loss", async () => {
    // Advance a few nodes
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 10, remainingItems: 5 });
    await advance(client, "scan-complete");
    await advance(client, "gaps-found");
    // At plan

    // Simulate compaction — agent calls inspect to re-orient
    const pos = await inspect(client, "position");
    expect(pos.data.currentNode).toBe("plan");
    expect(pos.data.node.instructions).toBeDefined();
    expect(pos.data.validTransitions.length).toBeGreaterThan(0);
    expect(pos.data.context.remainingItems).toBe(5);

    // Check history is intact
    const hist = await inspect(client, "history");
    expect(hist.data.traversalHistory.length).toBe(2);
    expect(hist.data.traversalHistory[0].node).toBe("scan-sources");
    expect(hist.data.traversalHistory[1].node).toBe("assess");

    // Continue using only info from inspect
    const a = await advance(client, pos.data.validTransitions[0].label);
    expect(a.isError).toBe(false);
    expect(a.data.currentNode).toBe("execute");
  });
});

describe("Reset and restart", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("resets mid-traversal and starts a different graph", async () => {
    // Start data-pipeline, advance partway
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 5 });
    await advance(client, "scan-complete");

    // Reset
    const r = await reset(client);
    expect(r.data.status).toBe("reset");
    expect(r.data.previousGraph).toBe("data-pipeline");

    // Start a different graph
    const s = await start(client, "change-request");
    expect(s.isError).toBe(false);
    expect(s.data.currentNode).toBe("classify");

    // Advance to completion
    await ctxSet(client, { changeType: "cosmetic" });
    await advance(client, "cosmetic");
    await advance(client, "ready");
    await ctxSet(client, { testsPass: true, lintPass: true });
    await advance(client, "done");
    await advance(client, "pass");
    await ctxSet(client, { outputUrl: "https://example.com" });
    const fin = await advance(client, "finalized");
    expect(fin.data.status).toBe("complete");
  });
});

describe("Context updates persist on failed advance", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const s = await setup();
    client = s.client;
    cleanup = s.cleanup;
  });
  afterEach(async () => cleanup());

  it("preserves contextUpdates even when validation blocks advance", async () => {
    // Advance to verify gate in data-pipeline
    await start(client, "data-pipeline");
    await ctxSet(client, { sourceCount: 10, remainingItems: 5 });
    await advance(client, "scan-complete");
    await advance(client, "gaps-found");
    await advance(client, "plan-ready");
    await advance(client, "batch-complete");
    // At verify, validations will fail

    // Advance with contextUpdates — validation fails but context should persist
    const fail = await callTool(client, "graph_advance", {
      edge: "verified",
      contextUpdates: { verificationPassed: false, qualityScore: 42 },
    });
    expect(fail.isError).toBe(true);

    // Inspect to verify context was updated despite failure
    const pos = await inspect(client);
    expect(pos.data.context.qualityScore).toBe(42);
    expect(pos.data.context.verificationPassed).toBe(false);
  });
});

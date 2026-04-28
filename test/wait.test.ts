import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphEngine } from "../src/engine/index.js";
import { loadGraphs } from "../src/loader.js";
import type { AdvanceSuccessResult, InspectPositionResult, ValidatedGraph } from "../src/types.js";
import { loadFixtureGraphs, makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

const loadFixtures = (...files: string[]): Map<string, ValidatedGraph> =>
  loadFixtureGraphs(FIXTURES_DIR, "wait-test-", ...files);
const makeEngine = (...files: string[]): GraphEngine =>
  sharedMakeEngine(FIXTURES_DIR, "wait-test-", ...files);

describe("wait nodes — arriving at wait node", () => {
  it("returns status 'waiting' when advancing to a wait node", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");

    const result = await engine.advance("done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("waiting");
      expect(result.currentNode).toBe("wait-approval");
      expect(result.node.type).toBe("wait");
    }
  });

  it("includes waitingOn conditions in result", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");

    const result = (await engine.advance("done")) as AdvanceSuccessResult;
    expect(result.waitingOn).toBeDefined();
    expect(result.waitingOn).toHaveLength(1);
    expect(result.waitingOn![0].key).toBe("approved");
    expect(result.waitingOn![0].type).toBe("boolean");
    expect(result.waitingOn![0].satisfied).toBe(false);
  });

  it("includes timeout and timeoutAt when timeout is specified", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");

    const result = (await engine.advance("submitted")) as AdvanceSuccessResult;
    expect(result.status).toBe("waiting");
    expect(result.timeout).toBe("24h");
    expect(result.timeoutAt).toBeDefined();
    // timeoutAt should be ~24h from now
    const timeoutAt = new Date(result.timeoutAt!).getTime();
    const now = Date.now();
    expect(timeoutAt).toBeGreaterThan(now + 23 * 3600 * 1000);
    expect(timeoutAt).toBeLessThan(now + 25 * 3600 * 1000);
  });
});

describe("wait nodes — blocking advance", () => {
  it("blocks advance when conditions are not satisfied", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done"); // now at wait-approval

    const result = await engine.advance("proceed");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.error.message).toContain("Waiting for external signals");
      expect(result.error.message).toContain("approved");
      expect(result.error.code).toBe("WAIT_BLOCKING");
      expect(result.error.kind).toBe("blocked");
    }
  });

  it("blocks when only some conditions are satisfied", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted"); // now at await-ci

    // Set only one of two required conditions
    engine.contextSet({ ciPassed: true });

    const result = await engine.advance("ready");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.error.message).toContain("coverageReport");
    }
  });

  it("context updates persist even when advance is blocked", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done");

    const result = await engine.advance("proceed", { extra: "data" });
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.context.extra).toBe("data");
    }
  });
});

describe("wait nodes — signal delivery and unblocking", () => {
  it("allows advance after all conditions are satisfied via contextSet", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done"); // at wait-approval

    // External signal
    engine.contextSet({ approved: true });

    const result = await engine.advance("proceed");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("complete");
      expect(result.currentNode).toBe("complete");
    }
  });

  it("allows advance after all conditions satisfied (multi-key)", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // Deliver both signals
    engine.contextSet({ ciPassed: true, coverageReport: "https://ci.example.com/report" });

    const result = await engine.advance("ready");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.status).toBe("complete");
      expect(result.currentNode).toBe("merge");
    }
  });

  it("allows taking failure edge when wait conditions are met", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // CI failed
    engine.contextSet({ ciPassed: false, coverageReport: "https://ci.example.com/fail" });

    const result = await engine.advance("failed");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("fix-ci");
    }
  });

  it("contextSet is allowed at wait nodes", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done");

    // contextSet should work fine at wait nodes
    const result = engine.contextSet({ approved: true });
    expect(result.status).toBe("updated");
    expect(result.context.approved).toBe(true);
  });

  it("incremental signal delivery works", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // Deliver first signal
    engine.contextSet({ ciPassed: true });
    // Still blocked
    const blocked = await engine.advance("ready");
    expect(blocked.isError).toBe(true);

    // Deliver second signal
    engine.contextSet({ coverageReport: "https://report.url" });
    // Now unblocked
    const result = await engine.advance("ready");
    expect(result.isError).toBe(false);
  });
});

describe("wait nodes — inspect", () => {
  it("inspect shows waiting status when conditions not met", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done");

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.waitStatus).toBe("waiting");
    expect(result.waitingOn).toHaveLength(1);
    expect(result.waitingOn![0].key).toBe("approved");
    expect(result.waitingOn![0].satisfied).toBe(false);
  });

  it("inspect shows ready status when conditions are met", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done");
    engine.contextSet({ approved: true });

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.waitStatus).toBe("ready");
    expect(result.waitingOn![0].satisfied).toBe(true);
  });

  it("inspect shows timeout info for wait nodes with timeout", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.waitStatus).toBe("waiting");
    expect(result.timeout).toBe("24h");
    expect(result.timeoutAt).toBeDefined();
  });

  it("inspect at non-wait node has no wait fields", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.waitStatus).toBeUndefined();
    expect(result.waitingOn).toBeUndefined();
  });
});

describe("wait nodes — timeout", () => {
  it("timed_out status when timeout has elapsed", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // Manually set waitArrivedAt to the past to simulate timeout
    const stack = engine.getStack();
    stack[0].waitArrivedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25h ago
    engine.restoreStack(stack);

    // Inspect should show timed_out
    const inspect = engine.inspect("position") as InspectPositionResult;
    expect(inspect.waitStatus).toBe("timed_out");
    // The timeout flag lives on SessionState (waitTimedOutAt), not in
    // context — waitStatus is the public wire signal.
    expect(inspect.context._waitTimedOut).toBeUndefined();
  });

  it("advance is unblocked after timeout", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // Simulate timeout
    const stack = engine.getStack();
    stack[0].waitArrivedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    engine.restoreStack(stack);

    // Set ciPassed to false so we can take the "failed" edge
    engine.contextSet({ ciPassed: false, coverageReport: "timeout" });

    const result = await engine.advance("failed");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("fix-ci");
    }
  });

  it("stamps waitTimedOutAt on SessionState when the timeout fires", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // Simulate timeout
    const stack = engine.getStack();
    stack[0].waitArrivedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    engine.restoreStack(stack);

    // Inspect triggers checkWaitTimeout via computeWaitInfo
    engine.inspect("position");
    const after = engine.getStack();
    expect(after[0].waitTimedOutAt).toBeDefined();
    // Flag lives on SessionState, not context — confirms no bleed
    // into the wire shape or past strictContext / caps / contextHistory.
    expect(after[0].context._waitTimedOut).toBeUndefined();
  });

  it("does not timeout before duration elapses", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted");

    // waitArrivedAt is just now — should not be timed out
    const inspect = engine.inspect("position") as InspectPositionResult;
    expect(inspect.waitStatus).toBe("waiting");
    expect(inspect.context._waitTimedOut).toBeUndefined();
  });
});

describe("wait nodes — cycle support", () => {
  it("wait node in cycle is valid (fix-ci → await-ci cycle)", async () => {
    // valid-wait.workflow.yaml has fix-ci → await-ci cycle, which includes a wait node
    const graphs = loadFixtures("valid-wait.workflow.yaml");
    expect(graphs.has("valid-wait")).toBe(true);
  });

  it("can re-enter wait node after fixing", async () => {
    const engine = makeEngine("valid-wait.workflow.yaml");
    await engine.start("valid-wait");
    await engine.advance("submitted"); // at await-ci

    // Deliver failure
    engine.contextSet({ ciPassed: false, coverageReport: "fail" });
    await engine.advance("failed"); // at fix-ci

    // Resubmit — should arrive at wait node again
    const result = (await engine.advance("resubmitted")) as AdvanceSuccessResult;
    expect(result.status).toBe("waiting");
    expect(result.currentNode).toBe("await-ci");
  });
});

describe("wait nodes — loader validation", () => {
  function writeGraph(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-loader-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.workflow.yaml"), content);
    return tmpDir;
  }

  it("rejects wait node without waitOn", async () => {
    const dir = writeGraph(`
id: test-wait-no-waiton
version: "1.0.0"
name: "Test"
description: "Test"
startNode: start
nodes:
  start:
    type: wait
    description: "Wait"
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"
`);
    expect(() => loadGraphs(dir)).toThrow(/wait.*waitOn/i);
  });

  it("rejects wait node with empty waitOn array", async () => {
    const dir = writeGraph(`
id: test-wait-empty
version: "1.0.0"
name: "Test"
description: "Test"
startNode: start
nodes:
  start:
    type: wait
    description: "Wait"
    waitOn: []
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"
`);
    expect(() => loadGraphs(dir)).toThrow(/wait.*waitOn/i);
  });

  it("accepts valid wait node", async () => {
    const graphs = loadFixtures("valid-wait-simple.workflow.yaml");
    expect(graphs.has("valid-wait-simple")).toBe(true);
  });
});

describe("wait vs gate distinction", () => {
  it("gate can be satisfied by agent (contextSet + advance)", async () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    await engine.start("valid-simple");
    await engine.advance("work-done"); // at gate

    // Agent satisfies the gate itself
    engine.contextSet({ taskStarted: true });
    const result = await engine.advance("approved");
    expect(result.isError).toBe(false);
  });

  it("wait blocks advance until external signal", async () => {
    const engine = makeEngine("valid-wait-simple.workflow.yaml");
    await engine.start("valid-wait-simple");
    await engine.advance("done"); // at wait

    // Agent tries to advance without external signal → blocked
    const blocked = await engine.advance("proceed");
    expect(blocked.isError).toBe(true);

    // External signal arrives
    engine.contextSet({ approved: true });

    // Now advance works
    const result = await engine.advance("proceed");
    expect(result.isError).toBe(false);
  });
});

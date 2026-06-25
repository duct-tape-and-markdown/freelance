import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphEngine } from "../src/engine/index.js";
import type { InspectPositionResult } from "../src/types.js";
import { makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const makeEngine = (...files: string[]): GraphEngine =>
  sharedMakeEngine(FIXTURES_DIR, "wait-reentry-test-", ...files);

/**
 * #272: `waitArrivedAt` / `waitTimedOutAt` are a pair scoped to the
 * CURRENT wait occupancy. After wait-a times out and the traversal
 * moves on, arriving fresh at wait-b must NOT inherit wait-a's
 * `waitTimedOutAt` latch (which would short-circuit
 * `evaluateWaitTimeout` and bypass wait-b's gate instantly).
 */
describe("wait re-entry — timeout latch does not leak (#272)", () => {
  it("a later wait node is not reported timed_out by a prior wait's latch", async () => {
    const engine = makeEngine("wait-reentry.workflow.yaml");
    await engine.start("wait-reentry");
    await engine.advance("goA"); // at wait-a

    // Force wait-a to time out.
    const stack = engine.getStack();
    stack[0].waitArrivedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    engine.restoreStack(stack);

    // Advance to wait-b: wait-a's gate is bypassed by its (genuine)
    // timeout, which latches waitTimedOutAt during the advance. Fresh
    // arrival at wait-b must clear it.
    const arrived = await engine.advance("toB");
    expect(arrived.isError).toBe(false);
    if (!arrived.isError) {
      expect(arrived.currentNode).toBe("wait-b");
      // Pre-fix: the leaked latch reports this brand-new wait as
      // timed_out instantly.
      expect(arrived.status).toBe("waiting");
    }

    // The latch was cleared on fresh arrival; waitArrivedAt is fresh.
    const after = engine.getStack();
    expect(after[0].waitTimedOutAt).toBeUndefined();
    expect(after[0].currentNode).toBe("wait-b");

    // Inspect agrees: waiting, not timed_out.
    const inspect = engine.inspect("position") as InspectPositionResult;
    expect(inspect.waitStatus).toBe("waiting");

    // And the gate still blocks since signalB is unmet and wait-b's
    // own 24h timeout has not elapsed.
    const blocked = await engine.advance("finish");
    expect(blocked.isError).toBe(true);
    if (blocked.isError) {
      expect(blocked.error.code).toBe("WAIT_BLOCKING");
      expect(blocked.error.message).toContain("signalB");
    }
  });
});

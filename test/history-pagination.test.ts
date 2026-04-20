import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphEngine } from "../src/engine/index.js";
import type { InspectHistoryResult } from "../src/types.js";
import { makeEngine as sharedMakeEngine } from "./helpers.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const makeEngine = (...files: string[]): GraphEngine =>
  sharedMakeEngine(FIXTURES_DIR, "history-pag-test-", ...files);

async function walkBranching(): Promise<GraphEngine> {
  // Drive a traversal that stops at quality-check (before the terminal
  // pass edge, which would GC the stack). Produces 5 transitions and 3
  // context writes — enough material for pagination slices without
  // terminating the traversal.
  const engine = makeEngine("valid-branching.workflow.yaml");
  await engine.start("valid-branching");
  engine.contextSet({ path: "left" });
  await engine.advance("initialized");
  await engine.advance("go-left");
  await engine.advance("left-done");
  engine.contextSet({ qualityPassed: false });
  await engine.advance("redo");
  await engine.advance("left-done");
  engine.contextSet({ qualityPassed: true });
  // Don't take "pass" — that would GC the stack on terminal.
  return engine;
}

describe("history default: snapshots stripped, returns totals", () => {
  it("traversalHistory entries omit contextSnapshot by default", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history") as InspectHistoryResult;
    expect(result.traversalHistory.length).toBeGreaterThan(0);
    for (const entry of result.traversalHistory) {
      expect(entry.contextSnapshot).toBeUndefined();
      expect(entry.node).toBeDefined();
      expect(entry.edge).toBeDefined();
    }
  });

  it("includes totalSteps and totalContextWrites", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history") as InspectHistoryResult;
    expect(result.totalSteps).toBe(result.traversalHistory.length);
    expect(result.totalContextWrites).toBe(result.contextHistory.length);
    expect(result.totalSteps).toBeGreaterThan(0);
    expect(result.totalContextWrites).toBeGreaterThan(0);
  });
});

describe("history with includeSnapshots: true", () => {
  it("each entry has contextSnapshot populated", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", [], {
      includeSnapshots: true,
    }) as InspectHistoryResult;
    for (const entry of result.traversalHistory) {
      expect(entry.contextSnapshot).toBeDefined();
      expect(typeof entry.contextSnapshot).toBe("object");
    }
  });
});

describe("history pagination", () => {
  it("default limit is 50 (no slicing on short traversals)", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history") as InspectHistoryResult;
    // walkBranching produces ~7 steps — well under 50
    expect(result.traversalHistory.length).toBe(result.totalSteps);
  });

  it("respects limit", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", [], { limit: 2 }) as InspectHistoryResult;
    expect(result.traversalHistory.length).toBe(2);
    expect(result.contextHistory.length).toBeLessThanOrEqual(2);
    // totals still report the full count
    expect(result.totalSteps).toBeGreaterThan(2);
  });

  it("respects offset", async () => {
    const engine = await walkBranching();
    const full = engine.inspect("history") as InspectHistoryResult;
    expect(full.traversalHistory.length).toBeGreaterThanOrEqual(3);
    const page = engine.inspect("history", [], {
      offset: 2,
      limit: 1,
    }) as InspectHistoryResult;
    expect(page.traversalHistory.length).toBe(1);
    expect(page.traversalHistory[0].node).toBe(full.traversalHistory[2].node);
  });

  it("empty page when offset >= total", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", [], { offset: 9999 }) as InspectHistoryResult;
    expect(result.traversalHistory).toEqual([]);
    expect(result.contextHistory).toEqual([]);
    expect(result.totalSteps).toBeGreaterThan(0);
  });

  it("clamps limit above max to 200", async () => {
    const engine = await walkBranching();
    // Just sanity-check that a very large limit doesn't blow up
    const result = engine.inspect("history", [], { limit: 99999 }) as InspectHistoryResult;
    expect(result.traversalHistory.length).toBe(result.totalSteps);
  });

  it("clamps limit below 1 to 1", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", [], { limit: 0 }) as InspectHistoryResult;
    expect(result.traversalHistory.length).toBe(1);
  });

  it("clamps negative offset to 0", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", [], { offset: -5 }) as InspectHistoryResult;
    expect(result.totalSteps).toBe(result.traversalHistory.length);
  });
});

describe("history pagination composes with fields", () => {
  it("fields and pagination options can be combined", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("history", ["currentNode"], {
      limit: 3,
      includeSnapshots: true,
    }) as InspectHistoryResult;
    expect(result.traversalHistory.length).toBe(3);
    expect(result.traversalHistory[0].contextSnapshot).toBeDefined();
    expect(result.currentNodeDefinition).toBeDefined();
  });
});

describe("non-history detail ignores historyOpts", () => {
  it("position detail doesn't leak historyOpts into response", async () => {
    const engine = await walkBranching();
    const result = engine.inspect("position", [], { limit: 1, includeSnapshots: true });
    // position has no traversalHistory / totalSteps
    expect("traversalHistory" in result).toBe(false);
    expect("totalSteps" in result).toBe(false);
  });
});

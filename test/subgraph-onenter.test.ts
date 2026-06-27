import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HookRunner } from "../src/engine/hooks.js";
import { GraphEngine } from "../src/engine/index.js";
import { loadGraphs } from "../src/loader.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

// loadFixtureGraphs (helpers.ts) doesn't stage scripts; these fixtures
// use a local-script onEnter hook, so copy the script subtree too.
function stageWithScripts(graphFiles: string[], scripts: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subgraph-onenter-"));
  for (const g of graphFiles) {
    fs.copyFileSync(path.join(FIXTURES_DIR, g), path.join(tmpDir, g));
  }
  fs.mkdirSync(path.join(tmpDir, "scripts"));
  for (const s of scripts) {
    fs.copyFileSync(path.join(FIXTURES_DIR, "scripts", s), path.join(tmpDir, "scripts", s));
  }
  return loadGraphs(tmpDir);
}

const makeEngine = (): GraphEngine =>
  new GraphEngine(
    stageWithScripts(
      ["subgraph-onenter-parent.workflow.yaml", "subgraph-onenter-child.workflow.yaml"],
      ["set-count.js"],
    ),
    { hookRunner: new HookRunner() },
  );

// A subgraph node IS the post-edge target; Direction B fires its onEnter
// on arrival, against the parent session, before the push decision (#267).
describe("subgraph node onEnter fires on arrival (#267)", () => {
  it("fires before the push and the write flows into the child via contextMap", async () => {
    const engine = makeEngine();
    await engine.start("subgraph-onenter-parent");
    engine.contextSet({ shouldEnter: true });

    const result = await engine.advance("go");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      // Push happened…
      expect(result.subgraphPushed?.graphId).toBe("subgraph-onenter-child");
      expect(result.currentNode).toBe("child-start");
      // …and the dispatch node's onEnter wrote count=42 into the PARENT
      // context before maybePushSubgraph read contextMap {count: childCount},
      // so the value reached the child. Pre-fix the hook never fired and
      // childCount stayed at its declared default 0.
      expect(result.context.childCount).toBe(42);
    }
  });

  it("fires on the condition-not-met branch (no push), against parent context", async () => {
    const engine = makeEngine();
    await engine.start("subgraph-onenter-parent");
    // shouldEnter stays false → subgraph.condition is false → no push,
    // the traversal stays on the parent's dispatch node.
    const result = await engine.advance("go");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.subgraphPushed).toBeUndefined();
      expect(result.currentNode).toBe("dispatch");
      // onEnter still fired against the parent session.
      expect(result.context.count).toBe(42);
    }
  });
});

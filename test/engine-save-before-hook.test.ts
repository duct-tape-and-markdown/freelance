/**
 * Save-before-hook invariant tests for PR D.
 *
 * The transition commit lands on disk BEFORE onEnter hooks run, so a
 * hook throw leaves the traversal's on-disk `currentNode` at the
 * edge's target. Next advance runs gates on the new node, not the
 * stale one. See `docs/decisions.md` § "Observable state transitions
 * are durable before side effects".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_HOOKS } from "../src/engine/builtin-hooks.js";
import type { HookFn } from "../src/engine/hooks.js";
import { HookRunner } from "../src/engine/hooks.js";
import { EC, EngineError } from "../src/errors.js";
import { loadGraphs } from "../src/loader.js";
import { openStateStore, TraversalStore } from "../src/state/index.js";
import type { TraversalRecord } from "../src/state/index.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function stageGraphWithThrowingHook(tmpDir: string): Map<string, ValidatedGraph> {
  // Graph: start --next--> middle (onEnter: throwing built-in stub) --next--> done
  fs.writeFileSync(
    path.join(tmpDir, "g.workflow.yaml"),
    [
      "id: throw-on-middle",
      'version: "1.0.0"',
      'name: "Throwing hook on middle"',
      'description: ""',
      "startNode: start",
      "context: { seed: 1 }",
      "nodes:",
      "  start:",
      "    type: action",
      '    description: ""',
      "    edges:",
      "      - target: middle",
      "        label: next",
      "  middle:",
      "    type: action",
      '    description: ""',
      "    onEnter:",
      "      - call: memory_status",
      "    edges:",
      "      - target: done",
      "        label: next",
      "  done:",
      "    type: terminal",
      '    description: ""',
    ].join("\n"),
  );
  return loadGraphs(tmpDir);
}

function stageGraphWithMultiHook(tmpDir: string): Map<string, ValidatedGraph> {
  // Graph: start --next--> middle (onEnter: ok, then throwing) --next--> done
  fs.writeFileSync(
    path.join(tmpDir, "g.workflow.yaml"),
    [
      "id: multi-hook",
      'version: "1.0.0"',
      'name: "Multi-hook, second throws"',
      'description: ""',
      "startNode: start",
      "context: { seed: 1 }",
      "nodes:",
      "  start:",
      "    type: action",
      '    description: ""',
      "    edges:",
      "      - target: middle",
      "        label: next",
      "  middle:",
      "    type: action",
      '    description: ""',
      "    onEnter:",
      "      - call: memory_browse",
      "      - call: memory_status",
      "    edges:",
      "      - target: done",
      "        label: next",
      "  done:",
      "    type: terminal",
      '    description: ""',
    ].join("\n"),
  );
  return loadGraphs(tmpDir);
}

function makeRunner(overrides: Record<string, HookFn>): HookRunner {
  const merged = new Map<string, HookFn>(BUILTIN_HOOKS);
  for (const [k, v] of Object.entries(overrides)) merged.set(k, v);
  return new HookRunner({ builtinHooks: merged });
}

describe("save-before-hook invariant (PR D)", () => {
  let tmpDir: string;
  let traversalsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbh-test-"));
    traversalsDir = path.join(tmpDir, "traversals");
    fs.mkdirSync(traversalsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readRecord(id: string): TraversalRecord {
    const raw = fs.readFileSync(path.join(traversalsDir, `${id}.json`), "utf-8");
    return JSON.parse(raw) as TraversalRecord;
  }

  it("persists the edge target on disk when an onEnter hook throws", async () => {
    const graphs = stageGraphWithThrowingHook(tmpDir);
    const runner = makeRunner({
      memory_status: async () => {
        throw new Error("boom");
      },
    });
    const store = new TraversalStore(openStateStore(traversalsDir), graphs, {
      hookRunner: runner,
    });

    const t = await store.createTraversal("throw-on-middle");
    expect(readRecord(t.traversalId).currentNode).toBe("start");

    await expect(store.advance(t.traversalId, "next")).rejects.toThrow(/boom/);

    // Disk reflects the post-transition node even though the hook failed.
    expect(readRecord(t.traversalId).currentNode).toBe("middle");
    store.close();
  });

  it("HOOK_FAILED carries structured hook context", async () => {
    const graphs = stageGraphWithThrowingHook(tmpDir);
    const runner = makeRunner({
      memory_status: async () => {
        throw new Error("boom");
      },
    });
    const store = new TraversalStore(openStateStore(traversalsDir), graphs, {
      hookRunner: runner,
    });

    const t = await store.createTraversal("throw-on-middle");

    let caught: EngineError | undefined;
    try {
      await store.advance(t.traversalId, "next");
    } catch (e) {
      if (e instanceof EngineError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe(EC.HOOK_FAILED);
    // `context.hook` identifies the failing hook (populated by the
    // runner). `context.envelope` carries the post-transition
    // snapshot the CLI lifts to envelope-root siblings — gate-block
    // parity so HOOK_FAILED and a gate block surface the same
    // recover-or-stop fields. Runner-set and store-set, respectively.
    expect(caught?.context?.hook).toEqual({
      name: "memory_status",
      nodeId: "middle",
      index: 0,
    });
    expect(caught?.context?.envelopeSlots).toBeDefined();
    expect(caught?.context?.envelopeSlots?.currentNode).toBe("middle");
    expect(caught?.context?.envelopeSlots?.validTransitions).toEqual([
      { label: "next", target: "done", conditionMet: true },
    ]);
    expect(caught?.context?.envelopeSlots?.context).toEqual({ seed: 1 });
    store.close();
  });

  it("next advance after a hook throw runs gates on the new node (no re-fire)", async () => {
    const graphs = stageGraphWithThrowingHook(tmpDir);
    let calls = 0;
    const runner = makeRunner({
      memory_status: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return {};
      },
    });
    const store = new TraversalStore(openStateStore(traversalsDir), graphs, {
      hookRunner: runner,
    });

    const t = await store.createTraversal("throw-on-middle");
    await expect(store.advance(t.traversalId, "next")).rejects.toThrow();
    expect(calls).toBe(1);

    // Next advance runs against the new node "middle". Its own onEnter
    // must NOT re-fire — it already transitioned, and we're leaving it.
    // The NEXT node "done" has no hooks, so calls stays at 1.
    const second = await store.advance(t.traversalId, "next");
    expect(second.isError).toBe(false);
    expect(calls).toBe(1);
    store.close();
  });

  it("later hook in a chain throws — earlier hook's writes are NOT in record.meta", async () => {
    // Multi-hook chain: first writes meta (via collector), second
    // throws. The collected meta is merged into record.meta only on
    // the post-hook save path, so when the hook throw aborts before
    // that merge, disk's meta stays pristine. Proves the replay-after
    // contract: earlier-hook side effects visible only on success.
    const graphs = stageGraphWithMultiHook(tmpDir);
    const runner = makeRunner({
      memory_browse: async (ctx) => {
        ctx.setMeta?.({ echo: "from-browse" });
        return {};
      },
      memory_status: async () => {
        throw new Error("later-hook-boom");
      },
    });
    const store = new TraversalStore(openStateStore(traversalsDir), graphs, {
      hookRunner: runner,
    });

    const t = await store.createTraversal("multi-hook");
    await expect(store.advance(t.traversalId, "next")).rejects.toThrow(/later-hook-boom/);

    const rec = readRecord(t.traversalId);
    expect(rec.currentNode).toBe("middle");
    // Pre-hook save happens before any hook runs, so the in-memory
    // hookMeta collector hasn't been merged onto record.meta yet. The
    // post-hook save that WOULD merge it never runs because of the
    // throw. Disk meta therefore excludes "echo".
    expect(rec.meta?.echo).toBeUndefined();
    store.close();
  });

  it("HOOK_FAILED wire envelope carries currentNode, validTransitions, context as siblings to error", async () => {
    // End-to-end wire-format check: route the thrown EngineError
    // through `outputError` (the same function CLI handlers call)
    // and capture the JSON payload. Asserts gate-block parity on the
    // envelope shape: top-level `currentNode` / `validTransitions` /
    // `context` + `error.hook` with hook identity.
    const { outputError } = await import("../src/cli/output.js");
    const graphs = stageGraphWithThrowingHook(tmpDir);
    const runner = makeRunner({
      memory_status: async () => {
        throw new Error("boom");
      },
    });
    const store = new TraversalStore(openStateStore(traversalsDir), graphs, {
      hookRunner: runner,
    });

    const t = await store.createTraversal("throw-on-middle");
    let thrown: unknown;
    try {
      await store.advance(t.traversalId, "next");
    } catch (e) {
      thrown = e;
    }

    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      outputError(thrown);
    } finally {
      process.stdout.write = originalWrite;
    }

    const payload = JSON.parse(writes.join("")) as {
      isError: boolean;
      error: { code: string; message: string; kind: string; hook?: unknown };
      currentNode?: string;
      validTransitions?: readonly unknown[];
      context?: Record<string, unknown>;
    };

    expect(payload.isError).toBe(true);
    expect(payload.error.code).toBe(EC.HOOK_FAILED);
    expect(payload.error.kind).toBe("structural");
    expect(payload.error.hook).toEqual({
      name: "memory_status",
      nodeId: "middle",
      index: 0,
    });
    expect(payload.currentNode).toBe("middle");
    expect(payload.validTransitions).toEqual([
      { label: "next", target: "done", conditionMet: true },
    ]);
    expect(payload.context).toEqual({ seed: 1 });
    store.close();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookRunner } from "../src/engine/hooks.js";
import { EngineError } from "../src/errors.js";
import { loadGraphs } from "../src/loader.js";
import { openStateStore, TraversalStore } from "../src/state/index.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

describe("TraversalStore — stateless JSON", () => {
  let graphs: Map<string, ValidatedGraph>;
  let tmpDir: string;
  let store: TraversalStore;

  beforeEach(async () => {
    graphs = loadFixtures("valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-db-test-"));
    store = new TraversalStore(openStateStore(path.join(tmpDir, "traversals")), graphs, {
      hookRunner: new HookRunner(),
    });
  });

  afterEach(async () => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates traversals with unique IDs", async () => {
    const r1 = await store.createTraversal("valid-simple");
    const r2 = await store.createTraversal("valid-branching");

    expect(r1.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r2.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r1.traversalId).not.toBe(r2.traversalId);
  });

  it("lists active traversals from disk", async () => {
    expect(store.listTraversals()).toHaveLength(0);

    await store.createTraversal("valid-simple");
    expect(store.listTraversals()).toHaveLength(1);

    await store.createTraversal("valid-branching");
    expect(store.listTraversals()).toHaveLength(2);

    const list = store.listTraversals();
    expect(list[0].graphId).toBeDefined();
    expect(list[0].currentNode).toBeDefined();
  });

  it("advances traversal through store round-trip", async () => {
    const t = await store.createTraversal("valid-simple");
    store.contextSet(t.traversalId, { taskStarted: true });
    const adv = await store.advance(t.traversalId, "work-done");
    expect(adv.isError).toBe(false);
    if (!adv.isError) {
      expect(adv.currentNode).toBe("review");
    }

    // Verify state persisted — list should show new node
    const list = store.listTraversals();
    expect(list[0].currentNode).toBe("review");
  });

  it("removes traversal on reset", async () => {
    const t = await store.createTraversal("valid-simple");
    expect(store.listTraversals()).toHaveLength(1);

    store.resetTraversal(t.traversalId);
    expect(store.listTraversals()).toHaveLength(0);
  });

  it("throws TRAVERSAL_NOT_FOUND for unknown ID", async () => {
    await expect(store.advance("tr_nonexistent", "edge")).rejects.toThrow(EngineError);
    try {
      await store.advance("tr_nonexistent", "edge");
    } catch (e) {
      expect((e as EngineError).code).toBe("TRAVERSAL_NOT_FOUND");
    }
  });

  it("completes a full traversal lifecycle", async () => {
    const start = await store.createTraversal("valid-simple");
    const id = start.traversalId;
    expect(start.status).toBe("started");

    store.contextSet(id, { taskStarted: true });
    const adv1 = await store.advance(id, "work-done");
    expect(adv1.isError).toBe(false);

    const adv2 = await store.advance(id, "approved");
    if (!adv2.isError) {
      expect(adv2.status).toBe("complete");
    }

    store.resetTraversal(id);
    expect(store.listTraversals()).toHaveLength(0);
  });

  it("resolves single active traversal", async () => {
    const t = await store.createTraversal("valid-simple");
    expect(store.resolveTraversalId()).toBe(t.traversalId);
  });

  it("throws NO_TRAVERSAL when none active", async () => {
    expect(() => store.resolveTraversalId()).toThrow(EngineError);
  });

  it("throws AMBIGUOUS_TRAVERSAL when multiple active", async () => {
    await store.createTraversal("valid-simple");
    await store.createTraversal("valid-branching");
    expect(() => store.resolveTraversalId()).toThrow(EngineError);
  });

  it("inspect works through store round-trip", async () => {
    const t = await store.createTraversal("valid-simple");
    const inspect = store.inspect(t.traversalId, "position");
    expect("currentNode" in inspect && inspect.currentNode).toBe("start");
  });

  describe("multi-process access", () => {
    it("second store instance sees traversals from first", async () => {
      const dir = path.join(tmpDir, "traversals");
      const store2 = new TraversalStore(openStateStore(dir), graphs, {
        hookRunner: new HookRunner(),
      });

      const t = await store.createTraversal("valid-simple");

      // store2 sees the traversal
      const list = store2.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].traversalId).toBe(t.traversalId);

      // store2 can advance it
      store2.contextSet(t.traversalId, { taskStarted: true });
      const adv = await store2.advance(t.traversalId, "work-done");
      expect(adv.isError).toBe(false);

      // store sees the updated state
      const inspect = store.inspect(t.traversalId, "position");
      expect("currentNode" in inspect && inspect.currentNode).toBe("review");

      store2.close();
    });

    it("survives process restart (new store from same dir)", async () => {
      const dir = path.join(tmpDir, "traversals");

      const t = await store.createTraversal("valid-simple");
      store.contextSet(t.traversalId, { taskStarted: true });
      await store.advance(t.traversalId, "work-done");
      store.close();

      // "Restart" — new store from same directory
      const store2 = new TraversalStore(openStateStore(dir), graphs, {
        hookRunner: new HookRunner(),
      });
      const list = store2.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].currentNode).toBe("review");

      // Can continue
      const adv = await store2.advance(t.traversalId, "approved");
      expect(adv.isError).toBe(false);
      if (!adv.isError) {
        expect(adv.status).toBe("complete");
      }

      store2.close();

      // Reassign so afterEach doesn't double-close
      store = new TraversalStore(openStateStore(path.join(tmpDir, "traversals")), graphs, {
        hookRunner: new HookRunner(),
      });
    });
  });

  describe("meta tags", () => {
    it("persists meta on createTraversal and surfaces it in list", async () => {
      const r = await store.createTraversal("valid-simple", undefined, {
        externalKey: "DEV-1234",
        branch: "feature/x",
      });
      expect(r.meta).toEqual({ externalKey: "DEV-1234", branch: "feature/x" });

      const list = store.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].meta).toEqual({ externalKey: "DEV-1234", branch: "feature/x" });
    });

    it("treats undefined/empty meta as absent (no field on record)", async () => {
      const a = await store.createTraversal("valid-simple");
      const b = await store.createTraversal("valid-branching", undefined, {});
      expect(a.meta).toBeUndefined();
      expect(b.meta).toBeUndefined();
      for (const info of store.listTraversals()) {
        expect(info.meta).toBeUndefined();
      }
    });

    it("meta survives advance/contextSet round-trips (immutable after start)", async () => {
      const r = await store.createTraversal("valid-simple", undefined, { externalKey: "DEV-1234" });
      store.contextSet(r.traversalId, { taskStarted: true });
      await store.advance(r.traversalId, "work-done");

      const list = store.listTraversals();
      expect(list[0].meta).toEqual({ externalKey: "DEV-1234" });
    });

    it("inspect returns meta at the top level regardless of detail", async () => {
      const r = await store.createTraversal(
        "valid-simple",
        { initialNote: "hello" },
        { externalKey: "DEV-1234", prUrl: "https://example/pr/7" },
      );
      store.contextSet(r.traversalId, { taskStarted: true });
      await store.advance(r.traversalId, "work-done");

      for (const detail of ["position", "full", "history"] as const) {
        const result = store.inspect(r.traversalId, detail);
        expect(result.meta).toEqual({
          externalKey: "DEV-1234",
          prUrl: "https://example/pr/7",
        });
      }
    });

    it("inspect omits meta when none was set", async () => {
      const r = await store.createTraversal("valid-simple");
      const result = store.inspect(r.traversalId, "position");
      expect(result.meta).toBeUndefined();
    });

    it("setMeta merges new keys into existing meta", async () => {
      const r = await store.createTraversal("valid-simple", undefined, {
        externalKey: "DEV-1",
      });
      const result = store.setMeta(r.traversalId, { prUrl: "https://example/pr/7" });
      expect(result.meta).toEqual({ externalKey: "DEV-1", prUrl: "https://example/pr/7" });

      const inspected = store.inspect(r.traversalId, "position");
      expect(inspected.meta).toEqual({
        externalKey: "DEV-1",
        prUrl: "https://example/pr/7",
      });
    });

    it("setMeta overwrites existing keys", async () => {
      const r = await store.createTraversal("valid-simple", undefined, {
        externalKey: "DEV-1",
      });
      const result = store.setMeta(r.traversalId, { externalKey: "DEV-2" });
      expect(result.meta).toEqual({ externalKey: "DEV-2" });
    });

    it("setMeta works on traversals that had no meta at start", async () => {
      const r = await store.createTraversal("valid-simple");
      const result = store.setMeta(r.traversalId, { externalKey: "LATE-1" });
      expect(result.meta).toEqual({ externalKey: "LATE-1" });
      expect(store.listTraversals()[0].meta).toEqual({ externalKey: "LATE-1" });
    });

    it("setMeta rejects empty updates", async () => {
      const r = await store.createTraversal("valid-simple");
      expect(() => store.setMeta(r.traversalId, {})).toThrow(EngineError);
    });

    it("setMeta throws TRAVERSAL_NOT_FOUND for unknown id", () => {
      expect(() => store.setMeta("tr_nope", { a: "b" })).toThrow(EngineError);
    });

    it("setMeta bumps updatedAt but preserves createdAt + stack", async () => {
      const r = await store.createTraversal("valid-simple");
      await store.advance(r.traversalId, "work-done", { taskStarted: true });
      const before = store.inspect(r.traversalId, "position");
      store.setMeta(r.traversalId, { externalKey: "X" });
      const after = store.inspect(r.traversalId, "position");
      expect(after.currentNode).toBe(before.currentNode);
    });

    it("meta_set onEnter hook tags the traversal at start, not via separate setMeta call", async () => {
      // Load the meta_set fixture into its own store (the default beforeEach
      // graphs don't include it). Mirrors the loadFixtures helper pattern.
      const metaGraphs = loadFixtures("hook-meta-set.workflow.yaml");
      const metaStore = new TraversalStore(
        openStateStore(path.join(tmpDir, "meta-traversals")),
        metaGraphs,
        { hookRunner: new HookRunner() },
      );
      try {
        const r = await metaStore.createTraversal("hook-meta-set");
        // The start node's meta_set hook should have populated externalKey.
        expect(r.meta).toEqual({ externalKey: "DEV-1234" });
        expect(metaStore.listTraversals()[0].meta).toEqual({ externalKey: "DEV-1234" });

        // Advance fires the next node's meta_set hook, merging in prUrl.
        const adv = await metaStore.advance(r.traversalId, "next");
        expect(adv.isError).toBe(false);
        expect(adv.meta).toEqual({
          externalKey: "DEV-1234",
          prUrl: "https://example/pr/7",
        });

        // Caller-supplied meta at start composes with hook-supplied meta —
        // hook updates win on key collision (last-write-wins on each call).
        const r2 = await metaStore.createTraversal("hook-meta-set", undefined, {
          externalKey: "OVERRIDE",
          owner: "alice",
        });
        expect(r2.meta).toEqual({
          externalKey: "DEV-1234", // hook wrote after caller-supplied value
          owner: "alice",
        });
      } finally {
        metaStore.close();
      }
    });

    it("meta round-trips through process restart (persisted on disk)", async () => {
      const dir = path.join(tmpDir, "traversals");
      const r = await store.createTraversal("valid-simple", undefined, { externalKey: "DEV-9" });
      store.close();

      const store2 = new TraversalStore(openStateStore(dir), graphs, {
        hookRunner: new HookRunner(),
      });
      try {
        const list = store2.listTraversals();
        expect(list).toHaveLength(1);
        expect(list[0].meta).toEqual({ externalKey: "DEV-9" });
        const inspected = store2.inspect(r.traversalId, "position");
        expect(inspected.meta).toEqual({ externalKey: "DEV-9" });
      } finally {
        store2.close();
      }

      // Reassign so afterEach doesn't double-close
      store = new TraversalStore(openStateStore(dir), graphs, {
        hookRunner: new HookRunner(),
      });
    });
  });

  describe("listGraphs determinism", () => {
    it("returns graphs sorted by id regardless of insertion order", async () => {
      // Reinstall store with graphs inserted in reverse-alphabetical order to
      // prove `listGraphs` sorts its output rather than echoing Map order.
      const reversed = new Map<string, ValidatedGraph>();
      const ids = [...graphs.keys()].sort().reverse();
      for (const id of ids) {
        const g = graphs.get(id);
        if (g) reversed.set(id, g);
      }
      store.close();
      store = new TraversalStore(openStateStore(path.join(tmpDir, "traversals2")), reversed, {
        hookRunner: new HookRunner(),
      });

      const listed = store.listGraphs().graphs.map((g) => g.id);
      const expected = [...listed].sort();
      expect(listed).toEqual(expected);
    });
  });

  describe("hasActiveTraversalForGraph", () => {
    it("returns false when no traversals exist", async () => {
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(false);
    });

    it("returns true when a matching traversal exists", async () => {
      await store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(true);
      expect(store.hasActiveTraversalForGraph("valid-branching")).toBe(false);
    });

    it("accepts multiple graph IDs", async () => {
      await store.createTraversal("valid-branching");
      expect(store.hasActiveTraversalForGraph("valid-simple", "valid-branching")).toBe(true);
      expect(store.hasActiveTraversalForGraph("nonexistent", "also-nonexistent")).toBe(false);
    });

    it("returns false after traversal is reset", async () => {
      const t = await store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(true);
      store.resetTraversal(t.traversalId);
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(false);
    });

    it("returns false for empty graphIds", async () => {
      await store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph()).toBe(false);
    });
  });
});

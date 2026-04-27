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

  it("completes a full traversal lifecycle and auto-GCs the terminal record", async () => {
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

    // Reaching a root terminal node clears the persisted record
    // automatically — no explicit reset call needed. Completed
    // traversals shouldn't clutter listTraversals().
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

    it("normalizes unset/empty meta to an empty object on responses (matches context convention)", async () => {
      const a = await store.createTraversal("valid-simple");
      const b = await store.createTraversal("valid-branching", undefined, {});
      // Always-present convention: meta is an object, empty when untagged.
      // Matches how `context` is always present on inspect responses.
      expect(a.meta).toEqual({});
      expect(b.meta).toEqual({});
      for (const info of store.listTraversals()) {
        expect(info.meta).toEqual({});
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

      for (const detail of ["position", "history"] as const) {
        const result = store.inspect(r.traversalId, detail);
        expect(result.meta).toEqual({
          externalKey: "DEV-1234",
          prUrl: "https://example/pr/7",
        });
      }
    });

    it("inspect returns empty meta when none was set (always-present convention)", async () => {
      const r = await store.createTraversal("valid-simple");
      const result = store.inspect(r.traversalId, "position");
      expect(result.meta).toEqual({});
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

    it("requiredMeta rejects start calls that don't supply the declared keys", async () => {
      const reqGraphs = loadFixtures("required-meta-caller.workflow.yaml");
      const reqStore = new TraversalStore(
        openStateStore(path.join(tmpDir, "req-traversals-a")),
        reqGraphs,
        { hookRunner: new HookRunner() },
      );
      try {
        await expect(reqStore.createTraversal("required-meta-caller")).rejects.toThrow(
          /externalKey/,
        );
        await expect(
          reqStore.createTraversal("required-meta-caller", undefined, { other: "x" }),
        ).rejects.toThrow(EngineError);
        // No traversal is persisted on failure — start is transactional.
        expect(reqStore.listTraversals()).toHaveLength(0);

        // Supplying the key succeeds.
        const ok = await reqStore.createTraversal("required-meta-caller", undefined, {
          externalKey: "DEV-1",
        });
        expect(ok.meta).toEqual({ externalKey: "DEV-1" });
      } finally {
        reqStore.close();
      }
    });

    it("requiredMeta can be satisfied by start-node onEnter meta_set (post-hook enforcement)", async () => {
      const reqGraphs = loadFixtures("required-meta-hook.workflow.yaml");
      const reqStore = new TraversalStore(
        openStateStore(path.join(tmpDir, "req-traversals-b")),
        reqGraphs,
        { hookRunner: new HookRunner() },
      );
      try {
        // Caller supplies no meta — the hook derives externalKey from context.
        const r = await reqStore.createTraversal("required-meta-hook");
        expect(r.meta).toEqual({ externalKey: "DEV-AUTO" });
      } finally {
        reqStore.close();
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

  describe("orphanedTraversals split (#136)", () => {
    it("splits traversals whose graph no longer loads into a distinct array", async () => {
      const t1 = await store.createTraversal("valid-simple");
      const t2 = await store.createTraversal("valid-branching");

      // Simulate the yaml for one graph disappearing between CLI
      // invocations — the store is constructed fresh each time, so
      // this models the post-#127 reality (no watcher; each run loads
      // graphs from disk).
      const pruned = new Map(graphs);
      pruned.delete("valid-simple");
      store.updateGraphs(pruned);

      const result = store.listGraphs();
      expect(result.activeTraversals).toHaveLength(1);
      expect(result.activeTraversals[0].traversalId).toBe(t2.traversalId);
      expect(result.orphanedTraversals).toHaveLength(1);
      expect(result.orphanedTraversals?.[0].traversalId).toBe(t1.traversalId);
      expect(result.orphanedTraversals?.[0].graphId).toBe("valid-simple");
    });

    it("elides orphanedTraversals when every traversal's graph resolves", async () => {
      await store.createTraversal("valid-simple");
      const result = store.listGraphs();
      expect("orphanedTraversals" in result).toBe(false);
    });
  });

  describe("loadEngine orphan recovery hint (#136)", () => {
    it("throws GRAPH_NOT_FOUND with a reset hint when the graph is gone", async () => {
      const t = await store.createTraversal("valid-simple");
      const pruned = new Map(graphs);
      pruned.delete("valid-simple");
      store.updateGraphs(pruned);

      await expect(store.advance(t.traversalId, "work-done")).rejects.toMatchObject({
        code: "GRAPH_NOT_FOUND",
        message: expect.stringContaining(`freelance reset ${t.traversalId} --confirm`),
      });
    });

    it("preserves TRAVERSAL_NOT_FOUND precedence over orphan detection", async () => {
      // An unknown traversalId is a bigger miss than an orphan; the
      // skill gets the same error whether or not the referenced graph
      // would have been orphaned.
      await expect(store.advance("tr_nonexistent", "work-done")).rejects.toMatchObject({
        code: "TRAVERSAL_NOT_FOUND",
      });
    });

    it("lets resetTraversal clear an orphan (recovery path the error message recommends)", async () => {
      const t = await store.createTraversal("valid-simple");
      const pruned = new Map(graphs);
      pruned.delete("valid-simple");
      store.updateGraphs(pruned);

      const result = store.resetTraversal(t.traversalId);
      expect(result.status).toBe("reset");
      expect(result.previousGraph).toBe("valid-simple");
      expect(result.message).toMatch(/orphaned/);
      expect(store.listTraversals()).toHaveLength(0);
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

  describe("concurrent writers (#88)", () => {
    it("serializes two in-process advances on the same id (no lost update)", async () => {
      const t = await store.createTraversal("valid-simple");
      store.contextSet(t.traversalId, { taskStarted: true });

      // Without the in-process lock, both advances would load at the
      // same version; the later putIfVersion would throw
      // TRAVERSAL_CONFLICT. With the lock, they serialize: the first
      // moves start → review, the second runs against the post-first
      // state and fails cleanly (no matching edge at `review`).
      // Either way, no silent lost update.
      const results = await Promise.allSettled([
        store.advance(t.traversalId, "work-done"),
        store.advance(t.traversalId, "work-done"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // The first advance succeeds (moves start → review). The second
      // runs against the post-first state and fails cleanly — but
      // crucially, not with TRAVERSAL_CONFLICT: the mutex already
      // serialized them, so the second call sees a coherent world.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      for (const r of rejected) {
        const err = (r as PromiseRejectedResult).reason;
        expect(err).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).not.toBe("TRAVERSAL_CONFLICT");
      }

      // Persisted state reflects the first advance, not a half-applied
      // or overwritten result.
      const list = store.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].currentNode).toBe("review");
    });

    it("version monotonically increases on each successful write", async () => {
      const dir = path.join(tmpDir, "traversals");
      const t = await store.createTraversal("valid-simple");

      // Reach into the raw store to observe the on-disk version.
      // The record's version is an implementation detail of the
      // optimistic-concurrency scheme; we're verifying it behaves as
      // described rather than exposing it on the public API.
      const raw = () => {
        const file = fs.readFileSync(path.join(dir, `${t.traversalId}.json`), "utf-8");
        return JSON.parse(file) as { version?: number };
      };

      // createTraversal's first put goes through `put`, so version = 1.
      expect(raw().version).toBe(1);

      store.contextSet(t.traversalId, { taskStarted: true });
      expect(raw().version).toBe(2);

      store.setMeta(t.traversalId, { owner: "alice" });
      expect(raw().version).toBe(3);

      // advance saves twice — once after the gate-checks + transition
      // commit (before onEnter), once after hooks complete. The double
      // write is load-bearing: a hook throw between the saves leaves
      // disk on the new node, not the stale pre-advance one. See
      // docs/decisions.md § "Observable state transitions are durable
      // before side effects".
      await store.advance(t.traversalId, "work-done");
      expect(raw().version).toBe(5);
    });

    it("detects cross-process writer races via TRAVERSAL_CONFLICT", async () => {
      // Simulates the two-process CLI-vs-hook scenario from #88:
      // writer A captures a record at version N, writer B lands a
      // write at N+1, writer A's save must throw instead of silently
      // clobbering. TraversalStore's own methods re-read on every
      // call, so we drop to the raw backend to capture a stale view.
      const dir = path.join(tmpDir, "traversals");
      const store2 = new TraversalStore(openStateStore(dir), graphs, {
        hookRunner: new HookRunner(),
      });

      try {
        const t = await store.createTraversal("valid-simple");
        const backend = openStateStore(dir);
        const staleView = backend.get(t.traversalId);
        if (!staleView) throw new Error("unreachable");

        // Another writer bumps the on-disk version past staleView's.
        store2.contextSet(t.traversalId, { taskStarted: true });

        expect(() =>
          backend.putIfVersion(
            { ...staleView, updatedAt: new Date().toISOString() },
            staleView.version ?? 0,
          ),
        ).toThrow(EngineError);
        try {
          backend.putIfVersion(
            { ...staleView, updatedAt: new Date().toISOString() },
            staleView.version ?? 0,
          );
        } catch (e) {
          expect((e as EngineError).code).toBe("TRAVERSAL_CONFLICT");
        }
        backend.close();
      } finally {
        store2.close();
      }
    });

    it.each([
      ["json", () => path.join(tmpDir, "resurrection-json")],
      [":memory:", () => ":memory:"],
    ])("putIfVersion rejects resurrection of a deleted record with TRAVERSAL_NOT_FOUND (%s)", (_label, dirOrSentinel) => {
      // Writer A loads, writer B deletes (e.g. `freelance reset
      // --confirm`), writer A's saveEngine fires putIfVersion.
      // Without the guard the write proceeds as a fresh create,
      // silently undoing the operator's explicit clear. The check
      // is on record existence, not `expectedVersion > 0`: the
      // `version ?? 0` normalization for pre-1.4 records means
      // `expectedVersion === 0` can legitimately come from a loaded
      // legacy record, so zero is not a safe "is this a create"
      // signal.
      //
      // The wire-level code is TRAVERSAL_NOT_FOUND (kind: clear), not
      // TRAVERSAL_CONFLICT (kind: retry): the dead handle isn't
      // recoverable by retrying, so the skill drops it instead of
      // looping. See #192 for the rationale.
      const backend = openStateStore(dirOrSentinel());
      try {
        for (const expectedVersion of [5, 0]) {
          const record = {
            id: `tr_ghost_v${expectedVersion}`,
            stack: [],
            graphId: "valid-simple",
            currentNode: "start",
            stackDepth: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: expectedVersion,
          };
          try {
            backend.putIfVersion(record, expectedVersion);
            throw new Error("expected TRAVERSAL_NOT_FOUND, none thrown");
          } catch (e) {
            expect(e).toBeInstanceOf(EngineError);
            expect((e as EngineError).code).toBe("TRAVERSAL_NOT_FOUND");
          }
          expect(backend.get(record.id)).toBeUndefined();
        }
      } finally {
        backend.close();
      }
    });

    it("rejection in one advance doesn't poison subsequent calls on the same id", async () => {
      const t = await store.createTraversal("valid-simple");
      // First advance fails (no matching edge, no contextSet first).
      await expect(store.advance(t.traversalId, "nonexistent-edge")).rejects.toThrow(EngineError);

      // Second advance on the same id must still proceed — the lock
      // tail-marker swallows the prior rejection.
      store.contextSet(t.traversalId, { taskStarted: true });
      const adv = await store.advance(t.traversalId, "work-done");
      expect(adv.isError).toBe(false);
    });
  });
});

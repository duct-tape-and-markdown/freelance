import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { TraversalStore, openStateStore } from "../src/state/index.js";
import { EngineError } from "../src/errors.js";
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

  beforeEach(() => {
    graphs = loadFixtures("valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-db-test-"));
    store = new TraversalStore(openStateStore(path.join(tmpDir, "traversals")), graphs);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates traversals with unique IDs", () => {
    const r1 = store.createTraversal("valid-simple");
    const r2 = store.createTraversal("valid-branching");

    expect(r1.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r2.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r1.traversalId).not.toBe(r2.traversalId);
  });

  it("lists active traversals from disk", () => {
    expect(store.listTraversals()).toHaveLength(0);

    store.createTraversal("valid-simple");
    expect(store.listTraversals()).toHaveLength(1);

    store.createTraversal("valid-branching");
    expect(store.listTraversals()).toHaveLength(2);

    const list = store.listTraversals();
    expect(list[0].graphId).toBeDefined();
    expect(list[0].currentNode).toBeDefined();
  });

  it("advances traversal through store round-trip", () => {
    const t = store.createTraversal("valid-simple");
    store.contextSet(t.traversalId, { taskStarted: true });
    const adv = store.advance(t.traversalId, "work-done");
    expect(adv.isError).toBe(false);
    if (!adv.isError) {
      expect(adv.currentNode).toBe("review");
    }

    // Verify state persisted — list should show new node
    const list = store.listTraversals();
    expect(list[0].currentNode).toBe("review");
  });

  it("removes traversal on reset", () => {
    const t = store.createTraversal("valid-simple");
    expect(store.listTraversals()).toHaveLength(1);

    store.resetTraversal(t.traversalId);
    expect(store.listTraversals()).toHaveLength(0);
  });

  it("throws TRAVERSAL_NOT_FOUND for unknown ID", () => {
    expect(() => store.advance("tr_nonexistent", "edge")).toThrow(EngineError);
    try {
      store.advance("tr_nonexistent", "edge");
    } catch (e) {
      expect((e as EngineError).code).toBe("TRAVERSAL_NOT_FOUND");
    }
  });

  it("completes a full traversal lifecycle", () => {
    const start = store.createTraversal("valid-simple");
    const id = start.traversalId;
    expect(start.status).toBe("started");

    store.contextSet(id, { taskStarted: true });
    const adv1 = store.advance(id, "work-done");
    expect(adv1.isError).toBe(false);

    const adv2 = store.advance(id, "approved");
    if (!adv2.isError) {
      expect(adv2.status).toBe("complete");
    }

    store.resetTraversal(id);
    expect(store.listTraversals()).toHaveLength(0);
  });

  it("resolves single active traversal", () => {
    const t = store.createTraversal("valid-simple");
    expect(store.resolveTraversalId()).toBe(t.traversalId);
  });

  it("throws NO_TRAVERSAL when none active", () => {
    expect(() => store.resolveTraversalId()).toThrow(EngineError);
  });

  it("throws AMBIGUOUS_TRAVERSAL when multiple active", () => {
    store.createTraversal("valid-simple");
    store.createTraversal("valid-branching");
    expect(() => store.resolveTraversalId()).toThrow(EngineError);
  });

  it("inspect works through store round-trip", () => {
    const t = store.createTraversal("valid-simple");
    const inspect = store.inspect(t.traversalId, "position");
    expect("currentNode" in inspect && inspect.currentNode).toBe("start");
  });

  describe("multi-process access", () => {
    it("second store instance sees traversals from first", () => {
      const dir = path.join(tmpDir, "traversals");
      const store2 = new TraversalStore(openStateStore(dir), graphs);

      const t = store.createTraversal("valid-simple");

      // store2 sees the traversal
      const list = store2.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].traversalId).toBe(t.traversalId);

      // store2 can advance it
      store2.contextSet(t.traversalId, { taskStarted: true });
      const adv = store2.advance(t.traversalId, "work-done");
      expect(adv.isError).toBe(false);

      // store sees the updated state
      const inspect = store.inspect(t.traversalId, "position");
      expect("currentNode" in inspect && inspect.currentNode).toBe("review");

      store2.close();
    });

    it("survives process restart (new store from same dir)", () => {
      const dir = path.join(tmpDir, "traversals");

      const t = store.createTraversal("valid-simple");
      store.contextSet(t.traversalId, { taskStarted: true });
      store.advance(t.traversalId, "work-done");
      store.close();

      // "Restart" — new store from same directory
      const store2 = new TraversalStore(openStateStore(dir), graphs);
      const list = store2.listTraversals();
      expect(list).toHaveLength(1);
      expect(list[0].currentNode).toBe("review");

      // Can continue
      const adv = store2.advance(t.traversalId, "approved");
      expect(adv.isError).toBe(false);
      if (!adv.isError) {
        expect(adv.status).toBe("complete");
      }

      store2.close();

      // Reassign so afterEach doesn't double-close
      store = new TraversalStore(openStateStore(path.join(tmpDir, "traversals")), graphs);
    });
  });

  describe("hasActiveTraversalForGraph", () => {
    it("returns false when no traversals exist", () => {
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(false);
    });

    it("returns true when a matching traversal exists", () => {
      store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(true);
      expect(store.hasActiveTraversalForGraph("valid-branching")).toBe(false);
    });

    it("accepts multiple graph IDs", () => {
      store.createTraversal("valid-branching");
      expect(store.hasActiveTraversalForGraph("valid-simple", "valid-branching")).toBe(true);
      expect(store.hasActiveTraversalForGraph("nonexistent", "also-nonexistent")).toBe(false);
    });

    it("returns false after traversal is reset", () => {
      const t = store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(true);
      store.resetTraversal(t.traversalId);
      expect(store.hasActiveTraversalForGraph("valid-simple")).toBe(false);
    });

    it("returns false for empty graphIds", () => {
      store.createTraversal("valid-simple");
      expect(store.hasActiveTraversalForGraph()).toBe(false);
    });
  });
});

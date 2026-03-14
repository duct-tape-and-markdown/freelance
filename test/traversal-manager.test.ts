import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { TraversalManager } from "../src/traversal-manager.js";
import { EngineError } from "../src/errors.js";
import type { ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tm-persist-"));
}

describe("TraversalManager — multi-traversal", () => {
  let graphs: Map<string, ValidatedGraph>;

  beforeEach(() => {
    graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
  });

  it("creates traversals with unique IDs", () => {
    const tm = new TraversalManager(graphs);
    const r1 = tm.createTraversal("valid-simple");
    const r2 = tm.createTraversal("valid-branching");

    expect(r1.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r2.traversalId).toMatch(/^tr_[0-9a-f]{8}$/);
    expect(r1.traversalId).not.toBe(r2.traversalId);
  });

  it("returns traversalId in start result", () => {
    const tm = new TraversalManager(graphs);
    const result = tm.createTraversal("valid-simple");
    expect(result.traversalId).toBeDefined();
    expect(result.status).toBe("started");
    expect(result.graphId).toBe("valid-simple");
    expect(result.currentNode).toBe("start");
  });

  it("manages multiple independent traversals", () => {
    const tm = new TraversalManager(graphs);
    const t1 = tm.createTraversal("valid-simple");
    const t2 = tm.createTraversal("valid-branching");

    // Advance t1
    tm.contextSet(t1.traversalId, { taskStarted: true });
    const adv1 = tm.advance(t1.traversalId, "work-done");
    expect(adv1.isError).toBe(false);
    if (!adv1.isError) {
      expect(adv1.currentNode).toBe("review");
    }

    // t2 is still at start
    const inspect2 = tm.inspect(t2.traversalId, "position");
    expect("currentNode" in inspect2 && inspect2.currentNode).toBe("start");
  });

  it("lists active traversals", () => {
    const tm = new TraversalManager(graphs);
    expect(tm.listTraversals()).toHaveLength(0);

    tm.createTraversal("valid-simple");
    expect(tm.listTraversals()).toHaveLength(1);

    tm.createTraversal("valid-branching");
    expect(tm.listTraversals()).toHaveLength(2);

    const list = tm.listTraversals();
    expect(list[0].graphId).toBeDefined();
    expect(list[0].currentNode).toBeDefined();
    expect(list[0].stackDepth).toBe(1);
  });

  it("listGraphs includes activeTraversals", () => {
    const tm = new TraversalManager(graphs);
    tm.createTraversal("valid-simple");

    const result = tm.listGraphs();
    expect(result.graphs.length).toBeGreaterThan(0);
    expect(result.activeTraversals).toHaveLength(1);
  });

  it("removes traversal on reset", () => {
    const tm = new TraversalManager(graphs);
    const t = tm.createTraversal("valid-simple");
    expect(tm.listTraversals()).toHaveLength(1);

    tm.resetTraversal(t.traversalId);
    expect(tm.listTraversals()).toHaveLength(0);
  });

  it("throws TRAVERSAL_NOT_FOUND for unknown ID", () => {
    const tm = new TraversalManager(graphs);
    expect(() => tm.advance("tr_nonexistent", "edge")).toThrow(EngineError);
    try {
      tm.advance("tr_nonexistent", "edge");
    } catch (e) {
      expect((e as EngineError).code).toBe("TRAVERSAL_NOT_FOUND");
    }
  });
});

describe("TraversalManager — resolveTraversalId", () => {
  let graphs: Map<string, ValidatedGraph>;

  beforeEach(() => {
    graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
  });

  it("auto-resolves when single traversal active", () => {
    const tm = new TraversalManager(graphs);
    const t = tm.createTraversal("valid-simple");
    const resolved = tm.resolveTraversalId();
    expect(resolved).toBe(t.traversalId);
  });

  it("throws NO_TRAVERSAL when none active", () => {
    const tm = new TraversalManager(graphs);
    expect(() => tm.resolveTraversalId()).toThrow(EngineError);
    try {
      tm.resolveTraversalId();
    } catch (e) {
      expect((e as EngineError).code).toBe("NO_TRAVERSAL");
    }
  });

  it("throws AMBIGUOUS_TRAVERSAL when multiple active", () => {
    const tm = new TraversalManager(graphs);
    tm.createTraversal("valid-simple");
    tm.createTraversal("valid-branching");
    expect(() => tm.resolveTraversalId()).toThrow(EngineError);
    try {
      tm.resolveTraversalId();
    } catch (e) {
      expect((e as EngineError).code).toBe("AMBIGUOUS_TRAVERSAL");
    }
  });

  it("resolves explicit ID even with multiple active", () => {
    const tm = new TraversalManager(graphs);
    const t1 = tm.createTraversal("valid-simple");
    tm.createTraversal("valid-branching");
    expect(tm.resolveTraversalId(t1.traversalId)).toBe(t1.traversalId);
  });
});

describe("TraversalManager — persistence", () => {
  let graphs: Map<string, ValidatedGraph>;

  beforeEach(() => {
    graphs = loadFixtures("valid-simple.graph.yaml", "valid-branching.graph.yaml");
  });

  it("persists traversal to disk on create", () => {
    const persistDir = makeTmpDir();
    const tm = new TraversalManager(graphs, { persistDir });
    const t = tm.createTraversal("valid-simple");

    const files = fs.readdirSync(persistDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${t.traversalId}.json`);

    const data = JSON.parse(fs.readFileSync(path.join(persistDir, files[0]), "utf-8"));
    expect(data.traversalId).toBe(t.traversalId);
    expect(data.stack).toHaveLength(1);
    expect(data.stack[0].graphId).toBe("valid-simple");
  });

  it("updates persisted file on advance", () => {
    const persistDir = makeTmpDir();
    const tm = new TraversalManager(graphs, { persistDir });
    const t = tm.createTraversal("valid-simple");

    tm.contextSet(t.traversalId, { taskStarted: true });
    tm.advance(t.traversalId, "work-done");

    const data = JSON.parse(
      fs.readFileSync(path.join(persistDir, `${t.traversalId}.json`), "utf-8")
    );
    expect(data.stack[0].currentNode).toBe("review");
  });

  it("deletes persisted file on reset", () => {
    const persistDir = makeTmpDir();
    const tm = new TraversalManager(graphs, { persistDir });
    const t = tm.createTraversal("valid-simple");
    expect(fs.readdirSync(persistDir)).toHaveLength(1);

    tm.resetTraversal(t.traversalId);
    expect(fs.readdirSync(persistDir)).toHaveLength(0);
  });

  it("restores traversals from disk on startup", () => {
    const persistDir = makeTmpDir();

    // Create and advance a traversal
    const tm1 = new TraversalManager(graphs, { persistDir });
    const t = tm1.createTraversal("valid-simple");
    tm1.contextSet(t.traversalId, { taskStarted: true });
    tm1.advance(t.traversalId, "work-done");

    // Create a new manager from the same persist dir (simulates restart)
    const tm2 = new TraversalManager(graphs, { persistDir });
    const list = tm2.listTraversals();
    expect(list).toHaveLength(1);
    expect(list[0].traversalId).toBe(t.traversalId);
    expect(list[0].currentNode).toBe("review");

    // Can continue the traversal
    const inspect = tm2.inspect(t.traversalId, "position");
    if ("currentNode" in inspect) {
      expect(inspect.currentNode).toBe("review");
    }

    // Can advance further
    const adv = tm2.advance(t.traversalId, "approved");
    expect(adv.isError).toBe(false);
    if (!adv.isError) {
      expect(adv.status).toBe("complete");
    }
  });

  it("restores multiple traversals", () => {
    const persistDir = makeTmpDir();

    const tm1 = new TraversalManager(graphs, { persistDir });
    tm1.createTraversal("valid-simple");
    tm1.createTraversal("valid-branching");

    const tm2 = new TraversalManager(graphs, { persistDir });
    expect(tm2.listTraversals()).toHaveLength(2);
  });

  it("handles corrupted persist files gracefully", () => {
    const persistDir = makeTmpDir();
    fs.writeFileSync(path.join(persistDir, "tr_corrupted.json"), "not json{{{");

    // Should not throw
    const tm = new TraversalManager(graphs, { persistDir });
    expect(tm.listTraversals()).toHaveLength(0);
  });
});

describe("TraversalManager — full traversal with traversalId", () => {
  it("completes a full traversal lifecycle", () => {
    const graphs = loadFixtures("valid-simple.graph.yaml");
    const tm = new TraversalManager(graphs);

    // Start
    const start = tm.createTraversal("valid-simple");
    expect(start.traversalId).toBeDefined();
    expect(start.status).toBe("started");

    const id = start.traversalId;

    // Context set
    const ctx = tm.contextSet(id, { taskStarted: true });
    expect(ctx.traversalId).toBe(id);
    expect(ctx.status).toBe("updated");

    // Advance
    const adv1 = tm.advance(id, "work-done");
    expect(adv1.traversalId).toBe(id);
    expect(adv1.isError).toBe(false);

    // Advance to terminal
    const adv2 = tm.advance(id, "approved");
    expect(adv2.traversalId).toBe(id);
    if (!adv2.isError) {
      expect(adv2.status).toBe("complete");
    }

    // Reset
    const reset = tm.resetTraversal(id);
    expect(reset.traversalId).toBe(id);
    expect(reset.status).toBe("reset");
  });
});

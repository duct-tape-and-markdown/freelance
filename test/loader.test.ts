import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraphs, loadGraphsLayered } from "../src/loader.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

/**
 * Helper: load only specific fixture files by copying them to a temp dir.
 * Instead, we test by loading individual files via a helper that filters.
 */
function loadSingleFixture(filename: string) {
  // Create a temporary approach: we'll use a subdirectory strategy.
  // For simplicity, we'll test valid files together and invalid ones individually.
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
  fs.copyFileSync(
    path.join(FIXTURES_DIR, filename),
    path.join(tmpDir, filename)
  );
  return tmpDir;
}

function loadValidFixtures() {
  const fs = require("node:fs");
  const os = require("node:os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-test-"));
  for (const f of ["valid-simple.graph.yaml", "valid-branching.graph.yaml"]) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return tmpDir;
}

describe("loadGraphs — valid fixtures", () => {
  it("loads valid graphs and returns correct count", () => {
    const dir = loadValidFixtures();
    const graphs = loadGraphs(dir);
    expect(graphs.size).toBe(2);
    expect(graphs.has("valid-simple")).toBe(true);
    expect(graphs.has("valid-branching")).toBe(true);
  });

  it("valid-simple has correct structure", () => {
    const dir = loadSingleFixture("valid-simple.graph.yaml");
    const graphs = loadGraphs(dir);
    const g = graphs.get("valid-simple")!;

    expect(g.definition.name).toBe("Simple Workflow");
    expect(g.definition.startNode).toBe("start");
    expect(g.graph.nodeCount()).toBe(3);
    expect(g.graph.edgeCount()).toBe(2);
  });

  it("valid-branching has correct structure", () => {
    const dir = loadSingleFixture("valid-branching.graph.yaml");
    const graphs = loadGraphs(dir);
    const g = graphs.get("valid-branching")!;

    expect(g.definition.name).toBe("Branching Workflow");
    expect(g.graph.nodeCount()).toBe(6);
    // start→choose-path, choose-path→left-work, choose-path→right-work,
    // left-work→quality-check, right-work→quality-check,
    // quality-check→done, quality-check→left-work
    expect(g.graph.edgeCount()).toBe(7);
  });
});

describe("loadGraphs — invalid fixtures", () => {
  it("rejects orphan node", () => {
    const dir = loadSingleFixture("invalid-orphan.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/orphan/i);
  });

  it("rejects missing edge target", () => {
    const dir = loadSingleFixture("invalid-missing-target.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/nonexistent/i);
  });

  it("rejects terminal node with edges", () => {
    const dir = loadSingleFixture("invalid-terminal-with-edges.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal/i);
  });

  it("rejects gate node without validations", () => {
    const dir = loadSingleFixture("invalid-gate-no-validations.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/gate/i);
  });

  it("rejects action-only cycle", () => {
    const dir = loadSingleFixture("invalid-action-loop.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/cycle/i);
  });

  it("rejects invalid validation expression", () => {
    const dir = loadSingleFixture("invalid-bad-expression.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid validation expression/i);
  });

  it("rejects invalid edge condition expression", () => {
    const dir = loadSingleFixture("invalid-bad-edge-condition.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid condition/i);
  });

  it("rejects invalid subgraph condition expression", () => {
    const dir = loadSingleFixture("invalid-bad-subgraph-condition.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid subgraph condition/i);
  });

  it("rejects terminal node with subgraph", () => {
    const dir = loadSingleFixture("invalid-terminal-subgraph.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal node must not have a subgraph/i);
  });

  it("rejects non-terminal node without edges", () => {
    const dir = loadSingleFixture("invalid-no-edges.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/must have at least one outgoing edge/i);
  });

  it("rejects invalid startNode reference", () => {
    const dir = loadSingleFixture("invalid-bad-startnode.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/startNode.*not defined/i);
  });

  it("rejects terminal node with returns", () => {
    const dir = loadSingleFixture("invalid-terminal-returns.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal node must not have a returns/i);
  });

  it("rejects overlapping required/optional returns keys", () => {
    const dir = loadSingleFixture("invalid-returns-overlap.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/appears in both required and optional/i);
  });

  it("rejects items on non-array returns type", () => {
    const dir = loadSingleFixture("invalid-returns-items-non-array.graph.yaml");
    expect(() => loadGraphs(dir)).toThrow(/items.*only valid on array/i);
  });
});

describe("loadGraphs — edge cases", () => {
  it("throws when directory does not exist", () => {
    expect(() => loadGraphs("/tmp/nonexistent-dir-xyz")).toThrow(/does not exist/i);
  });

  it("throws when directory has no graph files", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-graphs-"));
    expect(() => loadGraphs(emptyDir)).toThrow(/No \*\.graph\.yaml files/i);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("warns on partial failures but loads valid graphs", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-fail-"));
    // Copy one valid and one invalid
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(tmpDir, "valid-simple.graph.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.graph.yaml"),
      path.join(tmpDir, "invalid-orphan.graph.yaml")
    );
    const graphs = loadGraphs(tmpDir);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed validation"));
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("loadGraphsLayered", () => {
  it("throws when given empty directories array", () => {
    expect(() => loadGraphsLayered([])).toThrow(/No graph directories provided/i);
  });

  it("loads graphs from a single directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-single-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(tmpDir, "valid-simple.graph.yaml")
    );
    const graphs = loadGraphsLayered([tmpDir]);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("later directory shadows earlier one (same graph id)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "layered-1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "layered-2-"));
    // Both have valid-simple — dir2 should shadow dir1
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(dir1, "valid-simple.graph.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(dir2, "valid-simple.graph.yaml")
    );
    const graphs = loadGraphsLayered([dir1, dir2]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("shadows"));
    stderrSpy.mockRestore();
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it("skips non-existent directories with warning", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "layered-real-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(dir1, "valid-simple.graph.yaml")
    );
    const graphs = loadGraphsLayered(["/tmp/nonexistent-xyz", dir1]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
    stderrSpy.mockRestore();
    fs.rmSync(dir1, { recursive: true, force: true });
  });

  it("skips empty directories with warning", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-empty-"));
    const validDir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-valid-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(validDir, "valid-simple.graph.yaml")
    );
    const graphs = loadGraphsLayered([emptyDir, validDir]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no *.graph.yaml"));
    stderrSpy.mockRestore();
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.rmSync(validDir, { recursive: true, force: true });
  });

  it("throws when no valid graphs found in any directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-allfail-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.graph.yaml"),
      path.join(dir, "invalid-orphan.graph.yaml")
    );
    expect(() => loadGraphsLayered([dir])).toThrow(/No valid graphs found/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns about validation failures in individual directories", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-mixed-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.graph.yaml"),
      path.join(dir, "valid-simple.graph.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.graph.yaml"),
      path.join(dir, "invalid-orphan.graph.yaml")
    );
    const graphs = loadGraphsLayered([dir]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed validation"));
    stderrSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadGraphs } from "../src/loader.js";

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
});

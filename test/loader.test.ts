import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGraphs, loadGraphsLayered, loadGraphsCollecting, findGraphFiles, resolveContextDefaults } from "../src/loader.js";

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
  for (const f of ["valid-simple.workflow.yaml", "valid-branching.workflow.yaml"]) {
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
    const dir = loadSingleFixture("valid-simple.workflow.yaml");
    const graphs = loadGraphs(dir);
    const g = graphs.get("valid-simple")!;

    expect(g.definition.name).toBe("Simple Workflow");
    expect(g.definition.startNode).toBe("start");
    expect(g.graph.nodeCount()).toBe(3);
    expect(g.graph.edgeCount()).toBe(2);
  });

  it("valid-branching has correct structure", () => {
    const dir = loadSingleFixture("valid-branching.workflow.yaml");
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
    const dir = loadSingleFixture("invalid-orphan.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/orphan/i);
  });

  it("rejects missing edge target", () => {
    const dir = loadSingleFixture("invalid-missing-target.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/nonexistent/i);
  });

  it("rejects terminal node with edges", () => {
    const dir = loadSingleFixture("invalid-terminal-with-edges.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal/i);
  });

  it("rejects gate node without validations", () => {
    const dir = loadSingleFixture("invalid-gate-no-validations.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/gate/i);
  });

  it("rejects action-only cycle", () => {
    const dir = loadSingleFixture("invalid-action-loop.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/cycle/i);
  });

  it("rejects invalid validation expression", () => {
    const dir = loadSingleFixture("invalid-bad-expression.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid validation expression/i);
  });

  it("rejects invalid edge condition expression", () => {
    const dir = loadSingleFixture("invalid-bad-edge-condition.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid condition/i);
  });

  it("rejects invalid subgraph condition expression", () => {
    const dir = loadSingleFixture("invalid-bad-subgraph-condition.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/invalid subgraph condition/i);
  });

  it("rejects terminal node with subgraph", () => {
    const dir = loadSingleFixture("invalid-terminal-subgraph.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal node must not have a subgraph/i);
  });

  it("rejects non-terminal node without edges", () => {
    const dir = loadSingleFixture("invalid-no-edges.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/must have at least one outgoing edge/i);
  });

  it("rejects invalid startNode reference", () => {
    const dir = loadSingleFixture("invalid-bad-startnode.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/startNode.*not defined/i);
  });

  it("rejects terminal node with returns", () => {
    const dir = loadSingleFixture("invalid-terminal-returns.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/terminal node must not have a returns/i);
  });

  it("rejects overlapping required/optional returns keys", () => {
    const dir = loadSingleFixture("invalid-returns-overlap.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/appears in both required and optional/i);
  });

  it("rejects items on non-array returns type", () => {
    const dir = loadSingleFixture("invalid-returns-items-non-array.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/items.*only valid on array/i);
  });
});

describe("loadGraphs — edge cases", () => {
  it("throws when directory does not exist", () => {
    expect(() => loadGraphs("/tmp/nonexistent-dir-xyz")).toThrow(/does not exist/i);
  });

  it("throws when directory has no graph files", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-graphs-"));
    expect(() => loadGraphs(emptyDir)).toThrow(/No \*\.workflow\.yaml files/i);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("warns on partial failures but loads valid graphs", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-fail-"));
    // Copy one valid and one invalid
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.workflow.yaml"),
      path.join(tmpDir, "invalid-orphan.workflow.yaml")
    );
    const graphs = loadGraphs(tmpDir);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed validation"));
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("findGraphFiles — recursive scanning", () => {
  it("finds workflow files in subdirectories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recursive-scan-"));
    const subDir = path.join(tmpDir, "reviews");
    fs.mkdirSync(subDir);
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "top-level.workflow.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-branching.workflow.yaml"),
      path.join(subDir, "nested.workflow.yaml")
    );

    const files = findGraphFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("top-level.workflow.yaml"))).toBe(true);
    expect(files.some((f) => f.includes("nested.workflow.yaml"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds files in deeply nested directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-scan-"));
    const deepDir = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(deepDir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(deepDir, "deep.workflow.yaml")
    );

    const files = findGraphFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(path.join("a", "b", "c", "deep.workflow.yaml"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ignores non-workflow files in subdirectories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filter-scan-"));
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# hi");
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), "key: value");
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid.workflow.yaml")
    );

    const files = findGraphFiles(tmpDir);
    expect(files).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for directory with no workflow files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-scan-"));
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "# hi");

    const files = findGraphFiles(tmpDir);
    expect(files).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("loadGraphs — recursive loading", () => {
  it("loads graphs from subdirectories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recursive-load-"));
    const subDir = path.join(tmpDir, "nested");
    fs.mkdirSync(subDir);
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(subDir, "valid-simple.workflow.yaml")
    );

    const graphs = loadGraphs(tmpDir);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);

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
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
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
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir1, "valid-simple.workflow.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir2, "valid-simple.workflow.yaml")
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
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir1, "valid-simple.workflow.yaml")
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
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(validDir, "valid-simple.workflow.yaml")
    );
    const graphs = loadGraphsLayered([emptyDir, validDir]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("no *.workflow.yaml"));
    stderrSpy.mockRestore();
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.rmSync(validDir, { recursive: true, force: true });
  });

  it("throws when no valid graphs found in any directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-allfail-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.workflow.yaml"),
      path.join(dir, "invalid-orphan.workflow.yaml")
    );
    expect(() => loadGraphsLayered([dir])).toThrow(/No valid graphs found/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns about validation failures in individual directories", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layered-mixed-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir, "valid-simple.workflow.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.workflow.yaml"),
      path.join(dir, "invalid-orphan.workflow.yaml")
    );
    const graphs = loadGraphsLayered([dir]);
    expect(graphs.size).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("failed validation"));
    stderrSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("context enums — static validation", () => {
  it("loads graph with valid enum context and matching conditions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-valid-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-enum.workflow.yaml"),
      path.join(dir, "valid-enum.workflow.yaml")
    );
    const graphs = loadGraphs(dir);
    expect(graphs.has("valid-enum")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects graph with enum mismatch in edge condition", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-invalid-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-enum-mismatch.workflow.yaml"),
      path.join(dir, "invalid-enum-mismatch.workflow.yaml")
    );
    expect(() => loadGraphs(dir)).toThrow("raceSpecific");
    expect(() => loadGraphs(dir)).toThrow("not in the declared enum");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plain scalar context values still work (backward compat)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-compat-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir, "valid-simple.workflow.yaml")
    );
    const graphs = loadGraphs(dir);
    expect(graphs.has("valid-simple")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolveContextDefaults", () => {
  it("passes plain scalars through unchanged", () => {
    const result = resolveContextDefaults({ x: null, y: 0, z: false, w: "hello" });
    expect(result).toEqual({ x: null, y: 0, z: false, w: "hello" });
  });

  it("extracts default from descriptor objects", () => {
    const result = resolveContextDefaults({
      phase: { type: "string", enum: ["a", "b"], default: null },
      count: { type: "number", default: 5 },
      plain: "value",
    });
    expect(result).toEqual({ phase: null, count: 5, plain: "value" });
  });

  it("defaults to null when descriptor has no default", () => {
    const result = resolveContextDefaults({
      phase: { type: "string", enum: ["a", "b"] },
    });
    expect(result.phase).toBeNull();
  });
});

describe("loadGraphsCollecting", () => {
  it("returns graphs and empty errors for valid files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collecting-test-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
    );
    try {
      const { graphs, errors } = loadGraphsCollecting([tmpDir]);
      expect(graphs.size).toBe(1);
      expect(errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns both graphs and errors for mixed valid/invalid files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collecting-test-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-no-edges.workflow.yaml"),
      path.join(tmpDir, "invalid-no-edges.workflow.yaml")
    );
    try {
      const { graphs, errors } = loadGraphsCollecting([tmpDir]);
      expect(graphs.size).toBe(1);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].file).toContain("invalid-no-edges");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty results for non-existent directory", () => {
    const { graphs, errors } = loadGraphsCollecting(["/nonexistent/path"]);
    expect(graphs.size).toBe(0);
    expect(errors).toHaveLength(0);
  });
});

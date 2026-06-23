import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  findGraphFiles,
  loadGraphs,
  loadGraphsCollecting,
  validateCrossGraphRefs,
} from "../src/loader.js";
import { getSealedGraphs, SEALED_GRAPH_IDS } from "../src/memory/sealed.js";
import { resolveContextDefaults } from "../src/schema/graph-schema.js";

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
  fs.copyFileSync(path.join(FIXTURES_DIR, filename), path.join(tmpDir, filename));
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

  it("rejects a cycle with no exit edge", () => {
    const dir = loadSingleFixture("invalid-action-loop.workflow.yaml");
    expect(() => loadGraphs(dir)).toThrow(/cycle/i);
  });

  it("accepts a bounded action retry loop with an exit edge (#340)", () => {
    const dir = loadSingleFixture("valid-bounded-action-loop.workflow.yaml");
    const graphs = loadGraphs(dir);
    expect(graphs.has("valid-bounded-action-loop")).toBe(true);
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

  it("loads valid graphs on partial failure without writing to stderr (#276)", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-fail-"));
    // Copy one valid and one invalid
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-orphan.workflow.yaml"),
      path.join(tmpDir, "invalid-orphan.workflow.yaml"),
    );
    const graphs = loadGraphs(tmpDir);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);
    // loadGraphs is public lib API and must not emit stderr — partial-failure
    // detail is available via loadGraphsCollecting instead.
    expect(stderrSpy).not.toHaveBeenCalled();
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
      path.join(tmpDir, "top-level.workflow.yaml"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-branching.workflow.yaml"),
      path.join(subDir, "nested.workflow.yaml"),
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
      path.join(deepDir, "deep.workflow.yaml"),
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
      path.join(tmpDir, "valid.workflow.yaml"),
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
      path.join(subDir, "valid-simple.workflow.yaml"),
    );

    const graphs = loadGraphs(tmpDir);
    expect(graphs.size).toBe(1);
    expect(graphs.has("valid-simple")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("context enums — static validation", () => {
  it("loads graph with valid enum context and matching conditions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-valid-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-enum.workflow.yaml"),
      path.join(dir, "valid-enum.workflow.yaml"),
    );
    const graphs = loadGraphs(dir);
    expect(graphs.has("valid-enum")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects graph with enum mismatch in edge condition", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-invalid-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-enum-mismatch.workflow.yaml"),
      path.join(dir, "invalid-enum-mismatch.workflow.yaml"),
    );
    expect(() => loadGraphs(dir)).toThrow("raceSpecific");
    expect(() => loadGraphs(dir)).toThrow("not in the declared enum");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("plain scalar context values still work (backward compat)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enum-compat-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir, "valid-simple.workflow.yaml"),
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
      path.join(tmpDir, "valid-simple.workflow.yaml"),
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
      path.join(tmpDir, "valid-simple.workflow.yaml"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "invalid-no-edges.workflow.yaml"),
      path.join(tmpDir, "invalid-no-edges.workflow.yaml"),
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

  it("reports a shadowing id across two dirs as a warning entry (#278)", () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "collecting-shadow-1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "collecting-shadow-2-"));
    // Both define valid-simple — the later dir shadows the earlier one.
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir1, "valid-simple.workflow.yaml"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "valid-simple.workflow.yaml"),
      path.join(dir2, "valid-simple.workflow.yaml"),
    );
    try {
      const { graphs, errors } = loadGraphsCollecting([dir1, dir2]);
      expect(graphs.size).toBe(1);
      expect(graphs.has("valid-simple")).toBe(true);
      expect(errors.some((e) => /shadows an earlier definition/.test(e.message))).toBe(true);
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("cross-graph validation with sealed graphs", () => {
  it("loadGraphsCollecting: subgraph ref to memory:recall resolves when sealedGraphs supplied", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-load-test-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "parent-with-sealed-subgraph.workflow.yaml"),
      path.join(tmpDir, "parent-with-sealed-subgraph.workflow.yaml"),
    );
    try {
      const bare = loadGraphsCollecting([tmpDir]);
      expect(bare.errors.some((e) => /memory:recall/.test(e.message))).toBe(true);

      const { graphs, errors } = loadGraphsCollecting([tmpDir], {
        sealedGraphs: getSealedGraphs(),
      });
      expect(errors).toHaveLength(0);
      expect(graphs.has("parent-with-sealed")).toBe(true);
      expect(graphs.has("memory:recall")).toBe(true);
      expect(graphs.has("memory:compile")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadGraphs: throws without sealedGraphs, passes with them", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-load-test-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "parent-with-sealed-subgraph.workflow.yaml"),
      path.join(tmpDir, "parent-with-sealed-subgraph.workflow.yaml"),
    );
    try {
      expect(() => loadGraphs(tmpDir)).toThrow(/memory:recall/);
      const graphs = loadGraphs(tmpDir, { sealedGraphs: getSealedGraphs() });
      expect(graphs.has("parent-with-sealed")).toBe(true);
      expect(graphs.has("memory:recall")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("user-authored graph with sealed id wins over sealed default", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-override-test-"));
    const userYaml = `id: "memory:recall"
version: "9.9.9"
name: "User Recall Override"
description: "User override"
startNode: start
context: {}
nodes:
  start:
    type: terminal
    description: "user-authored terminal"
`;
    fs.writeFileSync(path.join(tmpDir, "user-recall.workflow.yaml"), userYaml);
    try {
      const { graphs, errors } = loadGraphsCollecting([tmpDir], {
        sealedGraphs: getSealedGraphs(),
      });
      expect(errors).toHaveLength(0);
      const recall = graphs.get("memory:recall");
      expect(recall).toBeDefined();
      expect(recall?.definition.version).toBe("9.9.9");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validateCrossGraphRefs: extraAvailableIds accepts sealed ids without merging them", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-ids-test-"));
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "parent-with-sealed-subgraph.workflow.yaml"),
      path.join(tmpDir, "parent-with-sealed-subgraph.workflow.yaml"),
    );
    try {
      const { graphs } = loadGraphsCollecting([tmpDir]);
      const map = new Map(graphs);
      expect(() =>
        validateCrossGraphRefs(map, { extraAvailableIds: SEALED_GRAPH_IDS }),
      ).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("load-time strictness", () => {
  function writeTempGraph(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strictness-test-"));
    fs.writeFileSync(path.join(tmpDir, "g.workflow.yaml"), content);
    return tmpDir;
  }

  const wrap = (context: string, nodes?: string) => `
id: g
version: "1.0.0"
name: "G"
description: "G"
startNode: start
${context}
nodes:
${
  nodes ??
  `  start:
    type: action
    description: "Start"
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"`
}
`;

  // #339 — context descriptor validation
  it("rejects a malformed descriptor (typo'd type with enum)", () => {
    const dir = writeTempGraph(
      wrap(`context:
  phase:
    type: strng
    enum: [a, b]`),
    );
    expect(() => loadGraphs(dir)).toThrow(/malformed/i);
  });

  it("rejects a descriptor whose default is not in its enum", () => {
    const dir = writeTempGraph(
      wrap(`context:
  phase:
    type: string
    enum: [a, b]
    default: c`),
    );
    expect(() => loadGraphs(dir)).toThrow(/not in the declared enum/i);
  });

  it("rejects a descriptor whose default does not match its type", () => {
    const dir = writeTempGraph(
      wrap(`context:
  count:
    type: number
    default: "lots"`),
    );
    expect(() => loadGraphs(dir)).toThrow(/not of declared type/i);
  });

  it("accepts a valid descriptor with a matching default in its enum", () => {
    const dir = writeTempGraph(
      wrap(`context:
  phase:
    type: string
    enum: [a, b]
    default: a`),
    );
    expect(loadGraphs(dir).has("g")).toBe(true);
  });

  // #280 — expression path cross-check under strictContext
  const strictGraph = (condition: string) => `
id: g
version: "1.0.0"
name: "G"
description: "G"
startNode: start
strictContext: true
context:
  ready: false
nodes:
  start:
    type: decision
    description: "Route"
    edges:
      - target: done
        label: go
        condition: "${condition}"
  done:
    type: terminal
    description: "Done"
`;

  it("rejects an expression referencing an undeclared field under strictContext", () => {
    const dir = writeTempGraph(strictGraph("context.redy == true"));
    expect(() => loadGraphs(dir)).toThrow(/undeclared context field "redy"/i);
  });

  it("accepts an expression referencing a declared field under strictContext", () => {
    const dir = writeTempGraph(strictGraph("context.ready == true"));
    expect(loadGraphs(dir).has("g")).toBe(true);
  });

  it("does not cross-check fields when strictContext is off (field may be set at runtime)", () => {
    // Same undeclared reference, but no strictContext → accepted, since the
    // field could be populated by initialContext / contextSet / a hook.
    const dir = writeTempGraph(
      strictGraph("context.redy == true").replace("strictContext: true\n", ""),
    );
    expect(loadGraphs(dir).has("g")).toBe(true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestOpsRegistry } from "../src/engine/operations.js";
import { loadGraphs, loadGraphsCollecting, loadGraphsLayered } from "../src/loader.js";
import { validateOps, validateOpsAndPrune } from "../src/ops-validation.js";

const PROGRAMMATIC_YAML_GOOD = `
id: prog-good
version: 1.0.0
name: Programmatic Good
description: test
startNode: prep
nodes:
  prep:
    type: programmatic
    description: preparation
    operation:
      name: known_op
    edges:
      - label: ready
        target: work
  work:
    type: action
    description: agent step
    edges:
      - label: done
        target: end
  end:
    type: terminal
    description: done
`;

const PROGRAMMATIC_YAML_BAD_OP = `
id: prog-bad-op
version: 1.0.0
name: Programmatic Bad Op
description: test
startNode: prep
nodes:
  prep:
    type: programmatic
    description: preparation
    operation:
      name: unknown_op
    edges:
      - label: ready
        target: end
  end:
    type: terminal
    description: done
`;

function writeFixture(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("loader — loads programmatic workflows without op-name validation", () => {
  it("loads a good programmatic workflow", () => {
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    const graphs = loadGraphs(dir);
    expect(graphs.has("prog-good")).toBe(true);
  });

  it("loads a programmatic workflow with an unknown op name (defers validation)", () => {
    // The loader is structural only. Op-name validation is a post-pass
    // (see src/ops-validation.ts) so the bad workflow still loads — it'll
    // only fail at runtime drain OR at validateOps time, whichever runs first.
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const graphs = loadGraphs(dir);
    expect(graphs.has("prog-bad-op")).toBe(true);
  });

  it("loadGraphsLayered loads both good and bad across directories", () => {
    const dir1 = tmpdir("loader-prog-l1-");
    const dir2 = tmpdir("loader-prog-l2-");
    writeFixture(dir1, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    writeFixture(dir2, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const graphs = loadGraphsLayered([dir1, dir2]);
    expect(graphs.has("prog-good")).toBe(true);
    expect(graphs.has("prog-bad-op")).toBe(true);
  });
});

describe("validateOps — post-load op-name checks", () => {
  const registry = createTestOpsRegistry({ known_op: () => ({}) });

  function loadBoth(): ReturnType<typeof loadGraphs> {
    const dir = tmpdir("validate-ops-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    return loadGraphs(dir);
  }

  it("returns an empty error list when every op is registered", () => {
    const dir = tmpdir("validate-ops-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    const graphs = loadGraphs(dir);
    expect(validateOps(graphs, registry)).toEqual([]);
  });

  it("reports structured errors for unknown op references", () => {
    const graphs = loadBoth();
    const errors = validateOps(graphs, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0].graphId).toBe("prog-bad-op");
    expect(errors[0].nodeId).toBe("prep");
    expect(errors[0].opName).toBe("unknown_op");
    expect(errors[0].message).toMatch(/Unknown operation "unknown_op"/);
    expect(errors[0].message).toMatch(/Registered ops: \[known_op\]/);
  });

  it("validateOps never mutates the input map", () => {
    const graphs = loadBoth();
    const before = graphs.size;
    validateOps(graphs, registry);
    expect(graphs.size).toBe(before);
    expect(graphs.has("prog-bad-op")).toBe(true);
  });

  it("validateOpsAndPrune removes graphs with unknown op references", () => {
    const graphs = loadBoth();
    const errors = validateOpsAndPrune(graphs, registry);
    expect(errors).toHaveLength(1);
    expect(graphs.has("prog-good")).toBe(true);
    expect(graphs.has("prog-bad-op")).toBe(false);
  });

  it("validateOpsAndPrune is idempotent on an already-clean map", () => {
    const dir = tmpdir("validate-ops-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    const graphs = loadGraphs(dir);
    const errors = validateOpsAndPrune(graphs, registry);
    expect(errors).toEqual([]);
    expect(graphs.has("prog-good")).toBe(true);
  });

  it("works with graphs from loadGraphsCollecting too", () => {
    const dir = tmpdir("validate-ops-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const { graphs, errors: loadErrors } = loadGraphsCollecting([dir]);
    expect(loadErrors).toHaveLength(0);
    const opErrors = validateOpsAndPrune(graphs, registry);
    expect(opErrors).toHaveLength(1);
    expect(graphs.has("prog-bad-op")).toBe(false);
  });

  it("skips non-programmatic nodes", () => {
    const dir = tmpdir("validate-ops-");
    const YAML = `
id: plain
version: 1.0.0
name: Plain
description: t
startNode: a
nodes:
  a:
    type: action
    description: a
    edges:
      - label: go
        target: b
  b:
    type: terminal
    description: b
`;
    writeFixture(dir, "plain.workflow.yaml", YAML);
    const graphs = loadGraphs(dir);
    expect(validateOps(graphs, registry)).toEqual([]);
  });
});

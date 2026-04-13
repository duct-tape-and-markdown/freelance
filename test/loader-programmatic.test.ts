import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestOpsRegistry } from "../src/engine/operations.js";
import {
  loadGraphs,
  loadGraphsCollecting,
  loadGraphsLayered,
  loadSingleGraph,
  validateAndBuild,
} from "../src/loader.js";
import type { GraphDefinition } from "../src/types.js";

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

describe("loader — loadSingleGraph with opsRegistry", () => {
  it("loads a graph whose programmatic op is registered", () => {
    const dir = tmpdir("loader-prog-");
    const filePath = writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    const result = loadSingleGraph(filePath, registry);
    expect(result.id).toBe("prog-good");
  });

  it("rejects a graph whose programmatic op is not registered", () => {
    const dir = tmpdir("loader-prog-");
    const filePath = writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    expect(() => loadSingleGraph(filePath, registry)).toThrow(/unknown operation "unknown_op"/);
  });

  it("loads the bad graph when no registry is provided (op check deferred)", () => {
    const dir = tmpdir("loader-prog-");
    const filePath = writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const result = loadSingleGraph(filePath);
    expect(result.id).toBe("prog-bad-op");
  });
});

describe("loader — loadGraphs with opsRegistry", () => {
  it("validates op names for all graphs in a directory", () => {
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    const graphs = loadGraphs(dir, registry);
    expect(graphs.has("prog-good")).toBe(true);
  });

  it("collects op validation errors alongside successful loads", () => {
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    // loadGraphs logs and continues when some fail
    const graphs = loadGraphs(dir, registry);
    expect(graphs.has("prog-good")).toBe(true);
    expect(graphs.has("prog-bad-op")).toBe(false);
  });
});

describe("loader — loadGraphsCollecting with opsRegistry", () => {
  it("reports op-name errors in the errors array", () => {
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    const result = loadGraphsCollecting([dir], registry);
    expect(result.graphs.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/unknown operation "unknown_op"/);
  });

  it("skips op-name validation when no registry is provided", () => {
    const dir = tmpdir("loader-prog-");
    writeFixture(dir, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const result = loadGraphsCollecting([dir]);
    expect(result.graphs.has("prog-bad-op")).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe("loader — loadGraphsLayered with opsRegistry", () => {
  it("applies op-name validation across layered directories", () => {
    const dir1 = tmpdir("loader-prog-l1-");
    const dir2 = tmpdir("loader-prog-l2-");
    writeFixture(dir1, "good.workflow.yaml", PROGRAMMATIC_YAML_GOOD);
    writeFixture(dir2, "bad.workflow.yaml", PROGRAMMATIC_YAML_BAD_OP);
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    const graphs = loadGraphsLayered([dir1, dir2], registry);
    expect(graphs.has("prog-good")).toBe(true);
    expect(graphs.has("prog-bad-op")).toBe(false);
  });
});

describe("loader — validateAndBuild with opsRegistry", () => {
  it("is the shared pipeline used by GraphBuilder", () => {
    const def: GraphDefinition = {
      id: "builder-style",
      version: "1.0.0",
      name: "b",
      description: "t",
      startNode: "p",
      strictContext: false,
      nodes: {
        p: {
          type: "programmatic",
          description: "p",
          operation: { name: "known_op" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "e" },
      },
    };
    const registry = createTestOpsRegistry({ known_op: () => ({}) });
    expect(() => validateAndBuild(def, "<builder>", registry)).not.toThrow();
  });

  it("rejects an unknown op through validateAndBuild too", () => {
    const def: GraphDefinition = {
      id: "builder-bad",
      version: "1.0.0",
      name: "b",
      description: "t",
      startNode: "p",
      strictContext: false,
      nodes: {
        p: {
          type: "programmatic",
          description: "p",
          operation: { name: "unknown_op" },
          edges: [{ label: "go", target: "end" }],
        },
        end: { type: "terminal", description: "e" },
      },
    };
    const registry = createTestOpsRegistry({ real_op: () => ({}) });
    expect(() => validateAndBuild(def, "<builder>", registry)).toThrow(
      /unknown operation "unknown_op"/,
    );
  });
});

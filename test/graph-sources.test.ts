import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadGraphs } from "../src/loader.js";
import { GraphEngine } from "../src/engine/index.js";
import { graphDefinitionSchema } from "../src/schema/graph-schema.js";
import { hashSource, validateGraphSources } from "../src/sources.js";
import type { ValidatedGraph, InspectPositionResult } from "../src/types.js";
import type { GraphDefinition } from "../src/schema/graph-schema.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-sources-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function makeEngine(...files: string[]): GraphEngine {
  return new GraphEngine(loadFixtures(...files));
}

describe("schema: graph-level sources", () => {
  it("accepts graph with sources at graph level", () => {
    const graph = {
      id: "test-graph-sources",
      version: "1.0",
      name: "Test Graph Sources",
      description: "Graph with graph-level source bindings",
      startNode: "start",
      sources: [
        { path: "docs/guide.md", hash: "a1b2c3d4e5f60011" },
        { path: "docs/rules.md", section: "formatting", hash: "f0e1d2c3b4a59988" },
      ],
      nodes: {
        start: {
          type: "action",
          description: "Start",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources).toHaveLength(2);
      expect(result.data.sources![0].path).toBe("docs/guide.md");
      expect(result.data.sources![1].section).toBe("formatting");
    }
  });

  it("accepts graph without sources (backward compatible)", () => {
    const graph = {
      id: "test-no-sources",
      version: "1.0",
      name: "No Sources",
      description: "Graph without graph-level sources",
      startNode: "start",
      nodes: {
        start: {
          type: "action",
          description: "Start",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "Done" },
      },
    };

    const result = graphDefinitionSchema.safeParse(graph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources).toBeUndefined();
    }
  });
});

describe("start() with graph-level sources", () => {
  it("returns graphSources when graph has sources", () => {
    const engine = makeEngine("valid-graph-sources.workflow.yaml");
    const result = engine.start("valid-graph-sources");

    expect(result.status).toBe("started");
    expect(result.graphSources).toBeDefined();
    expect(result.graphSources).toHaveLength(2);
    expect(result.graphSources![0].path).toBe("docs/ambient-guide.md");
    expect(result.graphSources![0].hash).toBe("a1b2c3d4e5f60011");
    expect(result.graphSources![1].path).toBe("docs/style-rules.md");
    expect(result.graphSources![1].section).toBe("formatting");
  });

  it("omits graphSources when graph has no sources", () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = engine.start("valid-simple");

    expect(result.status).toBe("started");
    expect(result.graphSources).toBeUndefined();
  });
});

describe("inspect() with graph-level sources", () => {
  it("returns graphSources in position inspect", () => {
    const engine = makeEngine("valid-graph-sources.workflow.yaml");
    engine.start("valid-graph-sources");

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.graphSources).toBeDefined();
    expect(result.graphSources).toHaveLength(2);
    expect(result.graphSources![0].path).toBe("docs/ambient-guide.md");
  });

  it("omits graphSources in position inspect when graph has none", () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    engine.start("valid-simple");

    const result = engine.inspect("position") as InspectPositionResult;
    expect(result.graphSources).toBeUndefined();
  });
});

describe("validateGraphSources with graph-level sources", () => {
  let tmpDir: string;
  let docFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-sources-validate-"));
    docFile = path.join(tmpDir, "ambient.md");
    fs.writeFileSync(docFile, "# Ambient Guide\n\nThis is the ambient guide content.\n");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects drift in graph-level sources", () => {
    const definition: GraphDefinition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test",
      startNode: "start",
      strictContext: false,
      sources: [{ path: docFile, hash: "wrong-hash-value!" }],
      nodes: {
        start: {
          type: "action",
          description: "Start",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };

    const result = validateGraphSources(definition);
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].node).toBe("(graph)");
    expect(result.warnings[0].drifted[0].path).toBe(docFile);
  });

  it("passes for matching graph-level source hashes", () => {
    const hashed = hashSource({ path: docFile });

    const definition: GraphDefinition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test",
      startNode: "start",
      strictContext: false,
      sources: [{ path: docFile, hash: hashed.hash }],
      nodes: {
        start: {
          type: "action",
          description: "Start",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };

    const result = validateGraphSources(definition);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("validates both graph-level and node-level sources", () => {
    const hashed = hashSource({ path: docFile });

    const definition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test",
      startNode: "start",
      strictContext: false,
      sources: [{ path: docFile, hash: "wrong-graph-hash!" }],
      nodes: {
        start: {
          type: "action" as const,
          description: "Start",
          sources: [{ path: docFile, hash: "wrong-node-hash!" }],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal" as const, description: "End" },
      },
    };

    const result = validateGraphSources(definition as unknown as GraphDefinition);
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].node).toBe("(graph)");
    expect(result.warnings[1].node).toBe("start");
  });
});

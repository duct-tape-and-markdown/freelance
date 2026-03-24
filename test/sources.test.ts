import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  hashSource,
  hashSources,
  checkSources,
  checkSourcesDetailed,
  validateGraphSources,
} from "../src/sources.js";
import type { GraphDefinition } from "../src/schema/graph-schema.js";

let tmpDir: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sources-test-"));
  fileA = path.join(tmpDir, "doc-a.md");
  fileB = path.join(tmpDir, "doc-b.md");
  fs.writeFileSync(fileA, "# Section A\n\nContent of section A.\n");
  fs.writeFileSync(fileB, "# Section B\n\nContent of section B.\n");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashSource", () => {
  it("hashes a whole file", () => {
    const result = hashSource({ path: fileA });
    expect(result.hash).toBeTruthy();
    expect(result.hash).toHaveLength(16);
    expect(result.path).toBe(fileA);
  });

  it("produces consistent hashes", () => {
    const h1 = hashSource({ path: fileA });
    const h2 = hashSource({ path: fileA });
    expect(h1.hash).toBe(h2.hash);
  });

  it("different files produce different hashes", () => {
    const hA = hashSource({ path: fileA });
    const hB = hashSource({ path: fileB });
    expect(hA.hash).not.toBe(hB.hash);
  });

  it("throws for missing file", () => {
    expect(() => hashSource({ path: "/nonexistent" })).toThrow("Source file not found");
  });

  it("uses section resolver when section is provided", () => {
    const resolver = (filePath: string, section: string) => {
      if (section === "A") return "Content of section A.";
      return null;
    };
    const withSection = hashSource({ path: fileA, section: "A" }, resolver);
    const withoutSection = hashSource({ path: fileA });
    // Section content is different from full file
    expect(withSection.hash).not.toBe(withoutSection.hash);
  });

  it("falls back to whole file when section not found", () => {
    const resolver = () => null;
    const withResolver = hashSource({ path: fileA, section: "missing" }, resolver);
    const withoutResolver = hashSource({ path: fileA });
    expect(withResolver.hash).toBe(withoutResolver.hash);
  });
});

describe("hashSources", () => {
  it("hashes multiple sources with combined hash", () => {
    const result = hashSources([{ path: fileA }, { path: fileB }]);
    expect(result.hash).toHaveLength(16);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].path).toBe(fileA);
    expect(result.sources[1].path).toBe(fileB);
  });

  it("combined hash differs from individual hashes", () => {
    const result = hashSources([{ path: fileA }, { path: fileB }]);
    expect(result.hash).not.toBe(result.sources[0].hash);
    expect(result.hash).not.toBe(result.sources[1].hash);
  });
});

describe("checkSources", () => {
  it("returns valid for unchanged sources", () => {
    const original = hashSources([{ path: fileA }, { path: fileB }]);
    const result = checkSources(original.hash, [{ path: fileA }, { path: fileB }]);
    expect(result.valid).toBe(true);
    expect(result.drifted).toHaveLength(0);
  });

  it("returns invalid when a source changes", () => {
    const original = hashSources([{ path: fileA }]);
    // Modify the file
    const originalContent = fs.readFileSync(fileA, "utf-8");
    fs.writeFileSync(fileA, "# Modified\n\nDifferent content.\n");

    const result = checkSources(original.hash, [{ path: fileA }]);
    expect(result.valid).toBe(false);
    expect(result.drifted.length).toBeGreaterThan(0);

    // Restore
    fs.writeFileSync(fileA, originalContent);
  });
});

describe("checkSourcesDetailed", () => {
  it("returns valid for unchanged sources", () => {
    const hashed = hashSources([{ path: fileA }, { path: fileB }]);
    const result = checkSourcesDetailed(hashed.sources);
    expect(result.valid).toBe(true);
    expect(result.drifted).toHaveLength(0);
  });

  it("identifies specific drifted source", () => {
    const hashed = hashSources([{ path: fileA }, { path: fileB }]);
    const originalContent = fs.readFileSync(fileB, "utf-8");
    fs.writeFileSync(fileB, "# Changed B\n\nNew content.\n");

    const result = checkSourcesDetailed(hashed.sources);
    expect(result.valid).toBe(false);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].path).toBe(fileB);
    expect(result.drifted[0].expected).toBe(hashed.sources[1].hash);
    expect(result.drifted[0].actual).not.toBe(hashed.sources[1].hash);

    fs.writeFileSync(fileB, originalContent);
  });
});

describe("validateGraphSources", () => {
  it("returns valid for graph with no sources", () => {
    const definition: GraphDefinition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action",
          description: "Start node",
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal", description: "End" },
      },
    };
    const result = validateGraphSources(definition);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("detects drift in source-bound nodes", () => {
    const hashed = hashSource({ path: fileA });

    const definition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action" as const,
          description: "Start node",
          sources: [{ path: fileA, hash: "wrong-hash-value!" }],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal" as const, description: "End" },
      },
    };

    const result = validateGraphSources(definition as unknown as GraphDefinition);
    expect(result.valid).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].node).toBe("start");
    expect(result.warnings[0].drifted[0].path).toBe(fileA);
  });

  it("passes for matching source hashes", () => {
    const hashed = hashSource({ path: fileA });

    const definition = {
      id: "test",
      version: "1.0",
      name: "Test",
      description: "Test graph",
      startNode: "start",
      strictContext: false,
      nodes: {
        start: {
          type: "action" as const,
          description: "Start node",
          sources: [{ path: fileA, hash: hashed.hash }],
          edges: [{ target: "end", label: "done" }],
        },
        end: { type: "terminal" as const, description: "End" },
      },
    };

    const result = validateGraphSources(definition as unknown as GraphDefinition);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

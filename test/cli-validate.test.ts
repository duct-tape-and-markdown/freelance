import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validate } from "../src/cli/validate.js";
import { hashContent } from "../src/sources.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
}

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function copyFixtures(dir: string, ...files: string[]): void {
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
}

// Runtime + authoring CLI handlers are JSON-only per docs/decisions.md.
// Assertions go against stdout (parsed) and exit codes.

describe("CLI validate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  function stdoutJson(): unknown {
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    return JSON.parse(out);
  }

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds with valid graph files (exit 0)", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const result = stdoutJson() as { valid: boolean; graphs: Array<{ id: string }> };
    expect(result.valid).toBe(true);
    expect(result.graphs).toHaveLength(2);
  });

  it("exits with VALIDATION (3) for nonexistent directory", () => {
    expect(() => validate("/nonexistent/path")).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: Array<{ message: string }> };
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("does not exist");
  });

  it("exits with VALIDATION (3) for empty directory", () => {
    const dir = tmpDir();
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: Array<{ message: string }> };
    expect(result.errors[0].message).toContain("No *.workflow.yaml");
  });

  it("exits with VALIDATION (3) for invalid graph", () => {
    const dir = tmpDir();
    copyFixtures(dir, "invalid-orphan.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: unknown[] };
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports per-file errors in the JSON response", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "invalid-orphan.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as {
      valid: boolean;
      graphs: Array<{ id: string }>;
      errors: Array<{ file: string; message: string }>;
    };
    expect(result.valid).toBe(false);
    // Valid graph still loaded
    expect(result.graphs.some((g) => g.id === "valid-simple")).toBe(true);
    // Invalid graph surfaced as an error
    expect(result.errors.some((e) => e.file.includes("invalid-orphan"))).toBe(true);
  });

  it("validates cross-graph subgraph references (success path)", () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("fails on broken cross-graph subgraph reference", () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("accepts subgraph references to sealed memory:* workflows", () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-sealed-subgraph.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("treats directory with non-graph files as empty", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a graph");
    fs.writeFileSync(path.join(dir, "data.yaml"), "id: test");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("JSON output includes graph metadata fields", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const result = stdoutJson() as {
      graphs: Array<{ id: string; name: string; version: string; nodeCount: number }>;
    };
    const graph = result.graphs[0];
    expect(graph.name).toBe("Simple Workflow");
    expect(graph.version).toBe("1.0.0");
    expect(graph.nodeCount).toBe(3);
  });

  describe("--sources option", () => {
    function writeGraphWithSources(dir: string, docHash: string): void {
      const graphContent = `id: source-test
version: "1.0.0"
name: "Source Test"
description: "Graph with source bindings"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    sources:
      - path: "doc.md"
        hash: "${docHash}"
    edges:
      - target: done
        label: done
  done:
    type: terminal
    description: "Done"
`;
      fs.writeFileSync(path.join(dir, "source-test.workflow.yaml"), graphContent);
    }

    it("passes when source hashes match", () => {
      const dir = tmpDir();
      const docContent = "# Doc\n\nContent here.\n";
      fs.writeFileSync(path.join(dir, "doc.md"), docContent);
      const correctHash = hashContent(docContent);
      writeGraphWithSources(dir, correctHash);

      expect(() => validate(dir, { checkSources: true, basePath: dir })).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("detects drift when source hash is wrong", () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "doc.md"), "# Doc\n");
      writeGraphWithSources(dir, "0000000000000000");

      expect(() => validate(dir, { checkSources: true, basePath: dir })).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { sourceDrift: unknown[] };
      expect(result.sourceDrift.length).toBeGreaterThan(0);
    });

    it("--fix updates drifted hashes in-place", () => {
      const dir = tmpDir();
      const docContent = "# Doc\n\nFixed content.\n";
      fs.writeFileSync(path.join(dir, "doc.md"), docContent);
      const wrongHash = "0000000000000000";
      writeGraphWithSources(dir, wrongHash);

      expect(() => validate(dir, { checkSources: true, fix: true, basePath: dir })).toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(0);

      const updatedContent = fs.readFileSync(path.join(dir, "source-test.workflow.yaml"), "utf-8");
      const correctHash = hashContent(docContent);
      expect(updatedContent).toContain(correctHash);
      expect(updatedContent).not.toContain(wrongHash);

      const result = stdoutJson() as { fixed?: number };
      expect(result.fixed).toBeGreaterThan(0);
    });

    it("--fix skips FILE_NOT_FOUND sources", () => {
      const dir = tmpDir();
      writeGraphWithSources(dir, "0000000000000000");

      expect(() => validate(dir, { checkSources: true, fix: true, basePath: dir })).toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { sourceDrift: unknown[] };
      expect(result.sourceDrift.length).toBeGreaterThan(0);
    });

    it("reports drift in JSON output", () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "doc.md"), "# Doc\n");
      writeGraphWithSources(dir, "0000000000000000");

      expect(() => validate(dir, { checkSources: true, basePath: dir })).toThrow("process.exit");
      const result = stdoutJson() as {
        valid: boolean;
        sourceDrift: Array<{ drifted: Array<{ expected: string; actual: string }> }>;
      };
      expect(result.valid).toBe(false);
      expect(result.sourceDrift[0].drifted[0].expected).toBe("0000000000000000");
      expect(result.sourceDrift[0].drifted[0].actual).toBeTruthy();
    });
  });
});

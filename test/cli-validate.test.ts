import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validate } from "../src/cli/validate.js";
import { setCli } from "../src/cli/output.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
}

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function copyFixtures(dir: string, ...files: string[]): void {
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
}

describe("CLI validate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    setCli({ json: false, quiet: false, verbose: false, noColor: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds with valid graph files", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    validate(dir);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with GRAPH_ERROR for nonexistent directory", () => {
    expect(() => validate("/nonexistent/path")).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with GRAPH_ERROR for empty directory", () => {
    const dir = tmpDir();
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with GRAPH_ERROR for invalid graph", () => {
    const dir = tmpDir();
    copyFixtures(dir, "invalid-orphan.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("reports per-file errors in human output", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "invalid-orphan.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("OK");
    expect(stderr).toContain("FAIL");
  });

  it("produces JSON output when --json is set", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml");
    setCli({ json: true });

    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(stdout);
    expect(result.valid).toBe(true);
    expect(result.graphs).toHaveLength(1);
    expect(result.graphs[0].id).toBe("valid-simple");
  });

  it("JSON output includes errors for invalid graphs", () => {
    const dir = tmpDir();
    copyFixtures(dir, "invalid-orphan.workflow.yaml");
    setCli({ json: true });

    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(stdout);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("human output includes summary line", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    validate(dir);
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("Validated 2 graph(s), 0 error(s)");
  });

  it("JSON output for nonexistent directory", () => {
    setCli({ json: true });
    expect(() => validate("/nonexistent/path")).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(stdout);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("does not exist");
  });

  it("JSON output for empty directory", () => {
    const dir = tmpDir();
    setCli({ json: true });
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(stdout);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("No *.workflow.yaml");
  });

  it("validates cross-graph subgraph references", () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    validate(dir);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("fails on broken cross-graph subgraph reference", () => {
    const dir = tmpDir();
    // Load parent without child — subgraph ref to child-review will dangle
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("treats directory with non-graph files as empty", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a graph");
    fs.writeFileSync(path.join(dir, "data.yaml"), "id: test");
    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("--quiet suppresses info output", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml");
    setCli({ quiet: true });
    validate(dir);
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toBe("");
  });

  it("JSON output includes graph metadata fields", () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml");
    setCli({ json: true });

    expect(() => validate(dir)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(stdout);
    const graph = result.graphs[0];
    expect(graph.name).toBe("Simple Workflow");
    expect(graph.version).toBe("1.0.0");
    expect(graph.nodeCount).toBe(3);
  });
});

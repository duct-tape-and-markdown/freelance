import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "../src/cli/inspect.js";
import { setCli } from "../src/cli/output.js";
import type { SessionState, SerializedTraversal } from "../src/types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-inspect-test-"));
}

function makeTraversal(
  traversalId: string,
  graphId: string,
  currentNode: string
): SerializedTraversal {
  const state: SessionState = {
    graphId,
    currentNode,
    context: {},
    history: [],
    contextHistory: [],
    turnCount: 0,
    startedAt: "2026-03-15T00:00:00.000Z",
  };
  return {
    traversalId,
    stack: [state],
    createdAt: "2026-03-15T00:00:00.000Z",
    lastUpdated: "2026-03-15T01:00:00.000Z",
  };
}

describe("CLI inspect", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let originalCwd: string;
  let workDir: string;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    setCli({ json: false, quiet: false, verbose: false, noColor: false });

    originalCwd = process.cwd();
    workDir = tmpDir();
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("silent when no traversals directory exists", () => {
    inspect({ active: true, oneline: false });
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("silent when traversals directory is empty", () => {
    fs.mkdirSync(path.join(workDir, ".freelance", "traversals"), { recursive: true });
    inspect({ active: true, oneline: false });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("shows traversals in default mode", () => {
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tr_abc12345.json"),
      JSON.stringify(makeTraversal("tr_abc12345", "my-graph", "build"))
    );

    inspect({ active: true, oneline: false });
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("tr_abc12345");
    expect(output).toContain("my-graph");
    expect(output).toContain("build");
  });

  it("shows traversals in oneline mode", () => {
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tr_abc12345.json"),
      JSON.stringify(makeTraversal("tr_abc12345", "ralph-loop", "plan"))
    );

    inspect({ active: true, oneline: true });
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("[Freelance]");
    expect(output).toContain("ralph-loop @ plan");
  });

  it("JSON output includes traversals array", () => {
    setCli({ json: true });
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tr_abc12345.json"),
      JSON.stringify(makeTraversal("tr_abc12345", "my-graph", "verify"))
    );

    inspect({ active: true, oneline: false });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(output);
    expect(result.traversals).toHaveLength(1);
    expect(result.traversals[0].traversalId).toBe("tr_abc12345");
    expect(result.traversals[0].graphId).toBe("my-graph");
  });

  it("skips corrupted files", () => {
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tr_bad.json"), "not json{{{");
    fs.writeFileSync(
      path.join(dir, "tr_good.json"),
      JSON.stringify(makeTraversal("tr_good", "my-graph", "start"))
    );

    inspect({ active: true, oneline: false });
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("tr_good");
    expect(output).not.toContain("tr_bad");
  });

  it("skips files with empty stack", () => {
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tr_empty.json"),
      JSON.stringify({ traversalId: "tr_empty", stack: [], createdAt: "", lastUpdated: "" })
    );

    inspect({ active: true, oneline: false });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("handles multiple traversals", () => {
    const dir = path.join(workDir, ".freelance", "traversals");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tr_001.json"),
      JSON.stringify(makeTraversal("tr_001", "graph-a", "node-1"))
    );
    fs.writeFileSync(
      path.join(dir, "tr_002.json"),
      JSON.stringify(makeTraversal("tr_002", "graph-b", "node-2"))
    );

    inspect({ active: true, oneline: true });
    const output = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("tr_001");
    expect(output).toContain("tr_002");
  });
});

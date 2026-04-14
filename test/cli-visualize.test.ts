import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCli } from "../src/cli/output.js";
import { visualize } from "../src/cli/visualize.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

describe("CLI visualize", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const createdTmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viz-test-"));
    createdTmpDirs.push(dir);
    return dir;
  }

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
    while (createdTmpDirs.length > 0) {
      const dir = createdTmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outputs Mermaid diagram to stdout", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "mermaid" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("graph TD");
    expect(output).toContain("start");
    expect(output).toContain("done");
  });

  it("outputs DOT diagram to stdout", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("digraph");
    expect(output).toContain("rankdir=TD");
    expect(output).toContain("->");
  });

  it("Mermaid uses correct node shapes", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "mermaid" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // decision nodes get diamond braces
    expect(output).toMatch(/choose-path\{choose-path\}/);
    // terminal nodes get double parens
    expect(output).toMatch(/done\(\(done\)\)/);
    // action nodes get square brackets
    expect(output).toMatch(/left-work\[left-work\]/);
  });

  it("DOT uses correct node shapes", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("shape=diamond");
    expect(output).toContain("shape=doublecircle");
    expect(output).toContain("shape=box");
  });

  it("writes to file with --output", () => {
    const outFile = path.join(makeTmpDir(), "out.mmd");
    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "mermaid",
      output: outFile,
    });
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, "utf-8");
    expect(content).toContain("graph TD");
  });

  it("exits with GRAPH_ERROR for nonexistent file", () => {
    expect(() => visualize("/nonexistent/file.workflow.yaml", { format: "mermaid" })).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with INVALID_USAGE for wrong extension", () => {
    const tmpFile = path.join(makeTmpDir(), "bad.yaml");
    fs.writeFileSync(tmpFile, "id: test\n");
    expect(() => visualize(tmpFile, { format: "mermaid" })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("produces JSON output when --json is set", () => {
    setCli({ json: true });
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "mermaid" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(output);
    expect(result.graphId).toBe("valid-simple");
    expect(result.mermaid).toContain("graph TD");
  });

  it("JSON output for DOT includes dot key", () => {
    setCli({ json: true });
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(output);
    expect(result.dot).toContain("digraph");
  });

  it("Mermaid includes edge labels", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "mermaid" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toMatch(/-->\|.+\|/);
  });

  it("DOT includes edge labels", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toMatch(/label="/);
  });

  it("Mermaid renders wait nodes with stadium shape", () => {
    visualize(fixturePath("valid-wait-simple.workflow.yaml"), { format: "mermaid" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // wait nodes use ([...]) stadium shape
    expect(output).toMatch(/wait-approval\(\[wait-approval\]\)/);
  });

  it("DOT renders wait nodes with dashed style", () => {
    visualize(fixturePath("valid-wait-simple.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain('style="dashed"');
  });

  it("DOT renders gate nodes with bold style", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "dot" });
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // quality-check is a gate node — should have style="bold"
    expect(output).toContain('style="bold"');
  });

  it("exits with GRAPH_ERROR for valid extension but invalid content", () => {
    const tmpFile = path.join(makeTmpDir(), "broken.workflow.yaml");
    fs.writeFileSync(tmpFile, "this is not valid graph yaml at all");
    expect(() => visualize(tmpFile, { format: "mermaid" })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("writes DOT format to file with --output", () => {
    const outFile = path.join(makeTmpDir(), "out.dot");
    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "dot",
      output: outFile,
    });
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, "utf-8");
    expect(content).toContain("digraph");
  });

  it("--open generates HTML file with mermaid content", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));

    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "mermaid",
      open: true,
    });

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("Opened in browser:");

    // Verify the HTML file was written
    const htmlPathMatch = stderr.match(/Opened in browser: (.+)/);
    expect(htmlPathMatch).not.toBeNull();
    const htmlPath = htmlPathMatch![1].trim();
    const html = fs.readFileSync(htmlPath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("mermaid");
    expect(html).toContain("graph TD");
  });

  it("--open with DOT format converts to mermaid for HTML", () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(""));

    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "dot",
      open: true,
    });

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const htmlPathMatch = stderr.match(/Opened in browser: (.+)/);
    expect(htmlPathMatch).not.toBeNull();
    const html = fs.readFileSync(htmlPathMatch![1].trim(), "utf-8");
    // Even though format is DOT, HTML should contain mermaid
    expect(html).toContain("graph TD");
  });

  it("--open handles browser open failure gracefully", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no browser");
    });

    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "mermaid",
      open: true,
    });

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("Could not open browser automatically");
  });
});

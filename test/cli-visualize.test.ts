import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visualize } from "../src/cli/visualize.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

// CLI visualize is JSON-only per docs/decisions.md § CLI-primary. The
// response shape is { graphId, format, [format]: <diagram> } or
// { graphId, format, written } when --output is passed.

describe("CLI visualize", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const createdTmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viz-test-"));
    createdTmpDirs.push(dir);
    return dir;
  }

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
    while (createdTmpDirs.length > 0) {
      const dir = createdTmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits JSON with Mermaid diagram", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "mermaid" });
    const result = stdoutJson() as { graphId: string; format: string; mermaid: string };
    expect(result.graphId).toBe("valid-simple");
    expect(result.format).toBe("mermaid");
    expect(result.mermaid).toContain("graph TD");
    expect(result.mermaid).toContain("start");
    expect(result.mermaid).toContain("done");
  });

  it("emits JSON with DOT diagram", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "dot" });
    const result = stdoutJson() as { graphId: string; format: string; dot: string };
    expect(result.format).toBe("dot");
    expect(result.dot).toContain("digraph");
    expect(result.dot).toContain("rankdir=TD");
    expect(result.dot).toContain("->");
  });

  it("Mermaid uses correct node shapes", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "mermaid" });
    const result = stdoutJson() as { mermaid: string };
    expect(result.mermaid).toMatch(/choose-path\{choose-path\}/);
    expect(result.mermaid).toMatch(/done\(\(done\)\)/);
    expect(result.mermaid).toMatch(/left-work\[left-work\]/);
  });

  it("DOT uses correct node shapes", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "dot" });
    const result = stdoutJson() as { dot: string };
    expect(result.dot).toContain("shape=diamond");
    expect(result.dot).toContain("shape=doublecircle");
    expect(result.dot).toContain("shape=box");
  });

  it("writes diagram to file with --output, JSON response includes written path", () => {
    const outFile = path.join(makeTmpDir(), "out.mmd");
    visualize(fixturePath("valid-simple.workflow.yaml"), {
      format: "mermaid",
      output: outFile,
    });
    expect(fs.existsSync(outFile)).toBe(true);
    const content = fs.readFileSync(outFile, "utf-8");
    expect(content).toContain("graph TD");
    const result = stdoutJson() as { written: string; format: string };
    expect(result.written).toBe(outFile);
    expect(result.format).toBe("mermaid");
  });

  it("exits with NOT_FOUND (4) for nonexistent file", () => {
    expect(() => visualize("/nonexistent/file.workflow.yaml", { format: "mermaid" })).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it("exits with INVALID_INPUT (5) for wrong extension", () => {
    const tmpFile = path.join(makeTmpDir(), "bad.yaml");
    fs.writeFileSync(tmpFile, "id: test\n");
    expect(() => visualize(tmpFile, { format: "mermaid" })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it("Mermaid includes edge labels", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "mermaid" });
    const result = stdoutJson() as { mermaid: string };
    expect(result.mermaid).toMatch(/-->\|.+\|/);
  });

  it("DOT includes edge labels", () => {
    visualize(fixturePath("valid-simple.workflow.yaml"), { format: "dot" });
    const result = stdoutJson() as { dot: string };
    expect(result.dot).toMatch(/label="/);
  });

  it("Mermaid renders wait nodes with stadium shape", () => {
    visualize(fixturePath("valid-wait-simple.workflow.yaml"), { format: "mermaid" });
    const result = stdoutJson() as { mermaid: string };
    expect(result.mermaid).toMatch(/wait-approval\(\[wait-approval\]\)/);
  });

  it("DOT renders wait nodes with dashed style", () => {
    visualize(fixturePath("valid-wait-simple.workflow.yaml"), { format: "dot" });
    const result = stdoutJson() as { dot: string };
    expect(result.dot).toContain('style="dashed"');
  });

  it("DOT renders gate nodes with bold style", () => {
    visualize(fixturePath("valid-branching.workflow.yaml"), { format: "dot" });
    const result = stdoutJson() as { dot: string };
    expect(result.dot).toContain('style="bold"');
  });

  it("exits with VALIDATION (3) for valid extension but invalid content", () => {
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
});

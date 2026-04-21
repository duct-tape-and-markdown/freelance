import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourcesValidate } from "../src/cli/stateless.js";

describe("sourcesValidate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const createdDirs: string[] = [];

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "stateless-test-"));
    createdDirs.push(d);
    return d;
  }

  function stdoutJson(): unknown {
    return JSON.parse(stdoutSpy.mock.calls.map((c: [string]) => c[0]).join(""));
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
    for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
    createdDirs.length = 0;
  });

  it("errors with NO_GRAPHS_DIR when graphsDirs is empty", () => {
    expect(() => sourcesValidate([], {})).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4); // EXIT.NOT_FOUND
    const parsed = stdoutJson() as { isError: true; error: { code: string } };
    expect(parsed.error.code).toBe("NO_GRAPHS_DIR");
  });

  it("errors with NO_GRAPHS_LOADED when dirs exist but contain no loadable graphs", () => {
    const dir = tmpDir();
    expect(() => sourcesValidate([dir], {})).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    const parsed = stdoutJson() as { isError: true; error: { code: string } };
    expect(parsed.error.code).toBe("NO_GRAPHS_LOADED");
  });

  it("errors with GRAPH_NOT_FOUND when specified graphId does not match any loaded graph", () => {
    const dir = tmpDir();
    const fixtureSrc = path.resolve("test/fixtures/valid-simple.workflow.yaml");
    fs.copyFileSync(fixtureSrc, path.join(dir, "valid-simple.workflow.yaml"));
    expect(() => sourcesValidate([dir], {}, "nonexistent-id")).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(4);
    const parsed = stdoutJson() as { isError: true; error: { code: string } };
    expect(parsed.error.code).toBe("GRAPH_NOT_FOUND");
  });
});

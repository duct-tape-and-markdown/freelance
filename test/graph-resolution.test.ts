import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultGraphsDirs, resolveGraphsDirs, loadGraphsOrFatal } from "../src/graph-resolution.js";

let exitSpy: any;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FREELANCE_GRAPHS_DIR;
});

describe("resolveDefaultGraphsDirs", () => {
  it("parses FREELANCE_GRAPHS_DIR env var", () => {
    process.env.FREELANCE_GRAPHS_DIR = `/a${path.delimiter}/b`;
    expect(resolveDefaultGraphsDirs()).toEqual(["/a", "/b"]);
  });

  it("finds project-level .freelance/graphs", () => {
    delete process.env.FREELANCE_GRAPHS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gr-test-"));
    fs.mkdirSync(path.join(tmpDir, ".freelance", "graphs"), { recursive: true });
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    process.chdir(tmpDir);
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));

    const dirs = resolveDefaultGraphsDirs();
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toContain(".freelance");

    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("resolveGraphsDirs", () => {
  it("resolves CLI paths", () => {
    expect(resolveGraphsDirs("/x")).toEqual([path.resolve("/x")]);
  });

  it("resolves array of CLI paths", () => {
    expect(resolveGraphsDirs(["/a", "/b"])).toEqual([path.resolve("/a"), path.resolve("/b")]);
  });
});

describe("loadGraphsOrFatal", () => {
  it("loads valid graphs from a directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gr-load-"));
    const fixturesDir = path.resolve(import.meta.dirname, "fixtures");
    fs.copyFileSync(
      path.join(fixturesDir, "valid-simple.graph.yaml"),
      path.join(tmpDir, "valid-simple.graph.yaml")
    );
    const graphs = loadGraphsOrFatal(tmpDir);
    expect(graphs.size).toBe(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits when no dirs found", () => {
    delete process.env.FREELANCE_GRAPHS_DIR;
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-graphs-"));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    process.chdir(emptyDir);
    process.env.HOME = emptyDir;

    expect(() => loadGraphsOrFatal(null)).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(2);

    process.chdir(origCwd);
    process.env.HOME = origHome;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

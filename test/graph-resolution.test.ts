import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultGraphsDirs, resolveGraphsDirs, loadGraphsOrFatal, loadGraphsGraceful } from "../src/graph-resolution.js";
import { tmpFreelanceDir, withTmpEnv } from "./helpers.js";

let exitSpy: any;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FREELANCE_WORKFLOWS_DIR;
});

describe("resolveDefaultGraphsDirs", () => {
  it("parses FREELANCE_WORKFLOWS_DIR env var", () => {
    process.env.FREELANCE_WORKFLOWS_DIR = `/a${path.delimiter}/b`;
    expect(resolveDefaultGraphsDirs()).toEqual(["/a", "/b"]);
  });

  it("finds project-level .freelance", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const freelanceDir = tmpFreelanceDir("gr-test-");
    const tmpDir = path.dirname(freelanceDir);

    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs.length).toBe(1);
      expect(dirs[0]).toContain(".freelance");
    });
  });
});

describe("config-based workflow discovery", () => {
  it("appends dirs from config.yml workflows", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const freelanceDir = tmpFreelanceDir("config-wf-");
    const tmpDir = path.dirname(freelanceDir);
    const pluginWorkflows = path.join(tmpDir, "plugin-workflows");
    fs.mkdirSync(pluginWorkflows, { recursive: true });

    fs.writeFileSync(
      path.join(freelanceDir, "config.yml"),
      `workflows:\n  - ${pluginWorkflows}\n`
    );

    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs).toContain(freelanceDir);
      expect(dirs).toContain(pluginWorkflows);
    });
  });

  it("appends dirs from config.local.yml workflows", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const freelanceDir = tmpFreelanceDir("config-local-");
    const tmpDir = path.dirname(freelanceDir);
    const pluginWorkflows = path.join(tmpDir, "plugin-workflows");
    fs.mkdirSync(pluginWorkflows, { recursive: true });

    fs.writeFileSync(
      path.join(freelanceDir, "config.local.yml"),
      `workflows:\n  - ${pluginWorkflows}\n`
    );

    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs).toContain(freelanceDir);
      expect(dirs).toContain(pluginWorkflows);
    });
  });

  it("skips non-existent dirs from config", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const freelanceDir = tmpFreelanceDir("config-skip-");
    const tmpDir = path.dirname(freelanceDir);

    fs.writeFileSync(
      path.join(freelanceDir, "config.yml"),
      "workflows:\n  - /nonexistent/path/workflows\n"
    );

    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs).toEqual([freelanceDir]);
    });
  });

  it("deduplicates .freelance dir if listed in config", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const freelanceDir = tmpFreelanceDir("config-dedup-");
    const tmpDir = path.dirname(freelanceDir);

    fs.writeFileSync(
      path.join(freelanceDir, "config.yml"),
      `workflows:\n  - ${freelanceDir}\n`
    );

    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs).toEqual([freelanceDir]);
    });
  });

  it("not read when FREELANCE_WORKFLOWS_DIR is set", () => {
    const freelanceDir = tmpFreelanceDir("config-env-");
    const tmpDir = path.dirname(freelanceDir);
    const pluginWorkflows = path.join(tmpDir, "plugin-workflows");
    fs.mkdirSync(pluginWorkflows, { recursive: true });
    fs.writeFileSync(
      path.join(freelanceDir, "config.yml"),
      `workflows:\n  - ${pluginWorkflows}\n`
    );

    process.env.FREELANCE_WORKFLOWS_DIR = "/a";

    const dirs = resolveDefaultGraphsDirs();
    expect(dirs).toEqual(["/a"]);
    expect(dirs).not.toContain(pluginWorkflows);

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
      path.join(fixturesDir, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
    );
    const graphs = loadGraphsOrFatal(tmpDir);
    expect(graphs.size).toBe(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits when no dirs found", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "no-graphs-"));

    withTmpEnv(emptyDir, () => {
      expect(() => loadGraphsOrFatal(null)).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });
});

describe("loadGraphsGraceful", () => {
  it("returns empty result when no dirs found", () => {
    delete process.env.FREELANCE_WORKFLOWS_DIR;
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "graceful-"));

    withTmpEnv(emptyDir, () => {
      const result = loadGraphsGraceful(null);
      expect(result.graphs).toBeInstanceOf(Map);
      expect(result.graphs.size).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  it("returns empty graphs with errors when all graphs fail validation", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graceful-bad-"));
    fs.writeFileSync(path.join(tmpDir, "bad.workflow.yaml"), "not: valid: yaml: graph");

    const result = loadGraphsGraceful(tmpDir);
    expect(result.graphs).toBeInstanceOf(Map);
    expect(result.graphs.size).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads valid graphs successfully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graceful-ok-"));
    const fixturesDir = path.resolve(import.meta.dirname, "fixtures");
    fs.copyFileSync(
      path.join(fixturesDir, "valid-simple.workflow.yaml"),
      path.join(tmpDir, "valid-simple.workflow.yaml")
    );

    const result = loadGraphsGraceful(tmpDir);
    expect(result.graphs.size).toBe(1);
    expect(result.errors).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

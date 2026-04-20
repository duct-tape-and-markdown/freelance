import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSetLocal, configShow } from "../src/cli/config.js";
import { loadConfig } from "../src/config.js";
import { tmpFreelanceDir } from "./helpers.js";

let stdoutChunks: string[];
let stderrChunks: string[];
const cleanup: string[] = [];

function makeDir(prefix?: string): string {
  const dir = tmpFreelanceDir(prefix);
  cleanup.push(path.dirname(dir));
  return dir;
}

function stdoutJson(): unknown {
  return JSON.parse(stdoutChunks.join(""));
}

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
    stdoutChunks.push(String(msg));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
    stderrChunks.push(String(msg));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("configShow", () => {
  it("outputs JSON with resolved config from a directory", () => {
    const dir = makeDir("show-");
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      `
memory:
  collections:
    - name: default
      description: General
      paths: [""]
`,
    );
    configShow({ workflows: dir });
    const parsed = stdoutJson() as {
      workflows: unknown;
      memory: unknown;
      graphsDirs: string[];
      sources: string[];
    };
    expect(parsed).toHaveProperty("workflows");
    expect(parsed).toHaveProperty("memory");
    expect(parsed.graphsDirs).toContain(dir);
    expect(parsed.sources.length).toBeGreaterThan(0);
  });

  it("outputs JSON with empty config for dir with no config files", () => {
    const dir = makeDir("show-empty-");
    configShow({ workflows: dir });
    const parsed = stdoutJson() as { graphsDirs: string[]; sources: string[] };
    expect(parsed.graphsDirs).toContain(dir);
    expect(parsed.sources).toEqual([]);
  });

  it("surfaces additional workflows from config", () => {
    const dir = makeDir("show-wf-");
    const extraDir = path.join(path.dirname(dir), "extra");
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      `
workflows:
  - ${extraDir}
`,
    );
    configShow({ workflows: dir });
    const parsed = stdoutJson() as { workflows: string[] };
    expect(parsed.workflows).toContain(extraDir);
  });
});

describe("configSetLocal", () => {
  it("sets workflows key and outputs updated config", () => {
    const dir = makeDir("set-wf-");
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });

    const parsed = stdoutJson() as { workflows: string[] };
    expect(parsed.workflows).toContain("/tmp/plugin/wf");

    const config = loadConfig(dir);
    expect(config.workflows).toContain("/tmp/plugin/wf");
  });

  it("is idempotent for workflows", () => {
    const dir = makeDir("set-idem-");
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });
    // Reset stdout capture between calls
    stdoutChunks.length = 0;
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });

    const config = loadConfig(dir);
    const matches = config.workflows.filter((w) => w === "/tmp/plugin/wf");
    expect(matches).toHaveLength(1);
  });

  it("sets memory.dir and outputs updated config", () => {
    const dir = makeDir("set-memdir-");
    configSetLocal("memory.dir", "/tmp/persistent", { workflows: dir });

    const parsed = stdoutJson() as { memory: { dir?: string } };
    expect(parsed.memory.dir).toBe("/tmp/persistent");
  });

  it("warns on stderr when overwriting memory.dir", () => {
    const dir = makeDir("set-memdir-warn-");
    configSetLocal("memory.dir", "/first", { workflows: dir });
    stderrChunks.length = 0;
    configSetLocal("memory.dir", "/second", { workflows: dir });

    expect(stderrChunks.join("")).toContain("Warning: memory.dir already set");
  });

  it("sets memory.enabled and outputs updated config", () => {
    const dir = makeDir("set-enabled-");
    configSetLocal("memory.enabled", "false", { workflows: dir });
    const parsed = stdoutJson() as { memory: { enabled?: boolean } };
    expect(parsed.memory.enabled).toBe(false);
  });

  it("rejects invalid memory.enabled value with INVALID_INPUT (exit 5)", () => {
    const dir = makeDir("set-bad-enabled-");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => configSetLocal("memory.enabled", "yes", { workflows: dir })).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(5);
    const parsed = stdoutJson() as { isError: true; error: { code: string } };
    expect(parsed.isError).toBe(true);
    expect(parsed.error.code).toBe("INVALID_CONFIG_VALUE");
  });

  it("rejects unknown key with INVALID_INPUT (exit 5)", () => {
    const dir = makeDir("set-unknown-");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => configSetLocal("bad.key", "val", { workflows: dir })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(5);
    const parsed = stdoutJson() as { isError: true; error: { code: string; message: string } };
    expect(parsed.error.code).toBe("UNKNOWN_CONFIG_KEY");
    expect(parsed.error.message).toContain("bad.key");
  });
});

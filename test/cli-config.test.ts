import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSetLocal, configShow } from "../src/cli/config.js";
import { setCli } from "../src/cli/output.js";
import { loadConfig } from "../src/config.js";
import { tmpFreelanceDir } from "./helpers.js";

let stderrOutput: string[];
const cleanup: string[] = [];

function makeDir(prefix?: string): string {
  const dir = tmpFreelanceDir(prefix);
  cleanup.push(path.dirname(dir));
  return dir;
}

beforeEach(() => {
  stderrOutput = [];
  vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
    stderrOutput.push(String(msg));
    return true;
  });
  setCli({ json: false, quiet: false, verbose: false, noColor: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("configShow", () => {
  it("shows resolved config from a directory", () => {
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
    const output = stderrOutput.join("");
    expect(output).toContain("Graph directories:");
    expect(output).toContain(dir);
    expect(output).toContain("Loaded from:");
  });

  it("shows empty config for dir with no config files", () => {
    const dir = makeDir("show-empty-");
    configShow({ workflows: dir });
    const output = stderrOutput.join("");
    expect(output).toContain("Graph directories:");
    expect(output).toContain("enabled: true (default)");
    expect(output).not.toContain("Loaded from:");
  });

  it("outputs JSON when --json is set", () => {
    const dir = makeDir("show-json-");
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
      stdoutChunks.push(String(msg));
      return true;
    });
    setCli({ json: true, quiet: false, verbose: false, noColor: false });

    configShow({ workflows: dir });
    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed).toHaveProperty("workflows");
    expect(parsed).toHaveProperty("memory");
    expect(parsed).toHaveProperty("graphsDirs");
  });

  it("shows additional workflows from config", () => {
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
    const output = stderrOutput.join("");
    expect(output).toContain("Additional workflows");
    expect(output).toContain(extraDir);
  });
});

describe("configSetLocal", () => {
  it("sets workflows key", () => {
    const dir = makeDir("set-wf-");
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });

    const config = loadConfig(dir);
    expect(config.workflows).toContain("/tmp/plugin/wf");
    expect(stderrOutput.join("")).toContain("Added workflow directory");
  });

  it("is idempotent for workflows", () => {
    const dir = makeDir("set-idem-");
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });
    configSetLocal("workflows", "/tmp/plugin/wf", { workflows: dir });

    const config = loadConfig(dir);
    const matches = config.workflows.filter((w) => w === "/tmp/plugin/wf");
    expect(matches).toHaveLength(1);
  });

  it("sets memory.dir", () => {
    const dir = makeDir("set-memdir-");
    configSetLocal("memory.dir", "/tmp/persistent", { workflows: dir });

    const config = loadConfig(dir);
    expect(config.memory.dir).toBe("/tmp/persistent");
    expect(stderrOutput.join("")).toContain("Set memory.dir");
  });

  it("warns when overwriting memory.dir", () => {
    const dir = makeDir("set-memdir-warn-");
    configSetLocal("memory.dir", "/first", { workflows: dir });
    configSetLocal("memory.dir", "/second", { workflows: dir });

    const config = loadConfig(dir);
    expect(config.memory.dir).toBe("/second");
    expect(stderrOutput.join("")).toContain("Warning: memory.dir already set");
  });

  it("sets memory.enabled", () => {
    const dir = makeDir("set-enabled-");
    configSetLocal("memory.enabled", "false", { workflows: dir });

    const config = loadConfig(dir);
    expect(config.memory.enabled).toBe(false);
  });

  it("rejects invalid memory.enabled value", () => {
    const dir = makeDir("set-bad-enabled-");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => configSetLocal("memory.enabled", "yes", { workflows: dir })).toThrow(
      "process.exit",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects unknown key", () => {
    const dir = makeDir("set-unknown-");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => configSetLocal("bad.key", "val", { workflows: dir })).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderrOutput.join("")).toContain("Unknown config key");
  });

  it("outputs JSON when --json is set", () => {
    const dir = makeDir("set-json-");
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
      stdoutChunks.push(String(msg));
      return true;
    });
    setCli({ json: true, quiet: false, verbose: false, noColor: false });

    configSetLocal("memory.enabled", "true", { workflows: dir });
    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.memory.enabled).toBe(true);
  });
});

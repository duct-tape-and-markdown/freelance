import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadConfigFromDirs, updateLocalConfig } from "../src/config.js";
import { tmpFreelanceDir } from "./helpers.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a tmp .freelance dir and register it for cleanup. */
function makeDir(prefix?: string): string {
  const dir = tmpFreelanceDir(prefix);
  cleanup.push(path.dirname(dir));
  return dir;
}

describe("loadConfig", () => {
  it("returns empty config when no files exist", () => {
    const dir = makeDir();
    const config = loadConfig(dir);
    expect(config.workflows).toEqual([]);
    expect(config.memory).toEqual({});
    expect(config.sources).toEqual([]);
  });

  it("reads config.yml", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "config.yml"), `
memory:
  ignore:
    - "**/node_modules/**"
  collections:
    - name: default
      description: General
      paths: [""]
`);
    const config = loadConfig(dir);
    expect(config.memory.ignore).toEqual(["**/node_modules/**"]);
    expect(config.memory.collections).toHaveLength(1);
    expect(config.memory.collections![0].name).toBe("default");
    expect(config.sources).toHaveLength(1);
  });

  it("merges config.local.yml over config.yml", () => {
    const dir = makeDir();
    const pluginDir = path.join(path.dirname(dir), "plugin-wf");
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(path.join(dir, "config.yml"), `
memory:
  ignore:
    - "**/dist/**"
`);
    fs.writeFileSync(path.join(dir, "config.local.yml"), `
workflows:
  - ${pluginDir}
memory:
  dir: /tmp/persistent
  ignore:
    - "**/cache/**"
`);
    const config = loadConfig(dir);
    expect(config.workflows).toEqual([pluginDir]);
    expect(config.memory.dir).toBe("/tmp/persistent");
    expect(config.memory.ignore).toEqual(["**/dist/**", "**/cache/**"]);
    expect(config.sources).toHaveLength(2);
  });

  it("local scalars override base scalars", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "config.yml"), `
memory:
  enabled: true
  dir: /base/path
`);
    fs.writeFileSync(path.join(dir, "config.local.yml"), `
memory:
  dir: /local/path
`);
    const config = loadConfig(dir);
    expect(config.memory.dir).toBe("/local/path");
    expect(config.memory.enabled).toBe(true);
  });

  it("resolves relative workflow paths relative to config dir", () => {
    const dir = makeDir();
    const parent = path.dirname(dir);
    const relTarget = path.join(parent, "relative-wf");
    fs.mkdirSync(relTarget, { recursive: true });

    fs.writeFileSync(path.join(dir, "config.yml"), `
workflows:
  - ../relative-wf
`);
    const config = loadConfig(dir);
    expect(config.workflows).toEqual([relTarget]);
  });

  it("ignores malformed config.yml", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "config.yml"), "not: valid: yaml: {{");
    const config = loadConfig(dir);
    expect(config.workflows).toEqual([]);
    expect(config.sources).toEqual([]);
  });
});

describe("loadConfigFromDirs", () => {
  it("merges config across multiple directories", () => {
    const dir1 = makeDir();
    const dir2 = makeDir();

    fs.writeFileSync(path.join(dir1, "config.yml"), `
memory:
  ignore:
    - "*.log"
`);
    fs.writeFileSync(path.join(dir2, "config.yml"), `
memory:
  ignore:
    - "*.tmp"
`);

    const config = loadConfigFromDirs([dir1, dir2]);
    expect(config.memory.ignore).toEqual(["*.log", "*.tmp"]);
    expect(config.sources).toHaveLength(2);
  });

  it("returns empty config for no dirs", () => {
    const config = loadConfigFromDirs([]);
    expect(config.workflows).toEqual([]);
    expect(config.memory).toEqual({});
    expect(config.sources).toEqual([]);
  });
});

describe("updateLocalConfig", () => {
  it("creates config.local.yml if missing", () => {
    const dir = makeDir();
    updateLocalConfig(dir, (c) => ({ ...c, workflows: ["/new/path"] }));

    const localPath = path.join(dir, "config.local.yml");
    expect(fs.existsSync(localPath)).toBe(true);
    const content = fs.readFileSync(localPath, "utf-8");
    expect(content).toContain("/new/path");
  });

  it("preserves existing values when updating", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "config.local.yml"), `
workflows:
  - /existing/path
`);
    updateLocalConfig(dir, (c) => ({
      ...c,
      memory: { dir: "/persistent" },
    }));

    const config = loadConfig(dir);
    expect(config.workflows).toContain("/existing/path");
    expect(config.memory.dir).toBe("/persistent");
  });
});

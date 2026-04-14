/**
 * Integration tests for the config system — realistic scenarios that
 * exercise the full path from config files through to resolution.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configSetLocal } from "../src/cli/config.js";
import { ensureFreelanceDir, resolveMemoryConfig } from "../src/cli/setup.js";
import { loadConfig, loadConfigFromDirs } from "../src/config.js";
import { resolveDefaultGraphsDirs } from "../src/graph-resolution.js";
import { tmpFreelanceDir, withTmpEnv } from "./helpers.js";

const cleanup: string[] = [];

function makeDir(prefix?: string): string {
  const dir = tmpFreelanceDir(prefix);
  cleanup.push(path.dirname(dir));
  return dir;
}

afterEach(() => {
  delete process.env.FREELANCE_WORKFLOWS_DIR;
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin hook flow", () => {
  it("set-local workflows → resolveDefaultGraphsDirs picks them up", () => {
    const freelanceDir = makeDir("plugin-flow-");
    const tmpDir = path.dirname(freelanceDir);
    const pluginWorkflows = path.join(tmpDir, "plugin-workflows");
    fs.mkdirSync(pluginWorkflows);

    // Simulate plugin SessionStart hook
    configSetLocal("workflows", pluginWorkflows, { workflows: freelanceDir });

    // Verify config.local.yml was written correctly
    const localPath = path.join(freelanceDir, "config.local.yml");
    expect(fs.existsSync(localPath)).toBe(true);

    // Verify resolveDefaultGraphsDirs discovers the plugin workflows
    withTmpEnv(tmpDir, () => {
      const dirs = resolveDefaultGraphsDirs();
      expect(dirs).toContain(freelanceDir);
      expect(dirs).toContain(pluginWorkflows);
    });
  });

  it("set-local memory.dir → resolveMemoryConfig uses it", () => {
    const freelanceDir = makeDir("plugin-mem-");
    const persistentDir = path.join(path.dirname(freelanceDir), "persistent");

    // Simulate plugin hook setting memory dir
    configSetLocal("memory.dir", persistentDir, { workflows: freelanceDir });

    // Verify memory resolution picks up the override
    const memConfig = resolveMemoryConfig([freelanceDir], {});
    expect(memConfig).not.toBeNull();
    expect(memConfig!.db).toBe(path.join(persistentDir, "memory.db"));

    // Cleanup created dir
    if (fs.existsSync(persistentDir)) {
      fs.rmSync(persistentDir, { recursive: true, force: true });
    }
  });

  it("set-local workflows is idempotent across multiple hook runs", () => {
    const freelanceDir = makeDir("plugin-idem-");
    const pluginDir = `/tmp/plugin-wf-${Date.now()}`;

    // Simulate hook running on three separate sessions
    configSetLocal("workflows", pluginDir, { workflows: freelanceDir });
    configSetLocal("workflows", pluginDir, { workflows: freelanceDir });
    configSetLocal("workflows", pluginDir, { workflows: freelanceDir });

    const config = loadConfig(freelanceDir);
    const matches = config.workflows.filter((w) => w === pluginDir);
    expect(matches).toHaveLength(1);
  });
});

describe("config + memory resolution", () => {
  it("config.yml memory.enabled=false disables memory", () => {
    const freelanceDir = makeDir("mem-disabled-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "memory:\n  enabled: false\n");

    const memConfig = resolveMemoryConfig([freelanceDir], {});
    expect(memConfig).toBeNull();
  });

  it("CLI --no-memory overrides config.yml memory.enabled=true", () => {
    const freelanceDir = makeDir("mem-cli-override-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "memory:\n  enabled: true\n");

    const memConfig = resolveMemoryConfig([freelanceDir], { memory: false });
    expect(memConfig).toBeNull();
  });

  it("CLI --memory-dir overrides config.local.yml memory.dir", () => {
    const freelanceDir = makeDir("mem-dir-precedence-");
    const configDir = path.join(path.dirname(freelanceDir), "config-mem");
    const cliDir = path.join(path.dirname(freelanceDir), "cli-mem");

    fs.writeFileSync(path.join(freelanceDir, "config.local.yml"), `memory:\n  dir: ${configDir}\n`);

    const memConfig = resolveMemoryConfig([freelanceDir], { memoryDir: cliDir });
    expect(memConfig).not.toBeNull();
    expect(memConfig!.db).toBe(path.join(cliDir, "memory.db"));

    // Cleanup created dirs
    for (const d of [configDir, cliDir]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("CLI --memory overrides config.yml memory.enabled=false", () => {
    // Symmetric to the --no-memory test above: CLI flag should win
    // in both directions, enabling memory that config disables.
    const freelanceDir = makeDir("mem-force-on-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "memory:\n  enabled: false\n");

    const memConfig = resolveMemoryConfig([freelanceDir], { memory: true });
    expect(memConfig).not.toBeNull();
    expect(memConfig!.enabled).toBe(true);
  });
});

describe("maxDepth precedence", () => {
  it("reads maxDepth from config.yml", () => {
    const freelanceDir = makeDir("maxdepth-config-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "maxDepth: 12\n");

    const cfg = loadConfigFromDirs([freelanceDir]);
    expect(cfg.maxDepth).toBe(12);
  });

  it("config.local.yml overrides config.yml maxDepth", () => {
    const freelanceDir = makeDir("maxdepth-local-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "maxDepth: 5\n");
    fs.writeFileSync(path.join(freelanceDir, "config.local.yml"), "maxDepth: 20\n");

    const cfg = loadConfigFromDirs([freelanceDir]);
    expect(cfg.maxDepth).toBe(20);
  });

  it("maxDepth absent from config resolves to undefined", () => {
    const freelanceDir = makeDir("maxdepth-absent-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "memory:\n  enabled: true\n");

    const cfg = loadConfigFromDirs([freelanceDir]);
    expect(cfg.maxDepth).toBeUndefined();
  });
});

describe("hooks.timeoutMs precedence", () => {
  it("reads hooks.timeoutMs from config.yml", () => {
    const freelanceDir = makeDir("hooks-timeout-config-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "hooks:\n  timeoutMs: 10000\n");

    const cfg = loadConfigFromDirs([freelanceDir]);
    expect(cfg.hooks.timeoutMs).toBe(10000);
  });

  it("config.local.yml overrides config.yml hooks.timeoutMs", () => {
    const freelanceDir = makeDir("hooks-timeout-local-");
    fs.writeFileSync(path.join(freelanceDir, "config.yml"), "hooks:\n  timeoutMs: 5000\n");
    fs.writeFileSync(path.join(freelanceDir, "config.local.yml"), "hooks:\n  timeoutMs: 15000\n");

    const cfg = loadConfigFromDirs([freelanceDir]);
    expect(cfg.hooks.timeoutMs).toBe(15000);
  });
});

describe("multi-dir config merge", () => {
  it("merges project config.yml + user config.yml + user config.local.yml", () => {
    const projectDir = makeDir("project-");
    const userDir = makeDir("user-");

    fs.writeFileSync(
      path.join(projectDir, "config.yml"),
      `
memory:
  collections:
    - name: project
      description: Project knowledge
      paths: ["src/"]
`,
    );
    fs.writeFileSync(
      path.join(userDir, "config.yml"),
      `
memory:
  collections:
    - name: user
      description: User knowledge
      paths: [""]
`,
    );
    fs.writeFileSync(
      path.join(userDir, "config.local.yml"),
      `
memory:
  dir: /tmp/user-persistent
`,
    );

    const config = loadConfigFromDirs([projectDir, userDir]);

    // Arrays concatenate across directories
    expect(config.memory.collections).toHaveLength(2);
    expect(config.memory.collections!.map((c) => c.name)).toEqual(["project", "user"]);

    // Scalar from user's local overrides
    expect(config.memory.dir).toBe("/tmp/user-persistent");

    // All three files tracked as sources
    expect(config.sources).toHaveLength(3);
  });

  it("workflows from multiple dirs are all discovered", () => {
    const projectDir = makeDir("multi-proj-");
    const userDir = makeDir("multi-user-");
    const extraA = path.join(path.dirname(projectDir), "extra-a");
    const extraB = path.join(path.dirname(userDir), "extra-b");
    fs.mkdirSync(extraA);
    fs.mkdirSync(extraB);

    fs.writeFileSync(path.join(projectDir, "config.yml"), `workflows:\n  - ${extraA}\n`);
    fs.writeFileSync(path.join(userDir, "config.local.yml"), `workflows:\n  - ${extraB}\n`);

    const config = loadConfigFromDirs([projectDir, userDir]);
    expect(config.workflows).toContain(extraA);
    expect(config.workflows).toContain(extraB);
  });
});

describe(".gitignore auto-generation", () => {
  it("ensureFreelanceDir creates .gitignore covering runtime artifacts", () => {
    const freelanceDir = makeDir("gitignore-");
    ensureFreelanceDir(freelanceDir);

    const ignorePath = path.join(freelanceDir, ".gitignore");
    expect(fs.existsSync(ignorePath)).toBe(true);

    const content = fs.readFileSync(ignorePath, "utf-8");
    expect(content).toContain("memory/");
    expect(content).toContain("traversals/");
    expect(content).toContain("config.local.yml");
  });

  it("does not overwrite existing .gitignore", () => {
    const freelanceDir = makeDir("gitignore-existing-");
    const ignorePath = path.join(freelanceDir, ".gitignore");
    fs.writeFileSync(ignorePath, "custom-content\n");

    ensureFreelanceDir(freelanceDir);

    const content = fs.readFileSync(ignorePath, "utf-8");
    expect(content).toBe("custom-content\n");
  });
});

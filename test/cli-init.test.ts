import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, type InitOptions } from "../src/cli/init.js";
import { setCli } from "../src/cli/output.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-init-test-"));
}

function defaults(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    scope: "project",
    client: "claude-code",
    starter: "change-request",
    daemon: false,
    dryRun: false,
    ...overrides,
  };
}

describe("CLI init", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let workDir: string;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
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

  it("creates graphs directory", async () => {
    await init(defaults());
    expect(fs.existsSync(path.join(workDir, "graphs"))).toBe(true);
  });

  it("copies starter template", async () => {
    await init(defaults());
    const graphFile = path.join(workDir, "graphs", "change-request.graph.yaml");
    expect(fs.existsSync(graphFile)).toBe(true);
    const content = fs.readFileSync(graphFile, "utf-8");
    expect(content).toContain("change-request");
  });

  it("writes .mcp.json for claude-code project scope", async () => {
    await init(defaults());
    const mcpJson = path.join(workDir, ".mcp.json");
    expect(fs.existsSync(mcpJson)).toBe(true);
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    expect(config.mcpServers.freelance).toBeDefined();
    expect(config.mcpServers.freelance.command).toBe("npx");
  });

  it("writes cursor config for cursor client", async () => {
    await init(defaults({ client: "cursor" }));
    const cursorJson = path.join(workDir, ".cursor", "mcp.json");
    expect(fs.existsSync(cursorJson)).toBe(true);
    const config = JSON.parse(fs.readFileSync(cursorJson, "utf-8"));
    expect(config.mcpServers.freelance).toBeDefined();
  });

  it("appends CLAUDE.md with workflow instructions", async () => {
    await init(defaults());
    const claudeMd = path.join(workDir, "CLAUDE.md");
    expect(fs.existsSync(claudeMd)).toBe(true);
    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("graph_list");
    expect(content).toContain("graph_start");
    expect(content).toContain("graph_inspect");
  });

  it("appends to existing CLAUDE.md without duplicating", async () => {
    fs.writeFileSync(path.join(workDir, "CLAUDE.md"), "# My Project\n\nExisting content.\n");
    await init(defaults());

    const content = fs.readFileSync(path.join(workDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Existing content.");
    expect(content).toContain("graph_list");

    // Run again — should not duplicate
    await init(defaults());
    const content2 = fs.readFileSync(path.join(workDir, "CLAUDE.md"), "utf-8");
    const matches = content2.match(/graph_list/g);
    expect(matches).toHaveLength(1);
  });

  it("preserves existing keys in .mcp.json", async () => {
    const mcpJson = path.join(workDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ mcpServers: { other: { command: "other-tool" } } }, null, 2)
    );

    await init(defaults());
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.other.command).toBe("other-tool");
    expect(config.mcpServers.freelance).toBeDefined();
  });

  it("skips starter when starter=none", async () => {
    await init(defaults({ starter: "none" }));
    const graphs = fs.readdirSync(path.join(workDir, "graphs"));
    expect(graphs).toHaveLength(0);
  });

  it("skips CLAUDE.md for non-claude-code clients", async () => {
    await init(defaults({ client: "cursor" }));
    expect(fs.existsSync(path.join(workDir, "CLAUDE.md"))).toBe(false);
  });

  it("daemon mode sets --connect in MCP args", async () => {
    await init(defaults({ daemon: true, daemonPort: 9999 }));
    const mcpJson = path.join(workDir, ".mcp.json");
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    const args = config.mcpServers.freelance.args as string[];
    expect(args).toContain("--connect");
    expect(args).toContain("localhost:9999");
  });

  it("dry-run creates no files", async () => {
    await init(defaults({ dryRun: true }));
    expect(fs.existsSync(path.join(workDir, "graphs"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, "CLAUDE.md"))).toBe(false);
  });

  it("dry-run JSON output describes planned actions", async () => {
    setCli({ json: true });
    await init(defaults({ dryRun: true }));
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(output);
    expect(result.dryRun).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("JSON output lists created files", async () => {
    setCli({ json: true });
    await init(defaults());
    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const result = JSON.parse(output);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.scope).toBe("project");
    expect(result.client).toBe("claude-code");
  });

  it("manual client prints config to stdout instead of writing file", async () => {
    await init(defaults({ client: "manual" }));
    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.mcpServers.freelance).toBeDefined();
    // No .mcp.json or other config file created
    expect(fs.existsSync(path.join(workDir, ".mcp.json"))).toBe(false);
  });

  it("each starter template copies correctly", async () => {
    for (const starter of ["change-request", "data-pipeline", "ralph-loop", "blank"] as const) {
      const dir = tmpDir();
      process.chdir(dir);
      await init(defaults({ starter, client: "manual" }));
      const graphFile = path.join(dir, "graphs", `${starter}.graph.yaml`);
      expect(fs.existsSync(graphFile), `${starter} template missing`).toBe(true);
    }
  });

  it("custom --graphs path creates directory at specified location", async () => {
    const customDir = path.join(workDir, "custom", "workflows");
    await init(defaults({ graphs: customDir, client: "manual" }));
    expect(fs.existsSync(customDir)).toBe(true);
    expect(fs.existsSync(path.join(customDir, "change-request.graph.yaml"))).toBe(true);
  });

  it("does not overwrite existing graph file", async () => {
    const graphsDir = path.join(workDir, "graphs");
    fs.mkdirSync(graphsDir, { recursive: true });
    const graphFile = path.join(graphsDir, "change-request.graph.yaml");
    fs.writeFileSync(graphFile, "# custom content\nid: change-request\n");

    await init(defaults({ client: "manual" }));
    const content = fs.readFileSync(graphFile, "utf-8");
    expect(content).toContain("# custom content");
  });

  it("throws on invalid JSON in existing config file", async () => {
    const mcpJson = path.join(workDir, ".mcp.json");
    fs.writeFileSync(mcpJson, "{ broken json !!!");

    await expect(init(defaults())).rejects.toThrow(/invalid JSON/);
  });

  it("MCP config uses relative path for project scope", async () => {
    await init(defaults());
    const mcpJson = path.join(workDir, ".mcp.json");
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    const args = config.mcpServers.freelance.args as string[];
    const graphsArg = args[args.indexOf("--graphs") + 1];
    expect(graphsArg).toBe("./graphs");
  });

  it("user scope writes config to ~/.claude.json", async () => {
    const fakeHome = tmpDir();
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await init(defaults({ scope: "user", client: "claude-code" }));
      const claudeJson = path.join(fakeHome, ".claude.json");
      expect(fs.existsSync(claudeJson)).toBe(true);
      const config = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      expect(config.mcpServers.freelance).toBeDefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("user scope uses absolute path for graphs dir", async () => {
    const fakeHome = tmpDir();
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await init(defaults({ scope: "user", client: "claude-code" }));
      const claudeJson = path.join(fakeHome, ".claude.json");
      const config = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      const args = config.mcpServers.freelance.args as string[];
      const graphsArg = args[args.indexOf("--graphs") + 1];
      expect(path.isAbsolute(graphsArg)).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("user scope default graphs dir is ~/.freelance/graphs", async () => {
    const fakeHome = tmpDir();
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await init(defaults({ scope: "user", client: "claude-code", starter: "none" }));
      const expectedGraphsDir = path.join(fakeHome, ".freelance", "graphs");
      expect(fs.existsSync(expectedGraphsDir)).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("windsurf config writes to ~/.codeium/windsurf/mcp_config.json", async () => {
    const fakeHome = tmpDir();
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await init(defaults({ client: "windsurf" }));
      const configPath = path.join(fakeHome, ".codeium", "windsurf", "mcp_config.json");
      expect(fs.existsSync(configPath)).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(config.mcpServers.freelance).toBeDefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("cline config writes to .vscode/mcp.json", async () => {
    await init(defaults({ client: "cline" }));
    const configPath = path.join(workDir, ".vscode", "mcp.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(config.mcpServers.freelance).toBeDefined();
  });

  it("daemon mode without explicit port defaults to 7433", async () => {
    await init(defaults({ daemon: true }));
    const mcpJson = path.join(workDir, ".mcp.json");
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    const args = config.mcpServers.freelance.args as string[];
    expect(args).toContain("--connect");
    expect(args).toContain("localhost:7433");
  });

  it("CLAUDE.md skipped when existing content contains 'Freelance'", async () => {
    fs.writeFileSync(
      path.join(workDir, "CLAUDE.md"),
      "# My Project\n\nThis project uses Freelance for workflow enforcement.\n"
    );
    await init(defaults());
    const content = fs.readFileSync(path.join(workDir, "CLAUDE.md"), "utf-8");
    // Should NOT have appended the workflow instructions section
    expect(content).not.toContain("graph_context_set");
  });

  it("preserves non-mcpServers keys in existing config", async () => {
    const mcpJson = path.join(workDir, ".mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({ customKey: "preserved", settings: { debug: true } }, null, 2)
    );
    await init(defaults());
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    expect(config.customKey).toBe("preserved");
    expect(config.settings.debug).toBe(true);
    expect(config.mcpServers.freelance).toBeDefined();
  });

  it("creates mcpServers key when absent from existing config", async () => {
    const mcpJson = path.join(workDir, ".mcp.json");
    fs.writeFileSync(mcpJson, JSON.stringify({ otherStuff: true }, null, 2));
    await init(defaults());
    const config = JSON.parse(fs.readFileSync(mcpJson, "utf-8"));
    expect(config.otherStuff).toBe(true);
    expect(config.mcpServers.freelance).toBeDefined();
  });

  it("dry-run human output lists planned actions", async () => {
    await init(defaults({ dryRun: true }));
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("Dry run");
    expect(stderr).toContain("Would create:");
    expect(stderr).toContain("Would configure:");
    expect(stderr).toContain("Run without --dry-run");
  });

  it("dry-run with existing graph shows 'Would skip'", async () => {
    const graphsDir = path.join(workDir, "graphs");
    fs.mkdirSync(graphsDir, { recursive: true });
    fs.writeFileSync(path.join(graphsDir, "change-request.graph.yaml"), "id: cr\n");
    await init(defaults({ dryRun: true }));
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("Would skip:");
  });

  it("human output includes checkmarks and next steps", async () => {
    await init(defaults());
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("\u2713");
    expect(stderr).toContain("Next steps:");
    expect(stderr).toContain("graph_list");
  });

  it("writes SessionStart hook for claude-code client", async () => {
    await init(defaults());
    const settingsPath = path.join(workDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks?.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("freelance");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("inspect");
  });

  it("does not duplicate SessionStart hook on re-init", async () => {
    await init(defaults());
    await init(defaults());
    const settingsPath = path.join(workDir, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("preserves existing settings when adding hook", async () => {
    const settingsDir = path.join(workDir, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({ customSetting: true }, null, 2)
    );
    await init(defaults());
    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, "settings.json"), "utf-8"));
    expect(settings.customSetting).toBe(true);
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  });

  it("skips SessionStart hook for non-claude-code clients", async () => {
    await init(defaults({ client: "cursor" }));
    const settingsPath = path.join(workDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);
  });
});

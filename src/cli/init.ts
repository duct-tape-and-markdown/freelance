import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cli, outputJson, info, fatal, EXIT, homeDir, displayPath } from "./output.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "project" writes config into the repo (committed/shared with team).
// "user" writes config into ~/.claude.json (personal, all projects).
export type Scope = "project" | "user";
export type Client = "claude-code" | "cursor" | "windsurf" | "cline" | "manual";
export type Starter = "change-request" | "data-pipeline" | "ralph-loop" | "blank" | "none";

export interface InitOptions {
  scope: Scope;
  client: Client;
  graphs?: string;
  starter: Starter;
  daemon: boolean;
  daemonPort?: number;
  dryRun: boolean;
}

export const INIT_DEFAULTS = {
  starter: "change-request" as Starter,
  daemon: false,
  dryRun: false,
} as const;

// --- Template resolution ---

function getTemplatesDir(): string {
  // In compiled form: dist/cli/init.js → ../../templates/
  // In source form: src/cli/init.ts → ../../templates/
  const candidate = path.resolve(__dirname, "..", "..", "templates");
  if (fs.existsSync(candidate)) return candidate;

  // Fallback: look relative to process.cwd() (for development)
  const cwdCandidate = path.resolve(process.cwd(), "templates");
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  throw new Error(
    "Could not find templates directory. Is the package installed correctly?"
  );
}

// --- Client detection ---

export function detectClients(): Client[] {
  const detected: Client[] = [];

  // Check for Claude Code CLI
  const envPath = process.env.PATH;
  if (!envPath) return detected;
  const pathDirs = envPath.split(path.delimiter);
  for (const dir of pathDirs) {
    if (fs.existsSync(path.join(dir, "claude"))) {
      detected.push("claude-code");
      break;
    }
  }

  // Check for Cursor
  if (fs.existsSync(path.join(process.cwd(), ".cursor"))) {
    detected.push("cursor");
  }

  // Check for Windsurf
  const home = homeDir();
  if (fs.existsSync(path.join(home, ".codeium", "windsurf"))) {
    detected.push("windsurf");
  }

  return detected;
}

// --- Config writing ---

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJsonFile(filePath: string): McpConfig {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${filePath} contains invalid JSON: ${err instanceof Error ? err.message : err}\n\n  Fix the JSON syntax and retry, or delete the file to start fresh.`
    );
  }
}

function writeJsonFile(filePath: string, data: McpConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function getMcpEntry(graphsPath: string, daemon?: boolean, daemonPort?: number): Record<string, unknown> {
  if (daemon) {
    const port = daemonPort ?? 7433;
    return {
      command: "npx",
      args: ["-y", "freelance@latest", "mcp", "--connect", `localhost:${port}`],
    };
  }
  return {
    command: "npx",
    args: ["-y", "freelance@latest", "mcp", "--graphs", graphsPath],
  };
}

function getConfigPath(client: Client, scope: Scope): string {
  const home = homeDir();

  switch (client) {
    case "claude-code":
      if (scope === "user") {
        return path.join(home, ".claude.json");
      }
      return path.join(process.cwd(), ".mcp.json");

    case "cursor":
      return path.join(process.cwd(), ".cursor", "mcp.json");

    case "windsurf":
      return path.join(home, ".codeium", "windsurf", "mcp_config.json");

    case "cline":
      return path.join(process.cwd(), ".vscode", "mcp.json");

    case "manual":
      return "";

    default: {
      const _exhaustive: never = client;
      return _exhaustive;
    }
  }
}

function writeClientConfig(
  client: Client,
  scope: Scope,
  graphsPath: string,
  daemon?: boolean,
  daemonPort?: number
): string | null {
  if (client === "manual") return null;

  const configPath = getConfigPath(client, scope);
  if (!configPath) return null;

  const config = readJsonFile(configPath);
  if (!config.mcpServers) config.mcpServers = {};

  const servers = config.mcpServers as Record<string, unknown>;
  servers.freelance = getMcpEntry(graphsPath, daemon, daemonPort);
  writeJsonFile(configPath, config);
  return configPath;
}

// --- CLAUDE.md append ---

const CLAUDE_MD_SECTION = `## Workflow execution

This project uses Freelance to enforce structured workflows.
Freelance is an MCP server — its tools are available automatically.

Call \`graph_list\` to see available workflows.
Call \`graph_start\` with a graph ID to begin a workflow.
Call \`graph_inspect\` if you lose track of where you are.

During a traversal:
1. Read the instructions at each node and execute them
2. Update context via \`graph_context_set\` as you complete work
3. Advance via \`graph_advance\` with the appropriate edge label
4. Continue until you reach a terminal node

Never skip nodes. If \`graph_advance\` returns an error, read it — it tells you what's wrong.`;

// --- SessionStart hook ---

const HOOK_COMMAND = "npx -y freelance@latest inspect --active --oneline";

interface ClaudeSettings {
  hooks?: {
    SessionStart?: Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function writeSessionStartHook(): string | null {
  const settingsDir = path.join(process.cwd(), ".claude");
  const settingsPath = path.join(settingsDir, "settings.json");

  const settings: ClaudeSettings = readJsonFile(settingsPath) as ClaudeSettings;

  // Check if hook already exists
  if (settings.hooks?.SessionStart) {
    const existing = JSON.stringify(settings.hooks.SessionStart);
    if (existing.includes("freelance") && existing.includes("inspect")) {
      return null; // Already configured
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

  settings.hooks.SessionStart.push({
    matcher: "",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });

  writeJsonFile(settingsPath, settings as McpConfig);
  return settingsPath;
}

function wouldWriteSessionStartHook(): boolean {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return true;

  const raw = fs.readFileSync(settingsPath, "utf-8");
  return !(raw.includes("freelance") && raw.includes("inspect"));
}

function appendClaudeMd(): boolean {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");

  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    if (content.includes("graph_list") || content.includes("Freelance")) {
      return false;
    }
    fs.writeFileSync(claudeMdPath, content.trimEnd() + "\n\n" + CLAUDE_MD_SECTION + "\n");
  } else {
    fs.writeFileSync(claudeMdPath, CLAUDE_MD_SECTION + "\n");
  }
  return true;
}

function wouldAppendClaudeMd(): boolean {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    return !content.includes("graph_list") && !content.includes("Freelance");
  }
  return true;
}

// --- Main init ---

function printManualConfig(graphsPath: string, daemon?: boolean, daemonPort?: number): void {
  const entry = getMcpEntry(graphsPath, daemon, daemonPort);
  info("\nAdd this to your MCP client configuration:\n");
  process.stdout.write(JSON.stringify({ mcpServers: { freelance: entry } }, null, 2) + "\n");
}

export async function init(options: InitOptions): Promise<void> {
  const scope = options.scope;
  const client = options.client;
  const daemon = options.daemon;
  const starter = options.starter;
  const dryRun = options.dryRun;

  const home = homeDir();

  // Determine graphs directory
  let graphsDir: string;
  if (options.graphs) {
    graphsDir = path.resolve(options.graphs);
  } else if (scope === "user") {
    graphsDir = path.join(home, ".freelance", "graphs");
  } else {
    graphsDir = path.resolve("graphs");
  }

  // The path to use in MCP config (relative for local/project, absolute for user)
  const graphsConfigPath =
    scope === "user"
      ? graphsDir
      : `./${path.relative(process.cwd(), graphsDir)}`;

  // Collect actions for dry-run or execution
  interface Action {
    verb: "create" | "append" | "configure" | "skip";
    target: string;
    detail?: string;
  }
  const actions: Action[] = [];

  // 1. Graphs directory
  if (!fs.existsSync(graphsDir)) {
    actions.push({ verb: "create", target: `${graphsConfigPath}/` });
  }

  // 2. Starter graph
  if (starter !== "none") {
    const destFile = path.join(graphsDir, `${starter}.graph.yaml`);
    if (!fs.existsSync(destFile)) {
      actions.push({ verb: "create", target: `${graphsConfigPath}/${starter}.graph.yaml` });
    } else {
      actions.push({ verb: "skip", target: `${starter}.graph.yaml`, detail: "already exists" });
    }
  }

  // 3. MCP config
  if (client === "manual") {
    actions.push({ verb: "configure", target: "stdout", detail: "print config snippet" });
  } else {
    const configPath = getConfigPath(client, scope);
    if (configPath) {
      actions.push({ verb: "configure", target: displayPath(configPath), detail: `${scope} scope` });
    }
  }

  // 4. CLAUDE.md
  if (scope === "project" && client === "claude-code") {
    if (wouldAppendClaudeMd()) {
      const claudeExists = fs.existsSync(path.join(process.cwd(), "CLAUDE.md"));
      actions.push({
        verb: claudeExists ? "append" : "create",
        target: "CLAUDE.md",
        detail: "workflow instructions section",
      });
    } else {
      actions.push({ verb: "skip", target: "CLAUDE.md", detail: "already has Freelance instructions" });
    }
  }

  // 5. SessionStart hook for claude-code
  if (client === "claude-code") {
    if (wouldWriteSessionStartHook()) {
      actions.push({ verb: "configure", target: ".claude/settings.json", detail: "SessionStart hook" });
    } else {
      actions.push({ verb: "skip", target: ".claude/settings.json", detail: "hook already configured" });
    }
  }

  // --- Dry run ---
  if (dryRun) {
    if (cli.json) {
      outputJson({ dryRun: true, scope, client, starter, actions });
      return;
    }
    info("\nDry run \u2014 no files will be written.\n");
    for (const a of actions) {
      if (a.verb === "skip") {
        info(`  Would skip:      ${a.target} (${a.detail})`);
      } else if (a.verb === "create") {
        info(`  Would create:    ${a.target}`);
      } else if (a.verb === "append") {
        info(`  Would append:    ${a.target} (${a.detail})`);
      } else if (a.verb === "configure") {
        info(`  Would configure: ${a.target} (${a.detail})`);
      }
    }
    info("\nRun without --dry-run to apply these changes.");
    return;
  }

  // --- Execute ---
  const results: string[] = [];
  const filesCreated: string[] = [];

  // 1. Create graphs directory
  if (!fs.existsSync(graphsDir)) {
    fs.mkdirSync(graphsDir, { recursive: true });
    results.push(`Created ${graphsConfigPath}/`);
    filesCreated.push(graphsDir);
  }

  // 2. Copy starter graph
  if (starter !== "none") {
    const templatesDir = getTemplatesDir();
    const templateFile = path.join(templatesDir, `${starter}.graph.yaml`);

    if (!fs.existsSync(templateFile)) {
      fatal(`Template not found: ${starter}.graph.yaml`, EXIT.GENERAL_ERROR);
    }

    const destFile = path.join(graphsDir, `${starter}.graph.yaml`);
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(templateFile, destFile);
      results.push(`Created ${graphsConfigPath}/${starter}.graph.yaml`);
      filesCreated.push(destFile);
    } else {
      results.push(`Skipped ${starter}.graph.yaml (already exists)`);
    }
  }

  // 3. Write MCP config
  if (client === "manual") {
    printManualConfig(graphsConfigPath, daemon, options.daemonPort);
  } else {
    const configPath = writeClientConfig(client, scope, graphsConfigPath, daemon, options.daemonPort);
    if (configPath) {
      results.push(`Configured MCP server in ${displayPath(configPath)} (${scope} scope)`);
      filesCreated.push(configPath);
    }
  }

  // 4. Append CLAUDE.md for project scope with Claude Code
  if (scope === "project" && client === "claude-code") {
    const appended = appendClaudeMd();
    if (appended) {
      results.push("Added workflow instructions to CLAUDE.md");
      filesCreated.push(path.join(process.cwd(), "CLAUDE.md"));
    } else {
      results.push("CLAUDE.md already has Freelance instructions");
    }
  }

  // 5. Write SessionStart hook for Claude Code
  if (client === "claude-code") {
    const hookPath = writeSessionStartHook();
    if (hookPath) {
      results.push(`Configured SessionStart hook in ${displayPath(hookPath)}`);
      filesCreated.push(hookPath);
    } else {
      results.push("SessionStart hook already configured");
    }
  }

  // JSON output
  if (cli.json) {
    outputJson({ scope, client, starter, files: filesCreated });
    return;
  }

  // Human output
  info("\nSetting up Freelance...\n");
  for (const r of results) {
    info(`  \u2713 ${r}`);
  }

  info(`
Next steps:
  1. Start your AI coding agent in this directory
  2. The agent will see Freelance's tools automatically
  3. Call graph_list to see available workflows
  4. Call graph_start to begin a workflow

  Run 'freelance validate ${graphsConfigPath}/' to check your graph definitions.

Happy building.`);
}

export async function initInteractive(opts?: { dryRun?: boolean }): Promise<void> {
  const { select } = await import("@inquirer/prompts");

  info("\nWelcome to Freelance \u2014 graph-based workflow enforcement for AI agents.\n");

  const scope = await select<Scope>({
    message: "How do you want to use Freelance?",
    choices: [
      { value: "project", name: "This project (config committed to repo)" },
      { value: "user", name: "Me, across all my projects (user)" },
    ],
  });

  const detected = detectClients();
  let client: Client;

  if (detected.length === 1) {
    const detectedName = detected[0];
    client = await select<Client>({
      message: "Which AI coding agent do you use?",
      choices: [
        {
          value: detectedName,
          name: `${clientDisplayName(detectedName)} (detected)`,
        },
        ...allClientChoices().filter((c) => c.value !== detectedName),
      ],
    });
  } else {
    client = await select<Client>({
      message: "Which AI coding agent do you use?",
      choices: allClientChoices(),
    });
  }

  const starter = await select<Starter>({
    message: "Start with an example graph?",
    choices: [
      {
        value: "change-request",
        name: "Change request workflow (branching, gates, quality checks)",
      },
      {
        value: "data-pipeline",
        name: "Data pipeline (cycles, verification, turn budgets)",
      },
      {
        value: "ralph-loop",
        name: "Ralph loop (spec \u2192 plan \u2192 build \u2192 verify)",
      },
      { value: "blank", name: "Blank graph (empty template)" },
      { value: "none", name: "No graph (I'll add my own)" },
    ],
  });

  await init({ scope, client, starter, daemon: INIT_DEFAULTS.daemon, dryRun: opts?.dryRun ?? INIT_DEFAULTS.dryRun });
}

function clientDisplayName(client: Client): string {
  switch (client) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "manual":
      return "Other / manual";
  }
}

function allClientChoices() {
  return [
    { value: "claude-code" as const, name: "Claude Code" },
    { value: "cursor" as const, name: "Cursor" },
    { value: "windsurf" as const, name: "Windsurf" },
    { value: "cline" as const, name: "Cline" },
    { value: "manual" as const, name: "Other / manual" },
  ];
}

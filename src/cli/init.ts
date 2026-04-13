import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allClientChoices, type Client, clientDisplayName, detectClients } from "./clients.js";
import { cli, displayPath, EXIT, fatal, homeDir, info, outputJson } from "./output.js";

export type { Client } from "./clients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "project" writes config into the repo (committed/shared with team).
// "user" writes config into ~/.claude.json (personal, all projects).
export type Scope = "project" | "user";
export type Starter = "blank" | "none";

export interface InitOptions {
  scope: Scope;
  client: Client;
  workflows?: string;
  starter: Starter;
  hooks: boolean;
  dryRun: boolean;
}

export const INIT_DEFAULTS = {
  starter: "blank" as Starter,
  hooks: false,
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

  throw new Error("Could not find templates directory. Is the package installed correctly?");
}

// Client detection, display names, and choice lists live in ./clients.ts

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
      `${filePath} contains invalid JSON: ${err instanceof Error ? err.message : err}\n\n  Fix the JSON syntax and retry, or delete the file to start fresh.`,
    );
  }
}

function writeJsonFile(filePath: string, data: McpConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function getMcpEntry(): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "freelance-mcp@latest", "mcp"],
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

function writeClientConfig(client: Client, scope: Scope): string | null {
  if (client === "manual") return null;

  const configPath = getConfigPath(client, scope);
  if (!configPath) return null;

  const config = readJsonFile(configPath);
  if (!config.mcpServers) config.mcpServers = {};

  const servers = config.mcpServers as Record<string, unknown>;
  servers.freelance = getMcpEntry();
  writeJsonFile(configPath, config);
  return configPath;
}

// --- CLAUDE.md append ---

const CLAUDE_MD_SECTION = `## Freelance

This project uses Freelance for workflow enforcement. Call \`freelance_list\` to see available workflows and \`freelance_guide\` for authoring help.`;

// --- Enforcement hooks ---

const SESSION_START_COMMAND = "npx -y freelance-mcp@latest status";
const PROMPT_SUBMIT_COMMAND =
  "echo '**IMPORTANT** - Workflows may apply. Call freelance_list, match the user'\"'\"'s task to an available graph, and start it before doing other work.'";

interface HookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookEntry[];
    UserPromptSubmit?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function hasFreelanceHook(entries: HookEntry[] | undefined, marker: string): boolean {
  if (!entries) return false;
  return JSON.stringify(entries).includes(marker);
}

function writeHooks(includeEnforcement: boolean): { path: string; wrote: string[] } | null {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const settings: ClaudeSettings = readJsonFile(settingsPath) as ClaudeSettings;
  if (!settings.hooks) settings.hooks = {};

  const wrote: string[] = [];

  // SessionStart hook — always written (lightweight, shows active traversals)
  if (!hasFreelanceHook(settings.hooks.SessionStart, "freelance-mcp@latest status")) {
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push({
      matcher: "",
      hooks: [{ type: "command", command: SESSION_START_COMMAND, timeout: 10 }],
    });
    wrote.push("SessionStart");
  }

  // UserPromptSubmit hook — only with enforcement opt-in
  if (includeEnforcement && !hasFreelanceHook(settings.hooks.UserPromptSubmit, "freelance_list")) {
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
    settings.hooks.UserPromptSubmit.push({
      matcher: "",
      hooks: [{ type: "command", command: PROMPT_SUBMIT_COMMAND, timeout: 5 }],
    });
    wrote.push("UserPromptSubmit");
  }

  if (wrote.length === 0) return null;

  writeJsonFile(settingsPath, settings as McpConfig);
  return { path: settingsPath, wrote };
}

function wouldWriteHooks(includeEnforcement: boolean): string[] {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const settings: ClaudeSettings = fs.existsSync(settingsPath)
    ? (readJsonFile(settingsPath) as ClaudeSettings)
    : {};

  const would: string[] = [];
  if (!hasFreelanceHook(settings.hooks?.SessionStart, "freelance-mcp@latest status")) {
    would.push("SessionStart");
  }
  if (includeEnforcement && !hasFreelanceHook(settings.hooks?.UserPromptSubmit, "freelance_list")) {
    would.push("UserPromptSubmit");
  }
  return would;
}

function appendClaudeMd(): boolean {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");

  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    if (content.includes("freelance_list") || content.includes("Freelance")) {
      return false;
    }
    fs.writeFileSync(claudeMdPath, `${content.trimEnd()}\n\n${CLAUDE_MD_SECTION}\n`);
  } else {
    fs.writeFileSync(claudeMdPath, `${CLAUDE_MD_SECTION}\n`);
  }
  return true;
}

function wouldAppendClaudeMd(): boolean {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    return !content.includes("freelance_list") && !content.includes("Freelance");
  }
  return true;
}

// --- Main init ---

function printManualConfig(): void {
  const entry = getMcpEntry();
  info("\nAdd this to your MCP client configuration:\n");
  process.stdout.write(`${JSON.stringify({ mcpServers: { freelance: entry } }, null, 2)}\n`);
}

export async function init(options: InitOptions): Promise<void> {
  const scope = options.scope;
  const client = options.client;
  const starter = options.starter;
  const dryRun = options.dryRun;

  const home = homeDir();

  // Determine graphs directory
  let graphsDir: string;
  if (options.workflows) {
    graphsDir = path.resolve(options.workflows);
  } else if (scope === "user") {
    graphsDir = path.join(home, ".freelance");
  } else {
    graphsDir = path.resolve(".freelance");
  }

  // Display-friendly path (relative for project scope, absolute for user scope)
  const graphsDisplayPath =
    scope === "user"
      ? graphsDir
      : `./${path.relative(process.cwd(), graphsDir).replace(/\\/g, "/")}`;

  // Collect actions for dry-run or execution
  interface Action {
    verb: "create" | "append" | "configure" | "skip";
    target: string;
    detail?: string;
  }
  const actions: Action[] = [];

  // 1. Graphs directory
  if (!fs.existsSync(graphsDir)) {
    actions.push({ verb: "create", target: `${graphsDisplayPath}/` });
  }

  // 2. Starter graph
  if (starter !== "none") {
    const destFile = path.join(graphsDir, `${starter}.workflow.yaml`);
    if (!fs.existsSync(destFile)) {
      actions.push({ verb: "create", target: `${graphsDisplayPath}/${starter}.workflow.yaml` });
    } else {
      actions.push({ verb: "skip", target: `${starter}.workflow.yaml`, detail: "already exists" });
    }
  }

  // 3. MCP config
  if (client === "manual") {
    actions.push({ verb: "configure", target: "stdout", detail: "print config snippet" });
  } else {
    const configPath = getConfigPath(client, scope);
    if (configPath) {
      actions.push({
        verb: "configure",
        target: displayPath(configPath),
        detail: `${scope} scope`,
      });
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
      actions.push({
        verb: "skip",
        target: "CLAUDE.md",
        detail: "already has Freelance instructions",
      });
    }
  }

  // 5. Enforcement hooks for claude-code (opt-in)
  if (client === "claude-code" && options.hooks) {
    const wouldWrite = wouldWriteHooks(true);
    if (wouldWrite.length > 0) {
      actions.push({
        verb: "configure",
        target: ".claude/settings.json",
        detail: `hooks: ${wouldWrite.join(", ")}`,
      });
    } else {
      actions.push({
        verb: "skip",
        target: ".claude/settings.json",
        detail: "hooks already configured",
      });
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
    results.push(`Created ${graphsDisplayPath}/`);
    filesCreated.push(graphsDir);
  }

  // 2. Copy starter graph
  if (starter !== "none") {
    const templatesDir = getTemplatesDir();
    const templateFile = path.join(templatesDir, `${starter}.workflow.yaml`);

    if (!fs.existsSync(templateFile)) {
      fatal(`Template not found: ${starter}.workflow.yaml`, EXIT.GENERAL_ERROR);
    }

    const destFile = path.join(graphsDir, `${starter}.workflow.yaml`);
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(templateFile, destFile);
      results.push(`Created ${graphsDisplayPath}/${starter}.workflow.yaml`);
      filesCreated.push(destFile);
    } else {
      results.push(`Skipped ${starter}.workflow.yaml (already exists)`);
    }
  }

  // 3. Write MCP config
  if (client === "manual") {
    printManualConfig();
  } else {
    const configPath = writeClientConfig(client, scope);
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

  // 5. Write enforcement hooks for Claude Code (opt-in)
  if (client === "claude-code" && options.hooks) {
    const hookResult = writeHooks(true);
    if (hookResult) {
      results.push(
        `Configured hooks in ${displayPath(hookResult.path)}: ${hookResult.wrote.join(", ")}`,
      );
      filesCreated.push(hookResult.path);
    } else {
      results.push("Hooks already configured");
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
  3. Call freelance_list to see available workflows
  4. Call freelance_start to begin a workflow

  Run 'freelance validate ${graphsDisplayPath}/' to check your graph definitions.

Happy building.`);
}

// @inquirer/prompts is an optionalDependency; surface a friendly hint
// instead of a cryptic ESM resolution error when it's absent.
async function loadPrompts() {
  try {
    return await import("@inquirer/prompts");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ERR_MODULE_NOT_FOUND" || /Cannot find package/.test(err.message ?? "")) {
      fatal(
        "Interactive init requires @inquirer/prompts (optional dependency).\n" +
          "  Install: npm install @inquirer/prompts\n" +
          "  Or skip prompts: freelance init --yes",
        EXIT.GENERAL_ERROR,
      );
    }
    throw e;
  }
}

export async function initInteractive(opts?: { dryRun?: boolean }): Promise<void> {
  const { select, confirm } = await loadPrompts();

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
      { value: "blank", name: "Blank graph (starter template)" },
      { value: "none", name: "No graph (I'll add my own)" },
    ],
  });

  let hooks = false;
  if (client === "claude-code") {
    hooks = await confirm({
      message: "Enable workflow enforcement hooks? (reminds the agent to follow workflows)",
      default: false,
    });
  }

  await init({ scope, client, starter, hooks, dryRun: opts?.dryRun ?? INIT_DEFAULTS.dryRun });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allClientChoices, type Client, clientDisplayName, detectClients } from "./clients.js";
import { displayPath, EXIT, fatal, homeDir, info, outputJson } from "./output.js";
import { ensureFreelanceDir } from "./setup.js";

export type { Client } from "./clients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "project" writes config into the repo (committed/shared with team).
// "user" writes config into ~/.claude.json (personal, all projects).
export type Scope = "project" | "user";
export type Starter = "blank" | "tagged" | "none";

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

// --- JSON helpers (shared by hook settings reads/writes) ---

interface JsonFile {
  [key: string]: unknown;
}

function readJsonFile(filePath: string): JsonFile {
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

function writeJsonFile(filePath: string, data: JsonFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Resolve where to install the driving SKILL.md, or `null` when the
 * client doesn't consume Claude Skills (cursor / windsurf / cline /
 * manual). Claude Code reads from `.claude/skills/<name>/SKILL.md`
 * (project) or `~/.claude/skills/<name>/SKILL.md` (user).
 */
function resolveSkillInstallPath(client: Client, scope: Scope): string | null {
  if (client !== "claude-code") return null;
  const base = scope === "user" ? homeDir() : process.cwd();
  return path.join(base, ".claude", "skills", "freelance", "SKILL.md");
}

// --- CLAUDE.md append ---

const CLAUDE_MD_SECTION = `## Freelance

This project uses Freelance for workflow enforcement. Run \`freelance status\` to see available workflows, \`freelance guide\` for authoring help, and \`freelance start <graphId>\` to begin one. The installed Freelance skill drives workflows automatically on matching prompts.`;

// --- Enforcement hooks ---

const SESSION_START_COMMAND = "npx -y freelance-mcp@latest status";
const PROMPT_SUBMIT_COMMAND =
  "echo '**IMPORTANT** - Workflows may apply. Run `freelance status` to see loaded graphs, match the user'\"'\"'s task to one, and `freelance start <graphId>` before doing other work.'";
// PROMPT_SUBMIT_MARKER above must be a substring of this command for
// dedup on re-init to work. If you rephrase the prompt, update both.

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

// Distinctive enough to survive neighboring hook entries that
// merely mention "freelance" — we want to dedupe our own hook, not
// any hook that touches a freelance subcommand.
const SESSION_START_MARKER = "freelance-mcp@latest status";
const PROMPT_SUBMIT_MARKER = "freelance start <graphId>";

function writeHooks(): { path: string; wrote: string[] } | null {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const settings: ClaudeSettings = readJsonFile(settingsPath) as ClaudeSettings;
  if (!settings.hooks) settings.hooks = {};

  const wrote: string[] = [];

  // SessionStart — lightweight, shows active traversals.
  if (!hasFreelanceHook(settings.hooks.SessionStart, SESSION_START_MARKER)) {
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart.push({
      matcher: "",
      hooks: [{ type: "command", command: SESSION_START_COMMAND, timeout: 10 }],
    });
    wrote.push("SessionStart");
  }

  if (!hasFreelanceHook(settings.hooks.UserPromptSubmit, PROMPT_SUBMIT_MARKER)) {
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
    settings.hooks.UserPromptSubmit.push({
      matcher: "",
      hooks: [{ type: "command", command: PROMPT_SUBMIT_COMMAND, timeout: 5 }],
    });
    wrote.push("UserPromptSubmit");
  }

  if (wrote.length === 0) return null;

  writeJsonFile(settingsPath, settings as JsonFile);
  return { path: settingsPath, wrote };
}

function wouldWriteHooks(): string[] {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const settings: ClaudeSettings = fs.existsSync(settingsPath)
    ? (readJsonFile(settingsPath) as ClaudeSettings)
    : {};

  const would: string[] = [];
  if (!hasFreelanceHook(settings.hooks?.SessionStart, SESSION_START_MARKER)) {
    would.push("SessionStart");
  }
  if (!hasFreelanceHook(settings.hooks?.UserPromptSubmit, PROMPT_SUBMIT_MARKER)) {
    would.push("UserPromptSubmit");
  }
  return would;
}

function appendClaudeMd(): boolean {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");

  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    if (content.includes("Freelance")) {
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
    return !content.includes("Freelance");
  }
  return true;
}

// --- Main init ---

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

  // 1b. Auto-generated .gitignore covering runtime artifacts. Mirrors
  // the lazy drop done by ensureFreelanceDir at CLI-load — we do it
  // eagerly here so users inspecting `.freelance/` right after `init`
  // see the file they'd expect.
  if (!fs.existsSync(path.join(graphsDir, ".gitignore"))) {
    actions.push({ verb: "create", target: `${graphsDisplayPath}/.gitignore` });
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

  // 2b. Starter config.yml — surfaces the memory.collections schema so
  // users don't have to discover it by hitting "Unknown collection" errors.
  const configDest = path.join(graphsDir, "config.yml");
  if (!fs.existsSync(configDest)) {
    actions.push({ verb: "create", target: `${graphsDisplayPath}/config.yml` });
  } else {
    actions.push({ verb: "skip", target: "config.yml", detail: "already exists" });
  }

  // 3. CLAUDE.md (claude-code only, project scope)
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
    const wouldWrite = wouldWriteHooks();
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

  // 6. Driving skill — Claude Code only. Installs `SKILL.md` so the
  // agent can drive workflows via the CLI without per-turn MCP weight.
  // Cursor / Windsurf / Cline don't consume Claude Skills; skip for them.
  const skillPath = resolveSkillInstallPath(client, scope);
  if (skillPath) {
    if (fs.existsSync(skillPath)) {
      actions.push({ verb: "skip", target: displayPath(skillPath), detail: "already exists" });
    } else {
      actions.push({ verb: "create", target: displayPath(skillPath) });
    }
  }

  // --- Dry run ---
  if (dryRun) {
    outputJson({ dryRun: true, scope, client, starter, actions });
    return;
  }

  // --- Execute ---
  const filesCreated: string[] = [];

  // 1. Create graphs directory
  if (!fs.existsSync(graphsDir)) {
    fs.mkdirSync(graphsDir, { recursive: true });
    filesCreated.push(graphsDir);
  }

  // 1b. Drop the runtime .gitignore eagerly (marker-gated upsert, safe
  // to call repeatedly — see ensureGitignore in setup.ts).
  const ignorePath = path.join(graphsDir, ".gitignore");
  const ignorePreexisted = fs.existsSync(ignorePath);
  ensureFreelanceDir(graphsDir);
  if (!ignorePreexisted && fs.existsSync(ignorePath)) {
    filesCreated.push(ignorePath);
  }

  const templatesDir = getTemplatesDir();

  // 2. Copy starter graph
  if (starter !== "none") {
    const templateFile = path.join(templatesDir, `${starter}.workflow.yaml`);

    if (!fs.existsSync(templateFile)) {
      fatal(`Template not found: ${starter}.workflow.yaml`, EXIT.NOT_FOUND, "TEMPLATE_NOT_FOUND");
    }

    const destFile = path.join(graphsDir, `${starter}.workflow.yaml`);
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(templateFile, destFile);
      filesCreated.push(destFile);
    }
  }

  // 2b. Copy starter config.yml
  {
    const configTemplate = path.join(templatesDir, "config.yml");
    const configDest = path.join(graphsDir, "config.yml");
    if (!fs.existsSync(configDest) && fs.existsSync(configTemplate)) {
      fs.copyFileSync(configTemplate, configDest);
      filesCreated.push(configDest);
    }
  }

  // 3. Append CLAUDE.md for project scope with Claude Code
  if (scope === "project" && client === "claude-code") {
    if (appendClaudeMd()) {
      filesCreated.push(path.join(process.cwd(), "CLAUDE.md"));
    }
  }

  // 4. Write enforcement hooks for Claude Code (opt-in)
  if (client === "claude-code" && options.hooks) {
    const hookResult = writeHooks();
    if (hookResult) {
      filesCreated.push(hookResult.path);
    }
  }

  // 6. Install the driving skill. Skip if the target exists to preserve
  // local edits on re-init.
  if (skillPath && !fs.existsSync(skillPath)) {
    const skillTemplate = path.join(templatesDir, "skills", "freelance", "SKILL.md");
    if (!fs.existsSync(skillTemplate)) {
      fatal(`Skill template not found: ${skillTemplate}`, EXIT.NOT_FOUND, "TEMPLATE_NOT_FOUND");
    }
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.copyFileSync(skillTemplate, skillPath);
    filesCreated.push(skillPath);
  }

  outputJson({
    scope,
    client,
    starter,
    files: filesCreated,
  });
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
        EXIT.INTERNAL,
        "MISSING_OPTIONAL_DEP",
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
      { value: "blank", name: "Blank graph (minimal starter)" },
      { value: "tagged", name: "Tagged workflow (demonstrates meta + requiredMeta)" },
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

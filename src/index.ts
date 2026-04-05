#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { Command, Option } from "commander";
import { startServer } from "./server.js";
import { startDaemon } from "./daemon.js";
import { startProxy } from "./proxy.js";
import { validate } from "./cli/validate.js";
import { visualize } from "./cli/visualize.js";
import { setCli, info, fatal, EXIT } from "./cli/output.js";
import { daemonStop, daemonStatus, checkRunningDaemon } from "./cli/daemon.js";
import { parseDaemonConnect, traversalsList, traversalsInspect, traversalsReset } from "./cli/traversals.js";
import { VERSION } from "./version.js";
import { DEFAULT_PORT } from "./paths.js";
import { resolveGraphsDirs, resolveSourceRoot, loadGraphsOrFatal, loadGraphsGraceful } from "./graph-resolution.js";
import { extractSection } from "./section-resolver.js";
import yaml from "js-yaml";
import type { MemoryConfig } from "./memory/index.js";

function resolveMemoryDbPath(): string | null {
  // Check config in default graph directories
  const dirs = resolveGraphsDirs();
  const config = loadMemoryConfig(dirs);
  if (config?.enabled && config.db) return config.db;

  // Check if memory.db exists in .freelance/
  const defaultPath = path.join(".freelance", "memory.db");
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

function resolveStateDb(graphsDirs: string[]): string {
  // Use the first graphsDir as the location for state.db
  for (const dir of graphsDirs) {
    if (fs.existsSync(dir)) {
      return path.join(dir, "state.db");
    }
  }
  return path.join(".freelance", "state.db");
}

function loadMemoryConfig(graphsDirs: string[]): MemoryConfig | null {
  for (const dir of graphsDirs) {
    const configPath = path.join(dir, "config.yml");
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = yaml.load(raw) as Record<string, unknown>;
        if (config?.memory && typeof config.memory === "object") {
          const mem = config.memory as Record<string, unknown>;
          if (mem.enabled) {
            const dbPath = typeof mem.db === "string"
              ? (path.isAbsolute(mem.db) ? mem.db : path.resolve(dir, mem.db))
              : path.join(dir, "memory.db");
            const ignore = Array.isArray(mem.ignore) ? mem.ignore as string[] : undefined;
            return { enabled: true, db: dbPath, ignore };
          }
        }
      } catch {
        // Config parse failure — skip memory
      }
    }
  }
  return null;
}

// --- Program setup ---

const program = new Command();

program
  .name("freelance")
  .description("Graph-based workflow enforcement for AI coding agents")
  .version(VERSION)
  .showSuggestionAfterError()
  .configureHelp({
    sortSubcommands: false,
    sortOptions: false,
  })
  .addHelpText("before", `freelance v${VERSION} \u2014 Graph-based workflow enforcement for AI coding agents\n`)
  .option("--json", "Output results as JSON to stdout")
  .option("--no-color", "Disable colored output")
  .option("--verbose", "Show detailed progress and debug information")
  .option("-q, --quiet", "Suppress non-essential output (errors only)")
  .hook("preAction", (_thisCommand, actionCommand) => {
    const root = actionCommand.optsWithGlobals();
    setCli({
      json: root.json ?? false,
      quiet: root.quiet ?? false,
      verbose: root.verbose ?? false,
      noColor: root.color === false || !!process.env.NO_COLOR,
    });
  });

// --- init ---

program
  .command("init")
  .description("Set up Freelance for a project or user")
  .addOption(new Option("--scope <scope>", "Where to install").choices(["project", "user"]).default("project"))
  .addOption(new Option("--client <client>", "MCP client to configure").choices(["claude-code", "cursor", "windsurf", "cline", "manual"]))
  .option("--workflows <path>", "Where to put workflow definitions")
  .addOption(new Option("--starter <template>", "Starter graph to scaffold").choices(["blank", "none"]))
  .option("--hooks", "Enable workflow enforcement hooks (Claude Code only)")
  .option("--yes", "Skip all prompts, use defaults")
  .option("--dry-run", "Show what would be created without writing anything")
  .action(async (opts) => {
    const { init, initInteractive, INIT_DEFAULTS } = await import("./cli/init.js");

    if (opts.dryRun || opts.yes || opts.client) {
      await init({
        scope: opts.scope,
        client: opts.client ?? "claude-code",
        workflows: opts.workflows,
        starter: opts.starter ?? INIT_DEFAULTS.starter,
        hooks: opts.hooks ?? INIT_DEFAULTS.hooks,
        dryRun: opts.dryRun ?? INIT_DEFAULTS.dryRun,
      });
    } else {
      await initInteractive({ dryRun: opts.dryRun });
    }
  });

// --- validate ---

program
  .command("validate <directory>")
  .description("Validate graph definitions")
  .option("--sources", "Also validate source bindings for drift")
  .option("--fix", "Update drifted source hashes in-place (requires --sources)")
  .option("--base-path <path>", "Base path for resolving source references (default: parent of graph directory)")
  .action((directory, opts) => {
    validate(directory, { checkSources: opts.sources || opts.fix, fix: opts.fix, basePath: opts.basePath });
  });

// --- visualize ---

program
  .command("visualize <file>")
  .description("Export graph as Mermaid or DOT diagram")
  .addOption(new Option("--format <format>", "Output format").choices(["mermaid", "dot"]).default("mermaid"))
  .option("--output <file>", "Write to file instead of stdout")
  .option("--open", "Render in browser")
  .action((file, opts) => {
    visualize(file, {
      format: opts.format,
      output: opts.output,
      open: opts.open,
    });
  });

// --- mcp ---

program
  .command("mcp")
  .description("Start MCP server")
  .option(
    "--workflows <directory>",
    "Workflow definitions directory (repeatable for layering)",
    (value: string, previous?: string[]) => (previous ? [...previous, value] : [value])
  )
  .addOption(new Option("--connect <host:port>", "Connect to daemon instead of standalone").hideHelp())
  .option("--max-depth <n>", "Maximum subgraph nesting depth", "5")
  .option("--source-root <path>", "Base path for resolving source references (default: parent of first workflows dir)")
  .action(async (opts) => {
    if (opts.connect) {
      const { host, port } = parseDaemonConnect(opts);
      info(`Freelance proxy: connecting to daemon at ${host}:${port}`);
      await startProxy(host, port);
    } else {
      const maxDepth = parseInt(opts.maxDepth, 10);
      const { graphs, errors: loadErrors } = loadGraphsGraceful(opts.workflows);
      const dirs = resolveGraphsDirs(opts.workflows);
      const sourceRoot = resolveSourceRoot(dirs, opts.sourceRoot);
      const sectionResolver = (filePath: string, section: string) => extractSection(filePath, section);
      if (loadErrors.length > 0) {
        info(`Freelance: ${loadErrors.length} graph(s) failed validation — call freelance_validate for details`);
      }
      // Check for memory configuration
      const memoryConfig = loadMemoryConfig(dirs);
      if (memoryConfig?.enabled) {
        info(`Freelance: memory enabled (${memoryConfig.db})`);
      }
      // State database for stateless traversal persistence
      const stateDb = resolveStateDb(dirs);
      info(`Freelance: loaded ${graphs.size} graph(s) from ${dirs.length} directory(ies), maxDepth=${maxDepth}, section resolver active`);
      await startServer(graphs, { maxDepth, graphsDirs: dirs, sectionResolver, sourceRoot, loadErrors, memory: memoryConfig ?? undefined, stateDb });
    }
  });

// --- daemon (hidden — untested, not yet public) ---

const daemonCmd = program
  .command("daemon", { hidden: true })
  .description("Manage the Freelance daemon");

daemonCmd
  .command("start", { isDefault: true })
  .description("Start the daemon")
  .option(
    "--workflows <directory>",
    "Workflow definitions directory (repeatable for layering)",
    (value: string, previous?: string[]) => (previous ? [...previous, value] : [value])
  )
  .option("--port <port>", `Port to listen on (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
  .option("--max-depth <n>", "Maximum subgraph nesting depth", "5")
  .option("--source-root <path>", "Base path for resolving source references (default: parent of first workflows dir)")
  .action(async (opts) => {
    // Idempotent: if daemon is already running, report and exit
    const running = checkRunningDaemon();
    if (running) {
      info(`Daemon already running (PID ${running.pid}, port ${running.port})`);
      process.exit(0);
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      fatal("--port must be a valid port number (1-65535)", EXIT.INVALID_USAGE);
    }
    const maxDepth = parseInt(opts.maxDepth, 10);

    const graphs = loadGraphsOrFatal(opts.workflows);
    const graphsDirs = resolveGraphsDirs(opts.workflows);
    const sourceRoot = resolveSourceRoot(graphsDirs, opts.sourceRoot);
    const stateDb = resolveStateDb(graphsDirs);
    info(`Freelance daemon: loaded ${graphs.size} graph(s) from ${graphsDirs.length} directory(ies)`);
    await startDaemon(graphs, { port, host: "127.0.0.1", stateDb, maxDepth, graphsDirs, sourceRoot });
  });

daemonCmd
  .command("stop")
  .description("Stop the daemon")
  .action(() => daemonStop());

daemonCmd
  .command("status")
  .description("Check daemon status")
  .action(() => daemonStatus());

// --- traversals (hidden — requires daemon) ---

const traversalsCmd = program
  .command("traversals", { hidden: true })
  .description("Manage active traversals (requires running daemon)");

traversalsCmd
  .command("list")
  .description("List active traversals")
  .option("--connect <host:port>", "Daemon address")
  .action(async (opts) => {
    const { host, port } = parseDaemonConnect(opts);
    await traversalsList(host, port);
  });

traversalsCmd
  .command("inspect <id>")
  .description("Inspect a traversal")
  .option("--connect <host:port>", "Daemon address")
  .action(async (id, opts) => {
    const { host, port } = parseDaemonConnect(opts);
    await traversalsInspect(host, port, id);
  });

traversalsCmd
  .command("reset <id>")
  .description("Reset a traversal")
  .option("--connect <host:port>", "Daemon address")
  .action(async (id, opts) => {
    const { host, port } = parseDaemonConnect(opts);
    await traversalsReset(host, port, id);
  });

// --- memory-register (for Claude Code PreToolUse hook) ---

program
  .command("memory-register <file>")
  .description("Register a file as a provenance source (used by Claude Code hooks)")
  .option("--db <path>", "Path to memory database")
  .option("--source-root <path>", "Source root for relative path storage")
  .action(async (file, opts) => {
    const { MemoryStore } = await import("./memory/index.js");

    // Resolve the database path
    const dbPath = opts.db ?? resolveMemoryDbPath();
    if (!dbPath) {
      // No memory database configured — silently exit.
      // The hook fires on every Read; if memory isn't enabled, that's fine.
      process.exit(0);
    }

    const sourceRoot = opts.sourceRoot ?? process.cwd();
    const dirs = resolveGraphsDirs();
    const memConfig = loadMemoryConfig(dirs);
    const ignore = memConfig?.ignore;
    try {
      const store = new MemoryStore(dbPath, sourceRoot, ignore);
      const result = store.registerSource(file);
      store.close();
      if (!program.opts().quiet) {
        process.stdout.write(JSON.stringify(result) + "\n");
      }
    } catch (e) {
      // No active session or file unreadable — silently exit.
      // The hook shouldn't block the agent's Read tool.
      const msg = e instanceof Error ? e.message : String(e);
      if (!program.opts().quiet) {
        process.stderr.write(`memory-register: ${msg}\n`);
      }
    }
  });

// --- inspect ---

program
  .command("inspect")
  .description("Show active traversals from persisted state")
  .option("--oneline", "Compact one-line output (for hooks)")
  .action(async (opts) => {
    const { inspect } = await import("./cli/inspect.js");
    inspect({ oneline: opts.oneline ?? false });
  });

// --- completion ---

program
  .command("completion <shell>")
  .description("Output shell completion script (bash, zsh, fish)")
  .action((shell) => {
    const supported = ["bash", "zsh", "fish"];
    if (!supported.includes(shell)) {
      fatal(
        `Unknown shell: ${shell}. Supported: ${supported.join(", ")}`,
        EXIT.INVALID_USAGE
      );
    }
    const completionFile = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..", "templates", "completions", `freelance.${shell}`
    );
    if (!fs.existsSync(completionFile)) {
      fatal(`Completion file not found: ${completionFile}`, EXIT.GENERAL_ERROR);
    }
    process.stdout.write(fs.readFileSync(completionFile, "utf-8"));
  });

export { program };

// Public API for embedding
export { GraphBuilder } from "./builder.js";
export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";
export type { ValidatedGraph } from "./types.js";

// Only parse when run directly (not when imported in tests)
const isMain = process.argv[1] && (
  import.meta.url.endsWith(process.argv[1].replace(/.*[/\\]/, "")) ||
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file://${fs.realpathSync(process.argv[1])}`
);
if (isMain) program.parse();

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
import { parseDaemonConnect } from "./cli/traversals.js";
import {
  traversalStatus, traversalStart, traversalAdvance,
  traversalContextSet, traversalInspect, traversalReset,
} from "./cli/traversals.js";
import {
  memoryStatus, memoryBrowse, memoryInspect, memorySearch,
  memoryRelated, memoryBySource, memoryRegister, memoryEmit, memoryEnd,
} from "./cli/memory.js";
import { guideShow, distillRun, sourcesHash, sourcesCheck, sourcesValidate } from "./cli/stateless.js";
import {
  createTraversalStore, createMemoryStore, loadGraphSetup,
  resolveStateDb, resolveMemoryConfig,
} from "./cli/setup.js";
import { VERSION } from "./version.js";
import { DEFAULT_PORT } from "./paths.js";
import { resolveGraphsDirs, resolveSourceRoot, loadGraphsOrFatal, loadGraphsGraceful } from "./graph-resolution.js";
import { loadConfigFromDirs } from "./config.js";
import { extractSection } from "./section-resolver.js";

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
  .option("--memory-dir <path>", "Persistent directory for memory database")
  .option("--no-memory", "Disable memory")
  .action(async (opts) => {
    if (opts.connect) {
      const { host, port } = parseDaemonConnect(opts);
      info(`Freelance proxy: connecting to daemon at ${host}:${port}`);
      await startProxy(host, port);
    } else {
      const maxDepth = parseInt(opts.maxDepth, 10);
      const dirs = resolveGraphsDirs(opts.workflows);
      const { graphs, errors: loadErrors } = loadGraphsGraceful(dirs);
      const sourceRoot = resolveSourceRoot(dirs, opts.sourceRoot);
      const sectionResolver = (filePath: string, section: string) => extractSection(filePath, section);
      if (loadErrors.length > 0) {
        info(`Freelance: ${loadErrors.length} graph(s) failed validation — call freelance_validate for details`);
      }
      const config = loadConfigFromDirs(dirs);
      const memoryConfig = resolveMemoryConfig(dirs, { memoryDir: opts.memoryDir, memory: opts.memory }, config);
      if (memoryConfig) {
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

// --- Traversal commands (direct SQLite access) ---

function addWorkflowsOpt(cmd: Command): Command {
  return cmd.option(
    "--workflows <directory>",
    "Workflow definitions directory (repeatable for layering)",
    (value: string, previous?: string[]) => (previous ? [...previous, value] : [value])
  );
}

addWorkflowsOpt(program
  .command("status")
  .description("Show loaded graphs and active traversals"))
  .action((opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalStatus(store); } finally { store.close(); }
  });

addWorkflowsOpt(program
  .command("start <graphId>")
  .description("Begin traversing a workflow graph")
  .option("--context <json>", "Initial context as JSON"))
  .action((graphId, opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalStart(store, graphId, opts.context); } finally { store.close(); }
  });

addWorkflowsOpt(program
  .command("advance [edge]")
  .description("Move to the next node by taking a labeled edge")
  .option("--context <json>", "Context updates as JSON")
  .option("--traversal <id>", "Traversal ID (auto-resolved if only one active)"))
  .action((edge, opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalAdvance(store, edge, opts); } finally { store.close(); }
  });

const contextCmd = program
  .command("context")
  .description("Update traversal context");

addWorkflowsOpt(contextCmd
  .command("set <updates...>")
  .description("Set context key=value pairs (e.g. foo=1 bar=true)")
  .option("--traversal <id>", "Traversal ID (auto-resolved if only one active)"))
  .action((updates, opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalContextSet(store, updates, opts); } finally { store.close(); }
  });

addWorkflowsOpt(program
  .command("inspect [traversalId]")
  .description("Read-only introspection of current graph state")
  .addOption(new Option("--detail <level>", "Detail level").choices(["position", "full", "history"]).default("position")))
  .action((traversalId, opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalInspect(store, traversalId, opts.detail); } finally { store.close(); }
  });

addWorkflowsOpt(program
  .command("reset [traversalId]")
  .description("Clear a traversal")
  .option("--confirm", "Required safety check"))
  .action((traversalId, opts) => {
    const { store } = createTraversalStore({ workflows: opts.workflows });
    try { traversalReset(store, traversalId, opts); } finally { store.close(); }
  });

// --- Memory commands ---

const memoryCmd = program
  .command("memory")
  .description("Query and manage the persistent knowledge graph");

addWorkflowsOpt(memoryCmd
  .command("status")
  .description("Show proposition and entity counts")
  .option("--collection <name>", "Scope to a collection"))
  .action((opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryStatus(store, opts.collection); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("browse")
  .description("Find entities by name, kind, or partial match")
  .option("--name <pattern>", "Partial name match (case-insensitive)")
  .option("--kind <kind>", "Filter by entity kind")
  .option("--collection <name>", "Scope to a collection")
  .option("--limit <n>", "Maximum results")
  .option("--offset <n>", "Skip first N results"))
  .action((opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryBrowse(store, opts); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("inspect <entity>")
  .description("Full entity details — propositions, neighbors, sources")
  .option("--collection <name>", "Scope to a collection"))
  .action((entity, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryInspect(store, entity, opts.collection); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("search <query>")
  .description("Full-text search across proposition content")
  .option("--collection <name>", "Scope to a collection")
  .option("--limit <n>", "Maximum results"))
  .action((query, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memorySearch(store, query, opts); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("related <entity>")
  .description("Show entities related via shared propositions")
  .option("--collection <name>", "Scope to a collection"))
  .action((entity, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryRelated(store, entity, opts.collection); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("by-source <file>")
  .description("All propositions derived from a source file")
  .option("--collection <name>", "Scope to a collection"))
  .action((file, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryBySource(store, file, opts.collection); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("register <file>")
  .description("Register a file as a provenance source"))
  .action((file, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryRegister(store, file); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("emit <file>")
  .description("Write propositions from JSON file (use - for stdin)")
  .option("--collection <name>", "Target collection", "default"))
  .action((file, opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryEmit(store, file, opts.collection); } finally { store.close(); }
  });

addWorkflowsOpt(memoryCmd
  .command("end")
  .description("Close the active compilation session"))
  .action((opts) => {
    const { store } = createMemoryStore({ workflows: opts.workflows });
    try { memoryEnd(store); } finally { store.close(); }
  });

// --- Stateless commands ---

program
  .command("guide [topic]")
  .description("Get help with authoring workflow graphs")
  .action((topic) => {
    guideShow(topic);
  });

program
  .command("distill")
  .description("Get a prompt for distilling a task into a workflow graph")
  .addOption(new Option("--mode <mode>", "Distill mode").choices(["distill", "refine"]).default("distill"))
  .action((opts) => {
    distillRun(opts);
  });

const sourcesCmd = program
  .command("sources")
  .description("Manage source bindings and provenance");

addWorkflowsOpt(sourcesCmd
  .command("hash <paths...>")
  .description("Hash source files for provenance stamping (path or path:section)")
  .option("--source-root <path>", "Base path for resolving source references"))
  .action((paths, opts) => {
    const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
    sourcesHash(setup.sourceOpts, paths);
  });

addWorkflowsOpt(sourcesCmd
  .command("check <sources...>")
  .description("Validate source hashes (path:hash or path:section:hash)")
  .option("--source-root <path>", "Base path for resolving source references"))
  .action((sources, opts) => {
    const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
    sourcesCheck(setup.sourceOpts, sources);
  });

addWorkflowsOpt(sourcesCmd
  .command("validate")
  .description("Validate all source bindings across loaded graphs")
  .option("--graph <id>", "Check a single graph by ID")
  .option("--source-root <path>", "Base path for resolving source references"))
  .action((opts) => {
    const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
    sourcesValidate(setup.graphsDirs, setup.sourceOpts, opts.graph);
  });

// --- config ---

import { configShow, configSetLocal } from "./cli/config.js";

const configCmd = program
  .command("config")
  .description("View and manage Freelance configuration");

addWorkflowsOpt(configCmd
  .command("show")
  .description("Display resolved configuration with sources"))
  .action((opts) => {
    configShow({ workflows: opts.workflows });
  });

addWorkflowsOpt(configCmd
  .command("set-local <key> <value>")
  .description("Set a value in config.local.yml (for plugin hooks)"))
  .action((key, value, opts) => {
    configSetLocal(key, value, { workflows: opts.workflows });
  });

// --- memory-register (for Claude Code PreToolUse hook) ---

program
  .command("memory-register <file>")
  .description("Register a file as a provenance source (used by Claude Code hooks)")
  .option("--db <path>", "Path to memory database")
  .option("--source-root <path>", "Source root for relative path storage")
  .action(async (file, opts) => {
    const { MemoryStore } = await import("./memory/index.js");
    const { COMPILE_KNOWLEDGE_ID } = await import("./memory/workflow.js");
    const { RECOLLECTION_ID } = await import("./memory/recollection.js");

    // Resolve memory config once — this is a hot path (fires on every Read)
    let dbPath = opts.db as string | undefined;
    let ignore: string[] | undefined;
    let dirs: string[] | undefined;
    if (!dbPath) {
      dirs = resolveGraphsDirs();
      const memConfig = resolveMemoryConfig(dirs, {});
      if (!memConfig) {
        // Memory disabled — silently exit.
        process.exit(0);
      }
      dbPath = memConfig.db;
      ignore = memConfig.ignore;
    }

    // Gate: only register files when a memory traversal is active
    const stateDbPath = resolveStateDb(dirs ?? resolveGraphsDirs());
    try {
      const { openStateDatabase } = await import("./state/index.js");
      const stateDb = openStateDatabase(stateDbPath);
      const placeholders = [COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID].map(() => "?").join(", ");
      const row = stateDb.prepare(
        `SELECT 1 FROM traversals WHERE graph_id IN (${placeholders}) LIMIT 1`
      ).get(COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID);
      stateDb.close();
      if (!row) {
        // No active memory traversal — silently exit.
        process.exit(0);
      }
    } catch {
      // State DB unavailable — silently exit.
      process.exit(0);
    }

    const sourceRoot = opts.sourceRoot ?? process.cwd();
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

// Public API — re-export from subpaths
export { GraphBuilder, GraphEngine, EngineError } from "./core/index.js";
export type { ValidatedGraph, NodeInput } from "./core/index.js";
export { createServer } from "./server.js";
export type { ServerOptions } from "./server.js";
export { TraversalStore } from "./state/index.js";
export { MemoryStore } from "./memory/index.js";

// Only parse when run directly (not when imported in tests)
const isMain = process.argv[1] && (
  import.meta.url.endsWith(process.argv[1].replace(/.*[/\\]/, "")) ||
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file://${fs.realpathSync(process.argv[1])}`
);
if (isMain) program.parse();

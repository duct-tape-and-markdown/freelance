#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { Command, Option } from "commander";
import { loadGraphs } from "./loader.js";
import { startServer } from "./server.js";
import { startDaemon } from "./daemon.js";
import { startProxy } from "./proxy.js";
import { validate } from "./cli/validate.js";
import { visualize } from "./cli/visualize.js";
import { setCli, info, fatal, EXIT } from "./cli/output.js";
import { daemonStop, daemonStatus } from "./cli/daemon.js";
import { parseDaemonConnect, traversalsList, traversalsInspect, traversalsReset } from "./cli/traversals.js";
import { VERSION } from "./version.js";
import { TRAVERSALS_DIR, DEFAULT_PORT } from "./paths.js";

const ENV_GRAPHS_DIR = process.env.FREELANCE_GRAPHS_DIR?.trim() || undefined;

function loadGraphsOrFatal(graphsDir: string) {
  try {
    return loadGraphs(graphsDir);
  } catch (err) {
    fatal(
      `Graph loading failed: ${err instanceof Error ? err.message : err}`,
      EXIT.GRAPH_ERROR
    );
  }
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
  .option("--graphs <path>", "Where to put graph definitions")
  .addOption(new Option("--starter <template>", "Starter graph to scaffold").choices(["change-request", "data-pipeline", "ralph-loop", "blank", "none"]))
  .option("--yes", "Skip all prompts, use defaults")
  .option("--dry-run", "Show what would be created without writing anything")
  .action(async (opts) => {
    const { init, initInteractive, INIT_DEFAULTS } = await import("./cli/init.js");

    if (opts.dryRun || opts.yes || opts.client) {
      await init({
        scope: opts.scope,
        client: opts.client ?? "claude-code",
        graphs: opts.graphs,
        starter: opts.starter ?? INIT_DEFAULTS.starter,
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
  .action((directory) => {
    validate(directory);
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
  .description("Start MCP server (standalone or proxy to daemon)")
  .option("--graphs <directory>", "Graph definitions directory")
  .option("--connect <host:port>", "Connect to daemon instead of standalone")
  .option("--max-depth <n>", "Maximum subgraph nesting depth", "5")
  .action(async (opts) => {
    if (opts.connect) {
      const { host, port } = parseDaemonConnect(opts);
      info(`Freelance proxy: connecting to daemon at ${host}:${port}`);
      await startProxy(host, port);
    } else {
      const graphsDir = opts.graphs ?? ENV_GRAPHS_DIR;
      if (!graphsDir) {
        fatal(
          "mcp requires --graphs <directory> or --connect <host:port>\n\n  Set FREELANCE_GRAPHS_DIR to provide a default.",
          EXIT.INVALID_USAGE
        );
      }
      const maxDepth = parseInt(opts.maxDepth, 10);
      const graphs = loadGraphsOrFatal(graphsDir);
      const ids = [...graphs.keys()];
      info(`Freelance: loaded ${graphs.size} graph(s) (${ids.join(", ")}), maxDepth=${maxDepth}`);
      await startServer(graphs, { maxDepth });
    }
  });

// --- daemon ---

const daemonCmd = program
  .command("daemon")
  .description("Manage the Freelance daemon");

daemonCmd
  .command("start", { isDefault: true })
  .description("Start the daemon")
  .option("--graphs <directory>", "Graph definitions directory")
  .option("--port <port>", `Port to listen on (default: ${DEFAULT_PORT})`, String(DEFAULT_PORT))
  .option("--max-depth <n>", "Maximum subgraph nesting depth", "5")
  .action(async (opts) => {
    const graphsDir = opts.graphs ?? ENV_GRAPHS_DIR;
    if (!graphsDir) {
      fatal(
        "daemon start requires --graphs <directory>\n\n  Set FREELANCE_GRAPHS_DIR to provide a default.",
        EXIT.INVALID_USAGE
      );
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      fatal("--port must be a valid port number (1-65535)", EXIT.INVALID_USAGE);
    }
    const maxDepth = parseInt(opts.maxDepth, 10);
    const persistDir = path.resolve(TRAVERSALS_DIR);

    const graphs = loadGraphsOrFatal(graphsDir);
    const ids = [...graphs.keys()];
    info(`Freelance daemon: loaded ${graphs.size} graph(s) (${ids.join(", ")})`);
    await startDaemon(graphs, { port, host: "127.0.0.1", persistDir, maxDepth, graphsDir: path.resolve(graphsDir) });
  });

daemonCmd
  .command("stop")
  .description("Stop the daemon")
  .action(() => daemonStop());

daemonCmd
  .command("status")
  .description("Check daemon status")
  .action(() => daemonStatus());

// --- traversals ---

const traversalsCmd = program
  .command("traversals")
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

// --- inspect ---

program
  .command("inspect")
  .description("Show active traversals from persisted state")
  .option("--active", "Show only active traversals", true)
  .option("--oneline", "Compact one-line output (for hooks)")
  .action(async (opts) => {
    const { inspect } = await import("./cli/inspect.js");
    inspect({ active: opts.active, oneline: opts.oneline ?? false });
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

program.parse();

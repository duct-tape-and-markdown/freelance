/**
 * Commander program for the `freelance` CLI. Importing this module has no
 * side effects beyond constructing the program — `src/bin.ts` is what calls
 * `program.parseAsync`.
 */

import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { loadConfigFromDirs } from "../config.js";
import { resolveContextCaps } from "../engine/context.js";
import { loadGraphsGraceful, resolveGraphsDirs, resolveSourceRoot } from "../graph-resolution.js";
import { getSealedGraphs } from "../memory/sealed.js";
import { extractSection } from "../section-resolver.js";
import { startServer } from "../server.js";
import { VERSION } from "../version.js";
import { configSetLocal, configShow } from "./config.js";
import {
  memoryBrowse,
  memoryBySource,
  memoryEmit,
  memoryInspect,
  memoryPrune,
  memoryRelated,
  memoryReset,
  memorySearch,
  memoryStatus,
} from "./memory.js";
import { EXIT, fatal, info, outputJson, setCli } from "./output.js";
import {
  createMemoryStore,
  createTraversalStore,
  ensureFreelanceDir,
  loadGraphSetup,
  resolveMemoryConfig,
  resolveTraversalsDir,
} from "./setup.js";
import { distillRun, guideShow, sourcesCheck, sourcesHash, sourcesValidate } from "./stateless.js";
import {
  traversalAdvance,
  traversalContextSet,
  traversalInspect,
  traversalInspectActive,
  traversalMetaSet,
  traversalReset,
  traversalStart,
  traversalStatus,
} from "./traversals.js";
import { validate } from "./validate.js";
import { visualize } from "./visualize.js";

// --- Program setup ---

export const program = new Command();

program
  .name("freelance")
  .description("Graph-based workflow enforcement for AI coding agents")
  .version(VERSION)
  .showSuggestionAfterError()
  .configureHelp({
    sortSubcommands: false,
    sortOptions: false,
  })
  .addHelpText(
    "before",
    `freelance v${VERSION} \u2014 Graph-based workflow enforcement for AI coding agents\n`,
  )
  .option("--verbose", "Show detailed progress and debug information on stderr")
  .option("-q, --quiet", "Suppress stderr breadcrumbs")
  .hook("preAction", (_thisCommand, actionCommand) => {
    const root = actionCommand.optsWithGlobals();
    setCli({
      quiet: root.quiet ?? false,
      verbose: root.verbose ?? false,
    });
  });

// --- init ---

program
  .command("init")
  .description("Set up Freelance for a project or user")
  .addOption(
    new Option("--scope <scope>", "Where to install")
      .choices(["project", "user"])
      .default("project"),
  )
  .addOption(
    new Option("--client <client>", "MCP client to configure").choices([
      "claude-code",
      "cursor",
      "windsurf",
      "cline",
      "manual",
    ]),
  )
  .option("--workflows <path>", "Where to put workflow definitions")
  .addOption(
    new Option("--starter <template>", "Starter graph to scaffold").choices([
      "blank",
      "tagged",
      "none",
    ]),
  )
  .option("--hooks", "Enable workflow enforcement hooks (Claude Code only)")
  .option("--yes", "Skip all prompts, use defaults")
  .option("--dry-run", "Show what would be created without writing anything")
  .action(async (opts) => {
    const { init, initInteractive, INIT_DEFAULTS } = await import("./init.js");

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
  .option(
    "--base-path <path>",
    "Base path for resolving source references (default: parent of graph directory)",
  )
  .action((directory, opts) => {
    validate(directory, {
      checkSources: opts.sources || opts.fix,
      fix: opts.fix,
      basePath: opts.basePath,
    });
  });

// --- visualize ---

program
  .command("visualize <file>")
  .description("Export graph as Mermaid or DOT diagram (JSON response)")
  .addOption(
    new Option("--format <format>", "Output format").choices(["mermaid", "dot"]).default("mermaid"),
  )
  .option("--output <file>", "Write diagram to file (response still JSON)")
  .action((file, opts) => {
    visualize(file, {
      format: opts.format,
      output: opts.output,
    });
  });

// --- mcp ---

program
  .command("mcp")
  .description("Start MCP server")
  .option(
    "--workflows <directory>",
    "Workflow definitions directory (repeatable for layering)",
    (value: string, previous?: string[]) => (previous ? [...previous, value] : [value]),
  )
  .option("--max-depth <n>", "Maximum subgraph nesting depth (overrides config.maxDepth)")
  .option(
    "--source-root <path>",
    "Base path for resolving source references (default: parent of first workflows dir)",
  )
  .option("--memory-dir <path>", "Persistent directory for memory database")
  .option("--memory", "Force memory on (overrides memory.enabled=false in config)")
  .option("--no-memory", "Disable memory (overrides memory.enabled=true in config)")
  .action(async (opts) => {
    const dirs = resolveGraphsDirs(opts.workflows);
    const config = loadConfigFromDirs(dirs);
    const memoryConfig = resolveMemoryConfig(
      dirs,
      { memoryDir: opts.memoryDir, memory: opts.memory },
      config,
    );
    // Sealed graphs must reach the loader before cross-graph validation.
    const sealedGraphs = memoryConfig ? getSealedGraphs() : undefined;
    const { graphs, errors: loadErrors } = loadGraphsGraceful(dirs, { sealedGraphs });
    const sourceRoot = resolveSourceRoot(dirs, opts.sourceRoot);
    const sectionResolver = (filePath: string, section: string) =>
      extractSection(filePath, section);
    if (loadErrors.length > 0) {
      info(
        `Freelance: ${loadErrors.length} graph(s) failed validation — call freelance_validate for details`,
      );
    }
    if (memoryConfig) {
      info(`Freelance: memory enabled (${memoryConfig.db})`);
    }
    // Precedence: CLI flag > config.maxDepth > hardcoded default 5.
    const maxDepth =
      opts.maxDepth !== undefined ? parseInt(opts.maxDepth, 10) : (config.maxDepth ?? 5);
    ensureFreelanceDir(dirs[0] ?? ".freelance");
    const stateDir = resolveTraversalsDir(dirs);
    info(
      `Freelance: loaded ${graphs.size} graph(s) from ${dirs.length} directory(ies), maxDepth=${maxDepth}`,
    );
    await startServer(graphs, {
      maxDepth,
      graphsDirs: dirs,
      sectionResolver,
      sourceRoot,
      loadErrors,
      memory: memoryConfig ?? undefined,
      stateDir,
      hookTimeoutMs: config.hooks.timeoutMs,
      contextCaps: resolveContextCaps(config.context),
    });
  });

// --- Traversal commands ---

function addWorkflowsOpt(cmd: Command): Command {
  return cmd.option(
    "--workflows <directory>",
    "Workflow definitions directory (repeatable for layering)",
    (value: string, previous?: string[]) => (previous ? [...previous, value] : [value]),
  );
}

addWorkflowsOpt(
  program
    .command("status")
    .description("Show loaded graphs and active traversals")
    .option(
      "--filter <pair>",
      "Show only traversals whose meta tags match key=value (repeatable; all must match)",
      (value: string, previous?: string[]) => (previous ? [...previous, value] : [value]),
    ),
).action((opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    traversalStatus(store, { filter: opts.filter });
  } finally {
    runtime.close();
  }
});

addWorkflowsOpt(
  program
    .command("start <graphId>")
    .description("Begin traversing a workflow graph")
    .option("--context <json>", "Initial context as JSON")
    .option(
      "--meta <pair>",
      "Opaque key=value tag for lookup via `freelance traversals find` (repeatable)",
      (value: string, previous?: string[]) => (previous ? [...previous, value] : [value]),
    ),
).action(async (graphId, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    await traversalStart(store, graphId, opts.context, { meta: opts.meta });
  } finally {
    runtime.close();
  }
});

addWorkflowsOpt(
  program
    .command("advance [edge]")
    .description("Move to the next node by taking a labeled edge")
    .option("--context <json>", "Context updates as JSON")
    .option("--traversal <id>", "Traversal ID (auto-resolved if only one active)"),
).action(async (edge, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    await traversalAdvance(store, edge, opts);
  } finally {
    runtime.close();
  }
});

const contextCmd = program.command("context").description("Update traversal context");

addWorkflowsOpt(
  contextCmd
    .command("set <updates...>")
    .description("Set context key=value pairs (e.g. foo=1 bar=true)")
    .option("--traversal <id>", "Traversal ID (auto-resolved if only one active)"),
).action((updates, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    traversalContextSet(store, updates, opts);
  } finally {
    runtime.close();
  }
});

const metaCmd = program.command("meta").description("Update traversal meta tags");

addWorkflowsOpt(
  metaCmd
    .command("set <updates...>")
    .description("Merge meta key=value tags (e.g. prUrl=https://… branch=feature/x)")
    .option("--traversal <id>", "Traversal ID (auto-resolved if only one active)"),
).action((updates, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    traversalMetaSet(store, updates, opts);
  } finally {
    runtime.close();
  }
});

addWorkflowsOpt(
  program
    .command("inspect [traversalId]")
    .description("Read-only introspection of current graph state")
    .addOption(
      new Option("--detail <level>", "Detail level")
        .choices(["position", "full", "history"])
        .default("position"),
    )
    .option("--active", "List every active traversal (ignores [traversalId])")
    .option("--waits", "With --active, include only traversals at a wait node"),
).action((traversalId, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    if (opts.active) {
      traversalInspectActive(store, { waitsOnly: opts.waits });
    } else {
      traversalInspect(store, traversalId, opts.detail);
    }
  } finally {
    runtime.close();
  }
});

addWorkflowsOpt(
  program
    .command("reset [traversalId]")
    .description("Clear a traversal")
    .option("--confirm", "Required safety check"),
).action((traversalId, opts) => {
  const { store, runtime } = createTraversalStore({ workflows: opts.workflows });
  try {
    traversalReset(store, traversalId, opts);
  } finally {
    runtime.close();
  }
});

// --- Memory commands ---

const memoryCmd = program
  .command("memory")
  .description("Query and manage the persistent knowledge graph");

addWorkflowsOpt(
  memoryCmd.command("status").description("Show proposition and entity counts"),
).action((opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryStatus(store);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("browse")
    .description("Find entities by name, kind, or partial match")
    .option("--name <pattern>", "Partial name match (case-insensitive)")
    .option("--kind <kind>", "Filter by entity kind")
    .option("--limit <n>", "Maximum results")
    .option("--offset <n>", "Skip first N results")
    .option(
      "--include-orphans",
      "Include entities whose valid_proposition_count is 0 (hidden by default)",
    ),
).action((opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryBrowse(store, opts);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("inspect <entity>")
    .description("Full entity details — propositions, neighbors, sources"),
).action((entity, opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryInspect(store, entity);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("search <query>")
    .description("Full-text search across proposition content")
    .option("--limit <n>", "Maximum results"),
).action((query, opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memorySearch(store, query, opts);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("related <entity>")
    .description("Show entities related via shared propositions"),
).action((entity, opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryRelated(store, entity);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd.command("by-source <file>").description("All propositions derived from a source file"),
).action((file, opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryBySource(store, file);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("emit <file>")
    .description("Write propositions from JSON file (use - for stdin)"),
).action((file, opts) => {
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryEmit(store, file);
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("prune")
    .description("Delete source rows whose content isn't live at any --keep ref or disk")
    .option(
      "--keep <ref>",
      "Preserve ref (repeatable; required). Concatenates with memory.prune.keep in config.",
      (value: string, previous?: string[]) => (previous ? [...previous, value] : [value]),
    )
    .option("--dry-run", "Show what would be pruned without deleting")
    .option("--yes", "Execute the prune (required unless --dry-run)"),
).action((opts) => {
  const dirs = resolveGraphsDirs(opts.workflows);
  const fileConfig = loadConfigFromDirs(dirs);
  // CLI --keep concatenates on top of memory.prune.keep in config.
  const mergedKeep = [...(fileConfig.memory.prune?.keep ?? []), ...(opts.keep ?? [])];
  const { store } = createMemoryStore({ workflows: opts.workflows });
  try {
    memoryPrune(store, { keep: mergedKeep, dryRun: opts.dryRun, yes: opts.yes });
  } finally {
    store.close();
  }
});

addWorkflowsOpt(
  memoryCmd
    .command("reset")
    .description("Delete memory.db + sidecars (re-created on next run)")
    .option("--confirm", "Required safety check"),
).action((opts) => {
  // Does NOT open the db — resolves the path from config and unlinks
  // the files directly. This is the recovery path for "old memory.db
  // schema is incompatible with the current build," which would
  // otherwise block composeRuntime from opening the db at all.
  const dirs = resolveGraphsDirs(opts.workflows);
  const fileConfig = loadConfigFromDirs(dirs);
  const memConfig = resolveMemoryConfig(dirs, {}, fileConfig);
  if (!memConfig) {
    outputJson({ status: "noop", reason: "memory disabled in config" });
    return;
  }
  memoryReset(memConfig.db, { confirm: opts.confirm });
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
  .addOption(
    new Option("--mode <mode>", "Distill mode").choices(["distill", "refine"]).default("distill"),
  )
  .action((opts) => {
    distillRun(opts);
  });

const sourcesCmd = program.command("sources").description("Manage source bindings and provenance");

addWorkflowsOpt(
  sourcesCmd
    .command("hash <paths...>")
    .description("Hash source files for provenance stamping (path or path:section)")
    .option("--source-root <path>", "Base path for resolving source references"),
).action((paths, opts) => {
  const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
  sourcesHash(setup.sourceOpts, paths);
});

addWorkflowsOpt(
  sourcesCmd
    .command("check <sources...>")
    .description("Validate source hashes (path:hash or path:section:hash)")
    .option("--source-root <path>", "Base path for resolving source references"),
).action((sources, opts) => {
  const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
  sourcesCheck(setup.sourceOpts, sources);
});

addWorkflowsOpt(
  sourcesCmd
    .command("validate")
    .description("Validate all source bindings across loaded graphs")
    .option("--graph <id>", "Check a single graph by ID")
    .option("--source-root <path>", "Base path for resolving source references"),
).action((opts) => {
  const setup = loadGraphSetup({ workflows: opts.workflows, sourceRoot: opts.sourceRoot });
  sourcesValidate(setup.graphsDirs, setup.sourceOpts, opts.graph);
});

// --- config ---

const configCmd = program.command("config").description("View and manage Freelance configuration");

addWorkflowsOpt(
  configCmd.command("show").description("Display resolved configuration with sources"),
).action((opts) => {
  configShow({ workflows: opts.workflows });
});

addWorkflowsOpt(
  configCmd
    .command("set-local <key> <value>")
    .description("Set a value in config.local.yml (for plugin hooks)"),
).action((key, value, opts) => {
  configSetLocal(key, value, { workflows: opts.workflows });
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
        EXIT.INVALID_INPUT,
        "UNKNOWN_SHELL",
      );
    }
    const completionFile = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "templates",
      "completions",
      `freelance.${shell}`,
    );
    if (!fs.existsSync(completionFile)) {
      fatal(`Completion file not found: ${completionFile}`, EXIT.NOT_FOUND, "COMPLETION_NOT_FOUND");
    }
    process.stdout.write(fs.readFileSync(completionFile, "utf-8"));
  });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFromDirs } from "./config.js";
import { createDefaultOpsRegistry, type OpsRegistry } from "./engine/operations.js";
import type { MemoryConfig } from "./memory/index.js";
import { MemoryStore, registerMemoryTools } from "./memory/index.js";
import { buildRecollectionWorkflow, RECOLLECTION_ID } from "./memory/recollection.js";
import { buildCompileKnowledgeWorkflow, COMPILE_KNOWLEDGE_ID } from "./memory/workflow.js";
import { validateOpsAndPrune } from "./ops-validation.js";
import type { SectionResolver, SourceOptions } from "./sources.js";
import { openStateStore, TraversalStore } from "./state/index.js";
import { registerFreelanceTools } from "./tools/index.js";
import type { ValidatedGraph } from "./types.js";
import { VERSION } from "./version.js";
import { watchGraphs } from "./watcher.js";

export interface ServerOptions {
  maxDepth?: number;
  graphsDirs?: string[];
  sectionResolver?: SectionResolver;
  /** Check source bindings at freelance_start (default: false). Provenance is a build concern. */
  validateSourcesOnStart?: boolean;
  /** Base path for resolving relative source paths. Defaults to parent of first graphsDir. */
  sourceRoot?: string;
  /** Structured errors from graph loading — surfaced in freelance_list */
  loadErrors?: Array<{ file: string; message: string }>;
  /** Memory configuration — enables persistent knowledge graph */
  memory?: MemoryConfig;
  /** Directory for persistent traversal state (one JSON file per traversal). Falls back to :memory: if not set. */
  stateDir?: string;
}

export function createServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions,
): {
  server: McpServer;
  stopWatcher?: () => void;
  memoryStore?: MemoryStore;
  manager: TraversalStore;
} {
  // MemoryStore is constructed before TraversalStore so the ops registry
  // can be built from it and passed into the engines the store creates.
  let memoryStore: MemoryStore | undefined;
  let opsRegistry: OpsRegistry | undefined;
  if (options?.memory?.enabled !== false && options?.memory?.db) {
    memoryStore = new MemoryStore(
      options.memory.db,
      options.sourceRoot,
      options.memory.collections,
    );
    opsRegistry = createDefaultOpsRegistry({ memoryStore });
  }

  // Mutable load errors — updated by watcher on reload. Tool handlers
  // read through the getter below so they always see the current value.
  let currentLoadErrors: Array<{ file: string; message: string }> = options?.loadErrors ?? [];

  // Post-load op-name validation. Graphs referencing unknown ops are
  // pruned and reported through the same loadErrors channel used for
  // structural failures.
  if (opsRegistry) {
    for (const err of validateOpsAndPrune(graphs, opsRegistry)) {
      currentLoadErrors = [...currentLoadErrors, { file: err.graphId, message: err.message }];
    }
  }

  const backend = openStateStore(options?.stateDir ?? ":memory:");
  const manager = new TraversalStore(backend, graphs, {
    maxDepth: options?.maxDepth,
    opsRegistry,
    opContext: memoryStore ? { memoryStore } : undefined,
  });

  // Shared source options — sourceRoot is the basePath for all source resolution
  const sourceOpts: SourceOptions = {
    resolver: options?.sectionResolver,
    basePath: options?.sourceRoot,
  };

  let stopWatcher: (() => void) | undefined;
  if (options?.graphsDirs?.length) {
    stopWatcher = watchGraphs({
      graphsDir: options.graphsDirs,
      onUpdate: (newGraphs) => {
        if (opsRegistry) {
          const opErrors = validateOpsAndPrune(newGraphs, opsRegistry);
          if (opErrors.length > 0) {
            currentLoadErrors = [
              ...currentLoadErrors,
              ...opErrors.map((e) => ({ file: e.graphId, message: e.message })),
            ];
          }
        }
        manager.updateGraphs(newGraphs);
      },
      onError: (err) => {
        process.stderr.write(`Graph reload failed: ${err.message}\n`);
      },
      onLoadErrors: (errors) => {
        currentLoadErrors = errors;
      },
      onConfigChange: () => {
        if (!memoryStore || !options?.graphsDirs) return;
        try {
          const config = loadConfigFromDirs(options.graphsDirs);
          memoryStore.updateConfig(config.memory.collections);
          process.stderr.write("Freelance: memory config reloaded\n");
        } catch {
          process.stderr.write("Freelance: failed to reload memory config\n");
        }
      },
    });
  }

  const server = new McpServer({ name: "freelance", version: VERSION });

  registerFreelanceTools(server, {
    manager,
    graphs,
    sourceOpts,
    graphsDirs: options?.graphsDirs,
    validateSourcesOnStart: options?.validateSourcesOnStart,
    getLoadErrors: () => currentLoadErrors,
  });

  if (memoryStore) {
    const hasActiveMemoryTraversal = () =>
      manager.hasActiveTraversalForGraph(COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID);
    registerMemoryTools(server, memoryStore, hasActiveMemoryTraversal);

    // Inject sealed memory workflows
    let injected = false;
    if (!graphs.has(COMPILE_KNOWLEDGE_ID)) {
      graphs.set(COMPILE_KNOWLEDGE_ID, buildCompileKnowledgeWorkflow());
      injected = true;
    }
    if (!graphs.has(RECOLLECTION_ID)) {
      graphs.set(RECOLLECTION_ID, buildRecollectionWorkflow());
      injected = true;
    }
    if (injected) {
      manager.updateGraphs(graphs);
    }
  }

  return { server, stopWatcher, memoryStore, manager };
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions,
): Promise<void> {
  const { server, stopWatcher, memoryStore, manager } = createServer(graphs, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Lifecycle breadcrumbs on stderr. By MCP stdio convention, stderr is
  // forwarded to the client's MCP log and not shown to the user. A matching
  // start/shutdown pair makes a rapid respawn loop visible in the log —
  // alternating lines with reason codes distinguish clean disconnects,
  // crashes, and orphans that never shut down. Keep them one-line and
  // unstructured to match how other MCP servers behave.
  process.stderr.write(`freelance-mcp ${VERSION} started pid=${process.pid}\n`);

  let shuttingDown = false;
  const shutdown = (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`freelance-mcp shutdown pid=${process.pid} reason=${reason}\n`);
    void (async () => {
      try {
        if (stopWatcher) stopWatcher();
        if (memoryStore) memoryStore.close();
        manager.close();
        await server.close();
      } finally {
        process.exit(exitCode);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));
  process.on("SIGHUP", () => shutdown("sighup"));

  // Crash-path cleanup. Without these, a thrown error escaping the event
  // loop would terminate the process without running memoryStore.close() —
  // and that clean close is exactly what unlinks the memory.db-wal and
  // memory.db-shm sidecar files. Skipping it is how orphaned WAL files
  // appear on disk.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`Freelance: uncaught exception: ${err.stack ?? err}\n`);
    shutdown("uncaught-exception", 1);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Freelance: unhandled rejection: ${String(reason)}\n`);
    shutdown("unhandled-rejection", 1);
  });

  // Parent-disconnect watchdog. The MCP stdio transport listens for `data`
  // and `error` on stdin but never exits when the stream ends, so a child
  // freelance-mcp process can outlive a parent that exited without sending
  // a signal (e.g. a backgrounded shell). That orphan then holds file
  // handles on memory.db and its WAL sidecar — on Windows this makes those
  // files undeletable. Treat every flavor of parent disconnect as a
  // shutdown request:
  //
  //   - `end`/`close`: clean EOF (parent closed its write end)
  //   - `error` with EBADF/EPIPE: fd revoked (macOS terminal close)
  process.stdin.on("end", () => shutdown("stdin-end"));
  process.stdin.on("close", () => shutdown("stdin-close"));
  process.stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EBADF" || err.code === "EPIPE") {
      shutdown(`stdin-${err.code.toLowerCase()}`);
    }
  });
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EBADF" || err.code === "EPIPE") {
      shutdown(`stdout-${err.code.toLowerCase()}`);
    }
  });
}

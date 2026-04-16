import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Runtime } from "./compose.js";
import { composeRuntime } from "./compose.js";
import { loadConfigFromDirs } from "./config.js";
import type { MemoryConfig } from "./memory/index.js";
import { registerMemoryTools } from "./memory/index.js";
import { buildRecollectionWorkflow, RECOLLECTION_ID } from "./memory/recollection.js";
import { buildCompileKnowledgeWorkflow, COMPILE_KNOWLEDGE_ID } from "./memory/workflow.js";
import type { SectionResolver } from "./sources.js";
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
  /** Max runtime per onEnter hook. Default 5000ms. */
  hookTimeoutMs?: number;
}

export function createServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions,
): {
  server: McpServer;
  stopWatcher?: () => void;
  runtime: Runtime;
} {
  const runtime = composeRuntime({
    graphs,
    graphsDir: options?.graphsDirs?.[0],
    stateDir: options?.stateDir ?? ":memory:",
    sourceRoot: options?.sourceRoot,
    sectionResolver: options?.sectionResolver,
    memory: options?.memory,
    maxDepth: options?.maxDepth,
    hookTimeoutMs: options?.hookTimeoutMs,
  });
  const { store: manager, memoryStore, sourceOpts } = runtime;

  // Mutable load errors — updated by watcher on reload. Tool handlers
  // read through the getter below so they always see the current value.
  let currentLoadErrors: Array<{ file: string; message: string }> = options?.loadErrors ?? [];

  let stopWatcher: (() => void) | undefined;
  if (options?.graphsDirs?.length) {
    stopWatcher = watchGraphs({
      graphsDir: options.graphsDirs,
      onUpdate: (newGraphs) => manager.updateGraphs(newGraphs),
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

  // --- Memory ---
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

  return { server, stopWatcher, runtime };
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions,
): Promise<void> {
  const { server, stopWatcher, runtime } = createServer(graphs, options);

  // Lifecycle breadcrumbs on stderr. By MCP stdio convention, stderr is
  // forwarded to the client's MCP log and not shown to the user. A matching
  // start/shutdown pair makes a rapid respawn loop visible in the log —
  // alternating lines with reason codes distinguish clean disconnects,
  // crashes, and orphans that never shut down. Keep them one-line and
  // unstructured to match how other MCP servers behave.
  process.stderr.write(`freelance-mcp ${VERSION} started pid=${process.pid}\n`);

  let shuttingDown = false;
  let parentHeartbeat: NodeJS.Timeout | undefined;
  const shutdown = (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (parentHeartbeat) clearInterval(parentHeartbeat);
    process.stderr.write(`freelance-mcp shutdown pid=${process.pid} reason=${reason}\n`);
    void (async () => {
      try {
        if (stopWatcher) stopWatcher();
        runtime.close();
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
  //
  // Register BEFORE server.connect() — connect() is what puts stdin into
  // flowing mode via the SDK's `data` listener, and `end` fires exactly
  // once. If EOF lands while connect() is awaiting, a listener attached
  // after would miss it permanently.
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

  // Parent-PID heartbeat. Pipe-close signals are unreliable when a chain of
  // stdio-inheriting descendants outlives the parent (npx middleman,
  // orphaned hook shells): the kernel keeps the pipe open until *every*
  // write-end fd is closed, so stdin never hits EOF. Poll the original
  // parent instead. Snapshot ppid now — once orphaned the kernel reparents
  // us to init (PID 1), and PID 1 never dies. `kill(pid, 0)` is a
  // permission/existence probe that throws ESRCH when the target is gone.
  // Skip the heartbeat if we're already orphaned at startup (ppid=1), which
  // means either there's no real parent to watch or the daemon was launched
  // detached on purpose.
  const initialPpid = process.ppid;
  if (initialPpid > 1) {
    parentHeartbeat = setInterval(() => {
      try {
        process.kill(initialPpid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          shutdown("parent-exited");
        }
      }
    }, 5000);
    parentHeartbeat.unref();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Safety net for the ordering fix above: if stdin drained and ended
  // synchronously inside connect(), our `end` listener already fired and
  // shutdown is in flight — this is a no-op. If for any reason the event
  // was missed, this catches it before we return control to the event loop.
  if (process.stdin.readableEnded) {
    shutdown("stdin-ended-early");
  }
}

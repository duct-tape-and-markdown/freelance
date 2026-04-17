import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Runtime } from "./compose.js";
import { composeRuntime } from "./compose.js";
import type { MemoryConfig } from "./memory/index.js";
import { registerMemoryTools } from "./memory/index.js";
import { getSealedGraphs, mergeSealedGraphs } from "./memory/sealed.js";
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

/**
 * Watch for the startup-time parent process going away and invoke `onExit`
 * when it does. Returns a `stop` function for cleanup; calling stop is
 * always safe (no-op when there was nothing to watch).
 *
 * Two detectors run on every tick, cheapest first:
 *
 *   1. **ppid drift.** When the original parent dies, the kernel reparents
 *      us to init or a subreaper, so `process.ppid` changes atomically. This
 *      is stronger than the existence probe: it's immune to PID recycling
 *      and it catches the case where we're reparented to PID 1 (which never
 *      dies, so `kill(1, 0)` always succeeds).
 *
 *   2. **Existence probe.** `kill(ppid, 0)` is the documented Node idiom for
 *      "is this process alive" — throws ESRCH when the target is gone.
 *      Kept as belt-and-braces for exotic schedulers where drift might lag.
 *
 * No-op when `ppid <= 1`: either we were already orphaned at startup or the
 * launcher intentionally detached us, in which case there is no parent to
 * watch.
 */
export function startParentHeartbeat(opts: {
  ppid: number;
  onExit: (reason: "parent-exited" | "parent-reparented") => void;
  intervalMs?: number;
}): () => void {
  const { ppid, onExit, intervalMs = 2000 } = opts;
  if (ppid <= 1) return () => {};
  const timer = setInterval(() => {
    if (process.ppid !== ppid) {
      onExit("parent-reparented");
      return;
    }
    try {
      process.kill(ppid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        onExit("parent-exited");
      }
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
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

  // Sealed memory workflows. User-authored workflows with the sealed ids
  // take precedence (mergeSealedGraphs skips ids already claimed). Built
  // once here and threaded to the loader/watcher so cross-graph validation
  // sees sealed ids BEFORE flagging them as unknown subgraph targets.
  const sealedGraphs = memoryStore ? getSealedGraphs() : undefined;

  let stopWatcher: (() => void) | undefined;
  if (options?.graphsDirs?.length) {
    stopWatcher = watchGraphs({
      graphsDir: options.graphsDirs,
      sealedGraphs,
      onUpdate: (newGraphs) => {
        manager.updateGraphs(newGraphs);
      },
      onError: (err) => {
        process.stderr.write(`Graph reload failed: ${err.message}\n`);
      },
      onLoadErrors: (errors) => {
        currentLoadErrors = errors;
      },
      onConfigChange: () => {
        process.stderr.write("Freelance: config reloaded\n");
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
  if (memoryStore && sealedGraphs) {
    // Gate memory writes on "must be inside SOME active traversal",
    // not "must be inside memory:compile or memory:recall specifically".
    // The gate exists to prevent accidental writes outside a structured
    // flow — any workflow that reached an emit point IS structured,
    // regardless of graph id. This lets user-authored workflows (e.g.
    // experiments/ablations) call memory_emit without being allow-listed.
    const hasActiveMemoryTraversal = () => manager.listTraversals().length > 0;
    registerMemoryTools(server, memoryStore, hasActiveMemoryTraversal);

    // Belt-and-braces: the caller is expected to have merged sealed
    // graphs before calling createServer (so cross-graph validation sees
    // them). Re-merge here to cover programmatic callers that passed a
    // bare graphs map. Idempotent — user-authored ids win.
    mergeSealedGraphs(graphs, sealedGraphs);
    manager.updateGraphs(graphs);
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
  let stopHeartbeat: () => void = () => {};
  const shutdown = (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopHeartbeat();
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

  // Snapshot ppid before connect — kernel reparents an orphaned process to
  // init/subreaper, so reading later gives the wrong target.
  stopHeartbeat = startParentHeartbeat({ ppid: process.ppid, onExit: shutdown });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // If stdin drained and ended synchronously inside connect(), our `end`
  // listener already fired and shutdown is in flight — this is a no-op.
  if (process.stdin.readableEnded) {
    shutdown("stdin-ended-early");
  }
}

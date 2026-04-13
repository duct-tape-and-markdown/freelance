import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfigFromDirs } from "./config.js";
import type { MemoryConfig } from "./memory/index.js";
import { MemoryStore, registerMemoryTools } from "./memory/index.js";
import { buildRecollectionWorkflow, RECOLLECTION_ID } from "./memory/recollection.js";
import { buildCompileKnowledgeWorkflow, COMPILE_KNOWLEDGE_ID } from "./memory/workflow.js";
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
  const backend = openStateStore(options?.stateDir ?? ":memory:");
  const manager = new TraversalStore(backend, graphs, options);

  // Mutable load errors — updated by watcher on reload. Tool handlers
  // read through the getter below so they always see the current value.
  let currentLoadErrors: Array<{ file: string; message: string }> = options?.loadErrors ?? [];

  // Shared source options — sourceRoot is the basePath for all source resolution
  const sourceOpts: SourceOptions = {
    resolver: options?.sectionResolver,
    basePath: options?.sourceRoot,
  };

  let stopWatcher: (() => void) | undefined;
  // memoryStore is assigned later but referenced by the watcher callback (fires async)
  let memoryStore: MemoryStore | undefined;
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
  if (options?.memory?.enabled !== false && options?.memory?.db) {
    memoryStore = new MemoryStore(
      options.memory.db,
      options.sourceRoot,
      options.memory.collections,
    );
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

  const shutdown = async () => {
    if (stopWatcher) stopWatcher();
    if (memoryStore) memoryStore.close();
    manager.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

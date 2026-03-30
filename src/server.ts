import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TraversalManager } from "./traversal-manager.js";
import { EngineError } from "./errors.js";
import { VERSION } from "./version.js";
import { getGuide } from "./guide.js";
import { watchGraphs } from "./watcher.js";
import { findGraphFiles, loadSingleGraph } from "./loader.js";
import { hashSources, checkSourcesDetailed, validateGraphSources, getDetailedDrift } from "./sources.js";
import type { SourceRef, SectionResolver, SourceOptions } from "./sources.js";
import type { ValidatedGraph } from "./types.js";

function jsonResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function errorResponse(message: string, detail?: unknown) {
  const payload = detail ?? { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

function handleError(e: unknown) {
  if (e instanceof EngineError) {
    return errorResponse(e.message);
  }
  // Catch-all for unexpected errors — prevents MCP server crash
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(`Internal error: ${message}`);
}

export interface ServerOptions {
  maxDepth?: number;
  persistDir?: string;
  graphsDirs?: string[];
  sectionResolver?: SectionResolver;
  /** Check source bindings at freelance_start (default: false). Provenance is a build concern. */
  validateSourcesOnStart?: boolean;
}

export function createServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions
): { server: McpServer; stopWatcher?: () => void } {
  const manager = new TraversalManager(graphs, options);

  let stopWatcher: (() => void) | undefined;
  if (options?.graphsDirs?.length) {
    stopWatcher = watchGraphs({
      graphsDir: options.graphsDirs,
      onUpdate: (newGraphs) => manager.updateGraphs(newGraphs),
      onError: (err) => { process.stderr.write(`Graph reload failed: ${err.message}\n`); },
    });
  }

  const server = new McpServer(
    { name: "freelance", version: VERSION },
  );

  // freelance_list
  server.tool(
    "freelance_list",
    "List all available workflow graphs and active traversals. Call this to discover which graphs are loaded and can be started.",
    {},
    () => {
      try {
        return jsonResponse(manager.listGraphs());
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_start
  server.tool(
    "freelance_start",
    "Begin traversing a workflow graph. Returns a traversalId for subsequent operations. Call freelance_list first to see available graphs.",
    {
      graphId: z.string().min(1),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) => {
      try {
        const result = manager.createTraversal(graphId, initialContext);

        // Source validation at start is opt-in — provenance is a build concern, not runtime [S-5]
        if (options?.validateSourcesOnStart) {
          const graph = graphs.get(graphId);
          if (graph) {
            const sourceOpts: SourceOptions = { resolver: options.sectionResolver };
            const sourceCheck = validateGraphSources(
              graph.definition,
              sourceOpts
            );
            if (!sourceCheck.valid) {
              return jsonResponse({
                ...result,
                sourceWarnings: sourceCheck.warnings,
              });
            }
          }
        }

        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_advance
  server.tool(
    "freelance_advance",
    "Move to the next node by taking a labeled edge. Optionally include context updates that are applied before edge evaluation. Context updates persist even if the advance fails.",
    {
      traversalId: z.string().optional(),
      edge: z.string().min(1),
      contextUpdates: z.record(z.string(), z.unknown()).optional(),
    },
    ({ traversalId, edge, contextUpdates }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        const result = manager.advance(id, edge, contextUpdates);
        if (result.isError) {
          return errorResponse(result.reason, result);
        }
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_context_set
  server.tool(
    "freelance_context_set",
    "Update session context without advancing. Use this to record work results before choosing which edge to take. Returns updated valid transitions with conditionMet evaluated.",
    {
      traversalId: z.string().optional(),
      updates: z.record(z.string(), z.unknown()),
    },
    ({ traversalId, updates }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.contextSet(id, updates));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_inspect
  server.tool(
    "freelance_inspect",
    "Read-only introspection of current graph state. Use after context compaction to re-orient. Returns current position, valid transitions, and context.",
    {
      traversalId: z.string().optional(),
      detail: z.enum(["position", "full", "history"]).default("position"),
    },
    ({ traversalId, detail }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.inspect(id, detail));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_reset
  server.tool(
    "freelance_reset",
    "Clear a traversal. Call this to start over or switch to a different graph. Requires confirm: true as a safety check.",
    {
      traversalId: z.string().optional(),
      confirm: z.boolean(),
    },
    ({ traversalId, confirm }) => {
      if (confirm !== true) {
        return errorResponse("Must pass confirm: true to reset.");
      }
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.resetTraversal(id));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_guide
  server.tool(
    "freelance_guide",
    "Get help with authoring Freelance workflow graphs. Call with no topic to see available topics.",
    {
      topic: z.string().optional(),
    },
    ({ topic }) => {
      const result = getGuide(topic);
      if ("error" in result) {
        return errorResponse(result.error);
      }
      return jsonResponse(result);
    }
  );

  // freelance_sources_hash
  server.tool(
    "freelance_sources_hash",
    "Hash one or more source locations for provenance stamping. Used when authoring graphs with source bindings. If section is provided and a section resolver is configured, hashes only that section's content; otherwise hashes the entire file.",
    {
      sources: z.array(z.object({
        path: z.string().min(1),
        section: z.string().optional(),
      })).min(1),
    },
    ({ sources }) => {
      try {
        const sourceOpts: SourceOptions = { resolver: options?.sectionResolver };
        const result = hashSources(sources as SourceRef[], sourceOpts);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_sources_check
  server.tool(
    "freelance_sources_check",
    "Validate previously stamped source hashes against current file state. Returns which sources have drifted since the graph was authored.",
    {
      sources: z.array(z.object({
        path: z.string().min(1),
        section: z.string().optional(),
        hash: z.string().min(1),
      })).min(1),
    },
    ({ sources }) => {
      try {
        const sourceOpts: SourceOptions = { resolver: options?.sectionResolver };
        const result = checkSourcesDetailed(sources, sourceOpts);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // freelance_sources_validate
  server.tool(
    "freelance_sources_validate",
    "Validate source hashes across all loaded graphs (or a single graph). Walks every source binding in every node and reports drift. Pass graphId to check one graph, or omit to check all.",
    {
      graphId: z.string().optional(),
    },
    ({ graphId }) => {
      try {
        if (!options?.graphsDirs?.length) {
          return errorResponse("No graphsDirs configured — cannot resolve source paths");
        }

        // Collect workflow files and their definitions, keyed by graph ID
        const fileMap = new Map<string, ValidatedGraph["definition"]>();
        for (const dir of options.graphsDirs) {
          for (const filePath of findGraphFiles(dir)) {
            try {
              const loaded = loadSingleGraph(filePath);
              fileMap.set(loaded.id, loaded.definition);
            } catch {
              // Skip files that fail to load — validate command handles those
            }
          }
        }

        const targets = graphId
          ? fileMap.has(graphId) ? [graphId] : []
          : [...fileMap.keys()];

        if (targets.length === 0) {
          return errorResponse(graphId ? `Graph not found: ${graphId}` : "No graphs loaded");
        }

        const drift: Array<{
          graphId: string;
          node: string;
          drifted: Array<{ path: string; section?: string; expected: string; actual: string }>;
        }> = [];

        // Resolve source paths from CWD — consistent with freelance_sources_hash authoring flow
        const sourceOpts: SourceOptions = { resolver: options?.sectionResolver };

        for (const id of targets) {
          const def = fileMap.get(id)!;
          const sourceResult = validateGraphSources(def, sourceOpts);

          for (const warning of sourceResult.warnings) {
            drift.push({
              graphId: id,
              node: warning.node,
              drifted: getDetailedDrift(def, warning.node, sourceOpts),
            });
          }
        }

        return jsonResponse({
          valid: drift.length === 0,
          graphsChecked: targets.length,
          drift,
        });
      } catch (e) {
        return handleError(e);
      }
    }
  );

  return { server, stopWatcher };
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>,
  options?: ServerOptions
): Promise<void> {
  const { server, stopWatcher } = createServer(graphs, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    if (stopWatcher) stopWatcher();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

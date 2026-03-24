import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TraversalManager } from "./traversal-manager.js";
import { EngineError } from "./errors.js";
import { VERSION } from "./version.js";
import { getGuide } from "./guide.js";
import { watchGraphs } from "./watcher.js";
import { hashSources, checkSourcesDetailed, validateGraphSources } from "./sources.js";
import type { SourceRef, SectionResolver } from "./sources.js";
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

  // graph_list
  server.tool(
    "graph_list",
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

  // graph_start
  server.tool(
    "graph_start",
    "Begin traversing a workflow graph. Returns a traversalId for subsequent operations. Call graph_list first to see available graphs.",
    {
      graphId: z.string().min(1),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) => {
      try {
        const result = manager.createTraversal(graphId, initialContext);

        // Check source bindings for drift (informational only)
        const graph = graphs.get(graphId);
        if (graph) {
          const sourceCheck = validateGraphSources(
            graph.definition,
            options?.sectionResolver
          );
          if (!sourceCheck.valid) {
            return jsonResponse({
              ...result,
              sourceWarnings: sourceCheck.warnings,
            });
          }
        }

        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // graph_advance
  server.tool(
    "graph_advance",
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

  // graph_context_set
  server.tool(
    "graph_context_set",
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

  // graph_inspect
  server.tool(
    "graph_inspect",
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

  // graph_reset
  server.tool(
    "graph_reset",
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

  // graph_guide
  server.tool(
    "graph_guide",
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

  // graph_sources_hash
  server.tool(
    "graph_sources_hash",
    "Hash one or more source locations for provenance stamping. Used when authoring graphs with source bindings. If section is provided and a section resolver is configured, hashes only that section's content; otherwise hashes the entire file.",
    {
      sources: z.array(z.object({
        path: z.string().min(1),
        section: z.string().optional(),
      })),
    },
    ({ sources }) => {
      try {
        const result = hashSources(sources as SourceRef[], options?.sectionResolver);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // graph_sources_check
  server.tool(
    "graph_sources_check",
    "Validate previously stamped source hashes against current file state. Returns which sources have drifted since the graph was authored.",
    {
      sources: z.array(z.object({
        path: z.string().min(1),
        section: z.string().optional(),
        hash: z.string().min(1),
      })),
    },
    ({ sources }) => {
      try {
        const result = checkSourcesDetailed(sources, options?.sectionResolver);
        return jsonResponse(result);
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

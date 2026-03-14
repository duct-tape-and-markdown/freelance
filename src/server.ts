import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TraversalManager } from "./traversal-manager.js";
import { EngineError } from "./errors.js";
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

export function createServer(
  graphs: Map<string, ValidatedGraph>,
  options?: { maxDepth?: number; persistDir?: string }
): McpServer {
  const manager = new TraversalManager(graphs, options);

  const server = new McpServer(
    { name: "graph-engine", version: "0.1.0" },
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
        return jsonResponse(manager.createTraversal(graphId, initialContext));
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

  return server;
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>,
  options?: { maxDepth?: number; persistDir?: string }
): Promise<void> {
  const server = createServer(graphs, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

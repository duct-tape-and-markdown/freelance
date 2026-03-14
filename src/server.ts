import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GraphEngine } from "./engine.js";
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
  options?: { maxDepth?: number }
): McpServer {
  const engine = new GraphEngine(graphs, options);

  const server = new McpServer(
    { name: "graph-engine", version: "0.1.0" },
  );

  // graph_list
  server.tool(
    "graph_list",
    "List all available workflow graphs. Call this to discover which graphs are loaded and can be started.",
    {},
    () => jsonResponse(engine.list())
  );

  // graph_start
  server.tool(
    "graph_start",
    "Begin traversing a workflow graph. Must be called before advance, context_set, or inspect. Call graph_list first to see available graphs.",
    {
      graphId: z.string().min(1),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) => {
      try {
        return jsonResponse(engine.start(graphId, initialContext));
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
      edge: z.string().min(1),
      contextUpdates: z.record(z.string(), z.unknown()).optional(),
    },
    ({ edge, contextUpdates }) => {
      try {
        const result = engine.advance(edge, contextUpdates);
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
      updates: z.record(z.string(), z.unknown()),
    },
    ({ updates }) => {
      try {
        return jsonResponse(engine.contextSet(updates));
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
      detail: z.enum(["position", "full", "history"]).default("position"),
    },
    ({ detail }) => {
      try {
        return jsonResponse(engine.inspect(detail));
      } catch (e) {
        return handleError(e);
      }
    }
  );

  // graph_reset
  // Note: confirm is z.boolean() (not z.literal(true)) intentionally.
  // If the agent passes false, the handler returns a descriptive error message.
  // Using z.literal(true) would reject with a generic zod validation error,
  // which is less helpful for agent recovery.
  server.tool(
    "graph_reset",
    "Clear the current traversal. Call this to start over or switch to a different graph. Requires confirm: true as a safety check.",
    {
      confirm: z.boolean(),
    },
    ({ confirm }) => {
      if (confirm !== true) {
        return errorResponse("Must pass confirm: true to reset.");
      }
      return jsonResponse(engine.reset());
    }
  );

  return server;
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>,
  options?: { maxDepth?: number }
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

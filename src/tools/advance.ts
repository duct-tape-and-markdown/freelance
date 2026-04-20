import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerAdvanceTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_advance",
    {
      description:
        "Move a traversal forward by taking a named edge. The edge label must be one of the current node's validTransitions. Optional contextUpdates are applied before the edge condition evaluates.",
      inputSchema: {
        traversalId: z.string().optional(),
        edge: z.string().min(1),
        contextUpdates: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ traversalId, edge, contextUpdates }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        const result = await manager.advance(id, edge, contextUpdates);
        if (result.isError) {
          return errorResponse(result.reason, result);
        }
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerAdvanceTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

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
    },
  );
}

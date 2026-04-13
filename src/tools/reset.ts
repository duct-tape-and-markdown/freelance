import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerResetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

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
    },
  );
}

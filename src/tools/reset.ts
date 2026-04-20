import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerResetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_reset",
    {
      description:
        "Destroy a traversal, discarding its stack and context. Requires confirm: true. Irreversible.",
      inputSchema: {
        traversalId: z.string().optional(),
        confirm: z.boolean(),
      },
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

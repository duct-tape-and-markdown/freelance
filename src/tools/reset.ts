import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerResetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.tool(
    "freelance_reset",
    "Clear a traversal, discarding its stack and context. Use this to start a workflow over from the beginning or to abandon one before starting a different graph. Requires confirm: true — this is a deliberate guard against accidental resets from ambiguous tool-call sequences, not a security check. Destroyed context cannot be recovered.",
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

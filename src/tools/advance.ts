import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerAdvanceTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.tool(
    "freelance_advance",
    "Take a labeled edge to move a traversal forward by one node. The edge label comes from the current node's validTransitions (returned by any freelance_* call that reports state). Optional contextUpdates are applied before the edge's condition evaluates, so you can set a condition variable in the same call; updates persist even if the advance fails. If the edge's condition evaluates false, the call errors and the current node is unchanged — fix the relevant context and retry. The engine enforces graph topology: you cannot bypass a condition or jump to a node that isn't directly targeted from where you are.",
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

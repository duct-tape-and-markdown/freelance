import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerContextSetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_context_set",
    {
      description:
        "Update traversal context without advancing. Record work results (e.g. `{ testsPass: true }`) and see which edge conditions are now satisfied. Alternative: pass contextUpdates directly to freelance_advance.",
      inputSchema: {
        traversalId: z.string().optional(),
        updates: z.record(z.string(), z.unknown()),
      },
    },
    ({ traversalId, updates }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.contextSet(id, updates));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerContextSetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.tool(
    "freelance_context_set",
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
    },
  );
}

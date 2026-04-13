import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerInspectTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.tool(
    "freelance_inspect",
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
    },
  );
}

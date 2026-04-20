import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerInspectTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_inspect",
    {
      description:
        "Read-only view of traversal state. Primary recovery tool after context compaction — traversal state lives on the server and survives. Detail: 'position' (default: current node + validTransitions), 'full' (+ context), 'history' (+ stack and transitions taken). Meta tags always included.",
      inputSchema: {
        traversalId: z.string().optional(),
        detail: z.enum(["position", "full", "history"]).default("position"),
      },
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

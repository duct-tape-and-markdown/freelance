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
        "Read-only introspection of the current traversal state. The primary recovery tool after context compaction — traversal state lives on the server and survives, but your awareness of where you are doesn't. Detail levels: 'position' (default — current node and valid transitions, minimal), 'full' (position plus full context), 'history' (stack + transitions taken so far). Any `meta` tags set at freelance_start are returned at the top level of the response regardless of detail. Does not mutate anything.",
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerMetaSetTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_meta_set",
    {
      description:
        "Merge string tags into a traversal's meta map. Use when a lookup key (PR url, branch) becomes known mid-traversal. See `freelance_guide meta`.",
      inputSchema: {
        traversalId: z.string().optional(),
        meta: z.record(z.string(), z.string()).refine((m) => Object.keys(m).length > 0, {
          message: "meta must contain at least one key=value pair",
        }),
      },
    },
    ({ traversalId, meta }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.setMeta(id, meta));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

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
        "Merge opaque tags into a traversal's `meta`. Use this when a lookup key (e.g. a PR url, a branch name) only becomes known mid-traversal. New keys are added, existing keys are overwritten. Freelance never interprets the keys or values — they exist purely so external systems can find the traversal by their own business key. Returns the full merged meta.",
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

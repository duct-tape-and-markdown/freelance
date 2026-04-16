import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerResumeTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_resume",
    {
      description:
        "Restore everything a caller needs to pick an existing traversal back up: current node, valid edges, full context, meta tags, and stack depth. Read-only — the traversal isn't mutated. Pair with freelance_traversals_find when you only have an external key (e.g. a ticket id) and need to discover the traversalId first. Unlike freelance_inspect, this always returns position-level detail and includes the meta tags set at freelance_start time.",
      inputSchema: {
        traversalId: z.string().min(1),
      },
    },
    ({ traversalId }) => {
      try {
        return jsonResponse(manager.resumeTraversal(traversalId));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

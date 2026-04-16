import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerTraversalsFindTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager } = deps;

  server.registerTool(
    "freelance_traversals_find",
    {
      description:
        "Look up active traversals by the opaque `meta` tags supplied at freelance_start (e.g. `{ externalKey: 'DEV-1234' }` or `{ prUrl: '…', branch: 'feature/x' }`). Every key/value in `meta` must match — multi-key queries narrow rather than widen. Freelance doesn't interpret what the tags mean; they're purely a caller-supplied index. Returns a list of TraversalInfo (may be empty, may contain multiple entries — e.g. distinct phases of the same ticket), sorted most-recently-updated first. Pair with freelance_resume to restore a specific traversal.",
      inputSchema: {
        meta: z.record(z.string(), z.string()).refine((m) => Object.keys(m).length > 0, {
          message: "meta must contain at least one key=value pair",
        }),
      },
    },
    ({ meta }) => {
      try {
        return jsonResponse(manager.findTraversalsByMeta(meta));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

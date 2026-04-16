import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { validateGraphSources } from "../sources.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerStartTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager, graphs, sourceOpts, validateSourcesOnStart } = deps;

  server.registerTool(
    "freelance_start",
    {
      description:
        "Begin a new traversal of a workflow graph — this creates a server-side state machine rooted at the graph's start node. Returns a traversalId which is passed to advance/inspect/context_set (or omitted when there's only one active traversal). Call freelance_list first to see available graphs. initialContext is an optional map of key/value pairs the workflow's conditions and instructions can reference from the first node onward. meta is an optional map of opaque string tags (e.g. `{ externalKey: 'DEV-1234' }`) that Freelance indexes but never interprets — use freelance_traversals_find / freelance_resume to look the traversal back up by these tags later. Tags are immutable after start.",
      inputSchema: {
        graphId: z.string().min(1),
        initialContext: z.record(z.string(), z.unknown()).optional(),
        meta: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ graphId, initialContext, meta }) => {
      try {
        const result = await manager.createTraversal(graphId, initialContext, meta);

        // Source validation at start is opt-in — provenance is a build concern, not runtime [S-5]
        if (validateSourcesOnStart) {
          const graph = graphs.get(graphId);
          if (graph) {
            const sourceCheck = validateGraphSources(graph.definition, sourceOpts);
            if (!sourceCheck.valid) {
              return jsonResponse({
                ...result,
                sourceWarnings: sourceCheck.warnings,
              });
            }
          }
        }

        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

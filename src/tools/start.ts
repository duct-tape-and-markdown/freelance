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
        "Start a new traversal of a workflow graph. Returns the start node's instructions and a traversalId for subsequent calls. Pass initialContext for seed state and meta for external lookup tags (e.g. ticket id). See `freelance_guide meta` for meta patterns.",
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

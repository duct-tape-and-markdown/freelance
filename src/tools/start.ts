import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { validateGraphSources } from "../sources.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerStartTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager, graphs, sourceOpts, validateSourcesOnStart } = deps;

  server.tool(
    "freelance_start",
    "Begin traversing a workflow graph. Returns a traversalId for subsequent operations. Call freelance_list first to see available graphs.",
    {
      graphId: z.string().min(1),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) => {
      try {
        const result = manager.createTraversal(graphId, initialContext);

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

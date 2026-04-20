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
        "Read-only view of traversal state. Primary recovery tool after context compaction. Detail: 'position' (default: current node + validTransitions + context) or 'history' (+ transitions taken + context writes + totalSteps/totalContextWrites). Optional `fields` adds graph-structure projections: 'currentNode' (full NodeDefinition), 'neighbors' (one-edge-away NodeDefinitions), 'contextSchema' (declared schema), 'definition' (entire graph — escape hatch). For history: `limit`/`offset` paginate traversalHistory (default 50, max 200); contextHistory always ships in full. Per-step contextSnapshots stripped unless `includeSnapshots: true`. Meta tags always included.",
      inputSchema: {
        traversalId: z.string().optional(),
        detail: z.enum(["position", "history"]).default("position"),
        fields: z
          .array(z.enum(["currentNode", "neighbors", "contextSchema", "definition"]))
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        includeSnapshots: z.boolean().optional(),
      },
    },
    ({ traversalId, detail, fields, limit, offset, includeSnapshots }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(
          manager.inspect(id, detail, fields, { limit, offset, includeSnapshots }),
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

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
        "Read-only view of traversal state. Primary recovery tool after context compaction. Detail: 'position' (default: current node + validTransitions + context) or 'history' (+ stack and transitions taken). Optional `fields` adds graph-structure projections: 'currentNode' (full NodeDefinition), 'neighbors' (one-edge-away NodeDefinitions), 'contextSchema' (declared schema), 'definition' (entire graph — escape hatch). Meta tags always included.",
      inputSchema: {
        // `full` is a deprecated alias — the store coerces it to
        // position + fields:["definition"] so in-flight callers keep
        // working. New callers should use `detail` + `fields` directly.
        traversalId: z.string().optional(),
        detail: z.enum(["position", "history", "full"]).default("position"),
        fields: z
          .array(z.enum(["currentNode", "neighbors", "contextSchema", "definition"]))
          .optional(),
      },
    },
    ({ traversalId, detail, fields }) => {
      try {
        const id = manager.resolveTraversalId(traversalId);
        return jsonResponse(manager.inspect(id, detail, fields));
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

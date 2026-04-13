import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findGraphFiles, loadSingleGraph } from "../loader.js";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import { getDetailedDrift, validateGraphSources } from "../sources.js";
import type { ValidatedGraph } from "../types.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerSourcesValidateTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { graphsDirs, sourceOpts } = deps;

  server.tool(
    "freelance_sources_validate",
    "Validate source hashes across all loaded graphs (or a single graph). Walks every source binding in every node and reports drift. Pass graphId to check one graph, or omit to check all.",
    {
      graphId: z.string().optional(),
    },
    ({ graphId }) => {
      try {
        if (!graphsDirs?.length) {
          return errorResponse("No graphsDirs configured — cannot resolve source paths");
        }

        // Collect workflow files and their definitions, keyed by graph ID
        const fileMap = new Map<string, ValidatedGraph["definition"]>();
        for (const dir of graphsDirs) {
          for (const filePath of findGraphFiles(dir)) {
            try {
              const loaded = loadSingleGraph(filePath);
              fileMap.set(loaded.id, loaded.definition);
            } catch {
              // Skip files that fail to load — validate command handles those
            }
          }
        }

        const targets = graphId ? (fileMap.has(graphId) ? [graphId] : []) : [...fileMap.keys()];

        if (targets.length === 0) {
          return errorResponse(graphId ? `Graph not found: ${graphId}` : "No graphs loaded");
        }

        const drift: Array<{
          graphId: string;
          node: string;
          drifted: Array<{ path: string; section?: string; expected: string; actual: string }>;
        }> = [];

        for (const id of targets) {
          const def = fileMap.get(id);
          if (!def) continue;
          const sourceResult = validateGraphSources(def, sourceOpts);

          for (const warning of sourceResult.warnings) {
            drift.push({
              graphId: id,
              node: warning.node,
              drifted: getDetailedDrift(def, warning.node, sourceOpts),
            });
          }
        }

        return jsonResponse({
          valid: drift.length === 0,
          graphsChecked: targets.length,
          drift,
        });
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

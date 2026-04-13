import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findGraphFiles, loadSingleGraph } from "../loader.js";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import { getDetailedDrift, validateGraphSources } from "../sources.js";
import type { ValidatedGraph } from "../types.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerSourcesValidateTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { graphsDirs, sourceOpts } = deps;

  server.tool(
    "freelance_sources_validate",
    "Walk every source binding in every loaded graph (or a single graph if graphId is passed) and report drift against the current filesystem. Broader than freelance_sources_check — you don't pass hashes explicitly; this tool reads them from the graph definitions directly. Use when you want an at-a-glance health check of all provenance: run it after a pull, before a release, or when diagnosing why a workflow is behaving unexpectedly against current sources. Returns per-node drift reports with expected vs actual hashes.",
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

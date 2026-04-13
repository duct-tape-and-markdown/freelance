import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findGraphFiles, loadSingleGraph, validateCrossGraphRefs } from "../loader.js";
import { errorResponse, handleError, jsonResponse } from "../mcp-helpers.js";
import type { ValidatedGraph } from "../types.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerValidateTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { graphsDirs } = deps;

  server.tool(
    "freelance_validate",
    "Validate workflow graph definitions for structural errors. Walks configured graphsDirs, parses every .workflow.yaml, and reports schema errors (missing fields, wrong types), expression errors (invalid edge conditions or validation rules), topology errors (unreachable nodes, cycles without a breaking node, invalid subgraph references), and return schema errors. This is authoring-time validation — runtime conditions are checked by the engine at advance time. Use it to diagnose why a graph isn't appearing in freelance_list, or to validate a new graph before it ships.",
    {
      graphId: z.string().optional(),
    },
    ({ graphId }) => {
      try {
        if (!graphsDirs?.length) {
          return errorResponse("No graphsDirs configured — cannot validate graphs");
        }

        const validGraphs: Array<{ id: string; name: string; version: string; nodeCount: number }> =
          [];
        const errors: Array<{ file: string; message: string }> = [];
        const parsed = new Map<string, ValidatedGraph>();

        for (const dir of graphsDirs) {
          for (const filePath of findGraphFiles(dir)) {
            const relFile = path.relative(dir, filePath);
            try {
              const { id, definition, graph } = loadSingleGraph(filePath);
              parsed.set(id, { definition, graph });
              validGraphs.push({
                id,
                name: definition.name,
                version: definition.version,
                nodeCount: graph.nodeCount(),
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              errors.push({ file: relFile, message: msg });
            }
          }
        }

        // Cross-graph validation (only if individual files passed)
        if (errors.length === 0 && parsed.size > 0) {
          try {
            validateCrossGraphRefs(parsed);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push({ file: "(cross-graph)", message: msg });
          }
        }

        // Filter to specific graph if requested
        if (graphId) {
          const matchedGraph = validGraphs.find((g) => g.id === graphId);
          const matchedErrors = errors.filter(
            (e) => e.message.includes(graphId) || e.file.includes(graphId),
          );

          if (!matchedGraph && matchedErrors.length === 0) {
            return errorResponse(`Graph not found: ${graphId}`);
          }

          return jsonResponse({
            valid: matchedErrors.length === 0 && !!matchedGraph,
            graphs: matchedGraph ? [matchedGraph] : [],
            errors: matchedErrors,
          });
        }

        return jsonResponse({
          valid: errors.length === 0,
          graphs: validGraphs,
          errors,
        });
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

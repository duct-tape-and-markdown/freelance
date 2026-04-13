import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { hashSources, type SourceRef } from "../sources.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerSourcesHashTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.tool(
    "freelance_sources_hash",
    "Hash one or more source locations for provenance stamping. Used when authoring graphs with source bindings. If section is provided and a section resolver is configured, hashes only that section's content; otherwise hashes the entire file.",
    {
      sources: z
        .array(
          z.object({
            path: z.string().min(1),
            section: z.string().optional(),
          }),
        )
        .min(1),
    },
    ({ sources }) => {
      try {
        const result = hashSources(sources as SourceRef[], sourceOpts);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

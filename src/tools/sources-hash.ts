import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { hashSources, type SourceRef } from "../sources.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerSourcesHashTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.tool(
    "freelance_sources_hash",
    "Hash source files (or sections of files) to generate content hashes for graph source bindings. This is an authoring-time tool: when you're writing a workflow node that references a doc or file as provenance, you stamp the current hash here so freelance_sources_check can later detect drift. Each source is a {path, section?} pair; if section is provided and a section resolver is configured (e.g. Markdown heading extraction), only that section's content is hashed — otherwise the full file. Not used at runtime; provenance validation is a build concern.",
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

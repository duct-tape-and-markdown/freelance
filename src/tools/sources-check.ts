import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { checkSourcesDetailed } from "../sources.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerSourcesCheckTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.tool(
    "freelance_sources_check",
    "Verify that previously stamped source hashes still match the files on disk. Takes an array of {path, section?, hash} triples (the hash from an earlier freelance_sources_hash call) and returns which have drifted. Use this when you have a specific set of hashes to check — from a CI step, a hand-curated audit list, or a pinned reference you're about to use. For walking every source binding across every loaded graph instead, use freelance_sources_validate.",
    {
      sources: z
        .array(
          z.object({
            path: z.string().min(1),
            section: z.string().optional(),
            hash: z.string().min(1),
          }),
        )
        .min(1),
    },
    ({ sources }) => {
      try {
        const result = checkSourcesDetailed(sources, sourceOpts);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

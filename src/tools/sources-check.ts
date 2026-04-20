import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { checkSourcesDetailed } from "../sources.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerSourcesCheckTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.registerTool(
    "freelance_sources_check",
    {
      description:
        "Verify previously stamped source hashes against files on disk. Takes {path, section?, hash} triples and returns drifted entries. For bulk validation across every loaded graph (no explicit hashes), use freelance_sources_validate.",
      inputSchema: {
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

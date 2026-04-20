import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { hashSources } from "../sources.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerSourcesHashTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.registerTool(
    "freelance_sources_hash",
    {
      description:
        "Generate content hashes for source bindings in workflow graphs. Authoring-time tool — stamp hashes so freelance_sources_check can detect drift later. See `freelance_guide sources`.",
      inputSchema: {
        sources: z
          .array(
            z.object({
              path: z.string().min(1),
              section: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    ({ sources }) => {
      try {
        const result = hashSources(sources, sourceOpts);
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

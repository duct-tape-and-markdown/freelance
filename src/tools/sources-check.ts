import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import { checkSourcesDetailed } from "../sources.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerSourcesCheckTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { sourceOpts } = deps;

  server.tool(
    "freelance_sources_check",
    "Validate previously stamped source hashes against current file state. Returns which sources have drifted since the graph was authored.",
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

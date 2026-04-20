import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGuide } from "../guide.js";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";

export function registerGuideTool(server: McpServer): void {
  server.registerTool(
    "freelance_guide",
    {
      description:
        "Reference guide for workflow authoring (schema, edges, subgraphs, hooks, meta, anti-patterns) and for orientation on the sealed memory workflows (memory:compile, memory:recall). Not the right tool to run an existing workflow — for that, call freelance_list and freelance_start. Call with no topic for the table of contents.",
      inputSchema: {
        topic: z.string().optional(),
      },
    },
    ({ topic }) => {
      const result = getGuide(topic);
      if ("error" in result) {
        return errorResponse(result.error);
      }
      return jsonResponse(result);
    },
  );
}

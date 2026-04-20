import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGuide } from "../guide.js";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";

export function registerGuideTool(server: McpServer): void {
  server.registerTool(
    "freelance_guide",
    {
      description:
        "Reference guide for authoring and running workflows. Covers schema, edges, subgraphs, hooks, memory tools, sources, and common mistakes. Call with no topic for the table of contents.",
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGuide } from "../guide.js";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";

export function registerGuideTool(server: McpServer): void {
  server.tool(
    "freelance_guide",
    "Get help with authoring Freelance workflow graphs. Call with no topic to see available topics.",
    {
      topic: z.string().optional(),
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

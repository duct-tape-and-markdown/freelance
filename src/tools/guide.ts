import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGuide } from "../guide.js";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";

export function registerGuideTool(server: McpServer): void {
  server.tool(
    "freelance_guide",
    "Authoring guidance for writing .workflow.yaml graph definitions. This is for humans (or agents) creating new graphs, not for agents traversing existing ones — if you're being asked to run a workflow, call freelance_list + freelance_start instead. Call with no topic to see available topics (schema, conditions, subgraphs, source bindings, etc.).",
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

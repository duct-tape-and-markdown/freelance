import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGuide } from "../guide.js";
import { errorResponse, jsonResponse } from "../mcp-helpers.js";

export function registerGuideTool(server: McpServer): void {
  server.registerTool(
    "freelance_guide",
    {
      description:
        "Authoring guidance for writing .workflow.yaml graph definitions — schema, conditions, subgraphs, source bindings, edge semantics, and common mistakes. Use this when you're creating or refining a workflow graph (for example, after freelance_distill hands you an authoring prompt). NOT the right tool when you're asked to run an existing workflow — for that, call freelance_list and freelance_start. Call with no topic to see the table of contents.",
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

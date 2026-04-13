import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDistillPrompt } from "../distill.js";
import { jsonResponse } from "../mcp-helpers.js";

export function registerDistillTool(server: McpServer): void {
  server.tool(
    "freelance_distill",
    "Distill a completed task into a workflow graph, or refine an existing workflow after a guided run. Mode 'distill' (default): reconstructs an organic task into a new .workflow.yaml. Mode 'refine': reviews how a workflow-guided task went and improves the graph — smooths friction, adjusts gates, fixes routing.",
    {
      mode: z.enum(["distill", "refine"]).default("distill"),
    },
    ({ mode }) => {
      return jsonResponse(getDistillPrompt(mode));
    },
  );
}

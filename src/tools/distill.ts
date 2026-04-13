import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDistillPrompt } from "../distill.js";
import { jsonResponse } from "../mcp-helpers.js";

export function registerDistillTool(server: McpServer): void {
  server.tool(
    "freelance_distill",
    "Returns an instruction prompt for distilling a completed task into a workflow graph or refining an existing one. Mode 'distill' (default): after you've finished an ad-hoc task worth capturing for reuse, this prompt tells you how to reconstruct the task history into a new .workflow.yaml definition. Mode 'refine': after running a workflow-guided task that felt awkward (gates fired wrong, edges were missing, instructions were vague), this prompt tells you how to review and improve the graph. The tool returns the prompt itself — it doesn't write a graph for you; it hands you the analysis framework so you do the authoring.",
    {
      mode: z.enum(["distill", "refine"]).default("distill"),
    },
    ({ mode }) => {
      return jsonResponse(getDistillPrompt(mode));
    },
  );
}

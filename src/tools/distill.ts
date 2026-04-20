import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDistillPrompt } from "../distill.js";
import { jsonResponse } from "../mcp-helpers.js";

export function registerDistillTool(server: McpServer): void {
  server.registerTool(
    "freelance_distill",
    {
      description:
        "Get an instruction prompt for creating a new workflow graph ('distill', default) or improving an existing one ('refine'). Returns the analysis framework — you do the authoring.",
      inputSchema: {
        mode: z.enum(["distill", "refine"]).default("distill"),
      },
    },
    ({ mode }) => {
      return jsonResponse(getDistillPrompt(mode));
    },
  );
}

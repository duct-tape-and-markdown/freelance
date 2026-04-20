import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./deps.js";

export function registerListTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager, getLoadErrors } = deps;

  server.registerTool(
    "freelance_list",
    {
      description:
        "List loaded workflow graphs and any active traversals. Call first to discover available graphs or resume an in-progress traversal. Includes loadErrors when .workflow.yaml files failed to parse.",
      inputSchema: {},
    },
    () => {
      try {
        const result = manager.listGraphs();
        const loadErrors = getLoadErrors();
        if (loadErrors.length > 0) {
          return jsonResponse({ ...result, loadErrors });
        }
        return jsonResponse(result);
      } catch (e) {
        return handleError(e);
      }
    },
  );
}

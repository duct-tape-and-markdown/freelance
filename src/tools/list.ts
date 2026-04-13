import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerListTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager, getLoadErrors } = deps;

  server.tool(
    "freelance_list",
    "List all available workflow graphs and active traversals. Call this to discover which graphs are loaded and can be started. If any graphs failed to load, loadErrors will be present — use freelance_validate for details.",
    {},
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

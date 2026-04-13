import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleError, jsonResponse } from "../mcp-helpers.js";
import type { FreelanceToolDeps } from "./index.js";

export function registerListTool(server: McpServer, deps: FreelanceToolDeps): void {
  const { manager, getLoadErrors } = deps;

  server.tool(
    "freelance_list",
    "Discover what Freelance workflows are available. Returns the set of loaded graph definitions (each with id, name, version, nodeCount) plus any active traversals already running. Call this first in any session that might use Freelance — it's the cheapest way to answer 'what can I run?' and 'am I already mid-workflow?' If any .workflow.yaml files failed to load, the result includes a loadErrors array; call freelance_validate for the specific parse or topology errors.",
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

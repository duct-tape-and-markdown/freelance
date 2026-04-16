/**
 * Freelance workflow MCP tool registration.
 *
 * Each freelance_* tool lives in its own file and exports a register
 * function. The orchestrator here composes them all and is what
 * server.ts calls. Pattern matches src/memory/tools.ts (which groups
 * all memory tools in one file because there are only eight) and the
 * upstream @modelcontextprotocol/server-everything (one tool per file).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAdvanceTool } from "./advance.js";
import { registerContextSetTool } from "./context-set.js";
import type { FreelanceToolDeps } from "./deps.js";
import { registerDistillTool } from "./distill.js";
import { registerGuideTool } from "./guide.js";
import { registerInspectTool } from "./inspect.js";
import { registerListTool } from "./list.js";
import { registerMetaSetTool } from "./meta-set.js";
import { registerResetTool } from "./reset.js";
import { registerSourcesCheckTool } from "./sources-check.js";
import { registerSourcesHashTool } from "./sources-hash.js";
import { registerSourcesValidateTool } from "./sources-validate.js";
import { registerStartTool } from "./start.js";
import { registerValidateTool } from "./validate.js";

// Re-exported for external consumers that construct the deps object
// themselves (the root src/server.ts does this inline and doesn't need
// the import, but keeping the re-export preserves the API of
// `./tools/index.js` for anyone else).
export type { FreelanceToolDeps } from "./deps.js";

export function registerFreelanceTools(server: McpServer, deps: FreelanceToolDeps): void {
  registerListTool(server, deps);
  registerStartTool(server, deps);
  registerAdvanceTool(server, deps);
  registerContextSetTool(server, deps);
  registerInspectTool(server, deps);
  registerMetaSetTool(server, deps);
  registerResetTool(server, deps);
  registerGuideTool(server);
  registerDistillTool(server);
  registerSourcesHashTool(server, deps);
  registerSourcesCheckTool(server, deps);
  registerSourcesValidateTool(server, deps);
  registerValidateTool(server, deps);
}

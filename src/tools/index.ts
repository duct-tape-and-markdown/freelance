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
import type { SourceOptions } from "../sources.js";
import type { TraversalStore } from "../state/index.js";
import type { ValidatedGraph } from "../types.js";
import { registerAdvanceTool } from "./advance.js";
import { registerContextSetTool } from "./context-set.js";
import { registerDistillTool } from "./distill.js";
import { registerGuideTool } from "./guide.js";
import { registerInspectTool } from "./inspect.js";
import { registerListTool } from "./list.js";
import { registerResetTool } from "./reset.js";
import { registerSourcesCheckTool } from "./sources-check.js";
import { registerSourcesHashTool } from "./sources-hash.js";
import { registerSourcesValidateTool } from "./sources-validate.js";
import { registerStartTool } from "./start.js";
import { registerValidateTool } from "./validate.js";

/**
 * Dependency bundle passed to each tool's register function. Tools
 * destructure only what they need. Mutable fields (loadErrors) are
 * exposed as getters so tools always see the current value without
 * being re-registered when the watcher mutates state.
 */
export interface FreelanceToolDeps {
  manager: TraversalStore;
  graphs: Map<string, ValidatedGraph>;
  sourceOpts: SourceOptions;
  graphsDirs?: string[];
  validateSourcesOnStart?: boolean;
  getLoadErrors: () => Array<{ file: string; message: string }>;
}

export function registerFreelanceTools(server: McpServer, deps: FreelanceToolDeps): void {
  registerListTool(server, deps);
  registerStartTool(server, deps);
  registerAdvanceTool(server, deps);
  registerContextSetTool(server, deps);
  registerInspectTool(server, deps);
  registerResetTool(server, deps);
  registerGuideTool(server);
  registerDistillTool(server);
  registerSourcesHashTool(server, deps);
  registerSourcesCheckTool(server, deps);
  registerSourcesValidateTool(server, deps);
  registerValidateTool(server, deps);
}

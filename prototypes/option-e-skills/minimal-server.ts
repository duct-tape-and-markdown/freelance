/**
 * ILLUSTRATIVE — not wired up.
 *
 * What a Claude-Desktop-compatibility MCP server would look like in
 * option E — the fallback surface for clients that cannot shell out to
 * the CLI. The primary integration shape is the single skill + pure CLI
 * (see `./skills/freelance/SKILL.md` and `./README.md`); this file exists
 * because Claude Desktop and a small residual audience still reach
 * Freelance through MCP tools only.
 *
 * Two reasonable shapes for the fallback:
 *
 *   1. **Minimal entry + delegate-to-skill.** Register only `freelance_list`,
 *      `freelance_start`, `freelance_inspect`, `freelance_guide`. Everything
 *      else is guidance text telling the user "this client doesn't have shell
 *      access; use Claude Code or a shell-capable environment to run this
 *      workflow to completion." Honest about the constraint. Smallest surface.
 *
 *   2. **Full runtime surface** (today's shape, optimized per #81/#82/#86).
 *      Keep MCP peer-functional for Desktop-only use. Larger surface, ongoing
 *      maintenance tax, but preserves workflow-driveability for non-shell
 *      users.
 *
 * The shape (1) vs (2) call is what issue #99 decides. This file sketches (1)
 * because it's the minimal fallback; (2) is just today's `src/server.ts`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Runtime } from "../../src/compose.js";
import { composeRuntime } from "../../src/compose.js";
import { registerGuideTool } from "../../src/tools/guide.js";
import { registerInspectTool } from "../../src/tools/inspect.js";
import { registerListTool } from "../../src/tools/list.js";
import { registerStartTool } from "../../src/tools/start.js";
import type { ValidatedGraph } from "../../src/types.js";
import { VERSION } from "../../src/version.js";

export interface FallbackServerOptions {
  graphsDirs?: string[];
  stateDir?: string;
  sourceRoot?: string;
}

/**
 * The 4 tools on the minimal Claude-Desktop fallback surface. Everything
 * beyond discovery + start + inspect is missing here by design — the
 * assumption is that Desktop users reach this point, then switch to a
 * shell-capable client to complete the traversal. If that's too hostile
 * a UX, swap to shape (2) above — today's full surface.
 */
function registerDesktopFallbackTools(
  server: McpServer,
  deps: Parameters<typeof registerListTool>[1],
): void {
  registerListTool(server, deps);
  registerStartTool(server, deps);
  registerInspectTool(server, deps);
  registerGuideTool(server);
}

export function createFallbackServer(
  graphs: Map<string, ValidatedGraph>,
  options: FallbackServerOptions = {},
): { server: McpServer; runtime: Runtime } {
  const runtime = composeRuntime({
    graphs,
    graphsDir: options.graphsDirs?.[0],
    stateDir: options.stateDir ?? ":memory:",
    sourceRoot: options.sourceRoot,
  });

  const { store: manager, sourceOpts } = runtime;

  const server = new McpServer({ name: "freelance-fallback", version: VERSION });

  registerDesktopFallbackTools(server, {
    manager,
    graphs,
    sourceOpts,
    graphsDirs: options.graphsDirs,
    getLoadErrors: () => [],
  });

  return { server, runtime };
}

// Illustrative; lifecycle wiring (stdin watchdog, SIGINT handlers) matches
// the current `src/server.ts`. The skill + CLI path doesn't need a server
// at all — the CLI invokes `composeRuntime` per-call via `src/cli/setup.ts`.

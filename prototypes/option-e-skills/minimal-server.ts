/**
 * ILLUSTRATIVE — not wired up.
 *
 * What `src/server.ts` would look like in option E (skills-packaged workflows,
 * minimal MCP). Only discovery/recovery tools register on the MCP surface;
 * every runtime verb (advance, context_set, memory_*, etc.) is invoked by
 * the agent via Bash against the Freelance CLI, per the SKILL.md loaded on
 * activation.
 *
 * See `./README.md` for the architecture; see `./skills/*/SKILL.md` for the
 * invocation recipes the skills carry.
 *
 * Compared to the current `src/server.ts`, the diff is:
 *
 *   - `registerFreelanceTools(server, deps)` is replaced with a narrower
 *     `registerEntryTools(server, deps)` that registers only 4 tools.
 *   - `registerMemoryTools(server, memoryStore, ...)` is removed entirely.
 *     Memory write (`memory_emit`) and read (`browse`/`search`/…) move to
 *     CLI-only; the skill body teaches the agent to shell out.
 *   - The SkillsLoader is a new concept — scans a skills directory and
 *     confirms their presence at startup. Skills themselves are loaded by
 *     the Claude client based on the user's request, NOT by this server.
 *     This server only validates that the expected skills exist on disk.
 *
 * The CLI binary gains no new verbs; it already has parity with MCP. What
 * changes is which surface is primary for which operation, and the shape
 * of the CLI's output (see `./cli-shape.md`).
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

export interface MinimalServerOptions {
  graphsDirs?: string[];
  stateDir?: string;
  sourceRoot?: string;
  /**
   * Path to the directory containing SKILL.md files. Validated at startup
   * but not loaded — Claude activates skills based on user requests.
   */
  skillsDir?: string;
}

/**
 * The 4 tools that stay on the MCP surface in option E.
 *
 * Everything else — advance, context_set, meta_set, reset, memory_*,
 * sources_*, validate, distill — is CLI-invoked per the active skill's
 * SKILL.md body.
 */
function registerEntryTools(
  server: McpServer,
  deps: Parameters<typeof registerListTool>[1],
): void {
  registerListTool(server, deps);
  registerStartTool(server, deps);
  registerInspectTool(server, deps);
  registerGuideTool(server);
}

export function createMinimalServer(
  graphs: Map<string, ValidatedGraph>,
  options: MinimalServerOptions = {},
): { server: McpServer; runtime: Runtime } {
  const runtime = composeRuntime({
    graphs,
    graphsDir: options.graphsDirs?.[0],
    stateDir: options.stateDir ?? ":memory:",
    sourceRoot: options.sourceRoot,
  });

  const { store: manager, sourceOpts } = runtime;

  if (options.skillsDir) {
    validateSkillsDirectory(options.skillsDir);
  }

  const server = new McpServer({ name: "freelance-minimal", version: VERSION });

  registerEntryTools(server, {
    manager,
    graphs,
    sourceOpts,
    graphsDirs: options.graphsDirs,
    getLoadErrors: () => [],
  });

  return { server, runtime };
}

/**
 * Stub — the real version would scan skillsDir for the three expected
 * skills (freelance-memory-compile, freelance-memory-recall,
 * freelance-workflow-runner), verify their SKILL.md frontmatter, and log
 * a warning if any are missing. Not a blocker — skills missing from disk
 * simply mean the client won't auto-activate them; manual CLI invocation
 * still works.
 */
function validateSkillsDirectory(skillsDir: string): void {
  // TODO: scan skillsDir; parse SKILL.md frontmatter; warn on missing.
  void skillsDir;
}

// Illustrative; no `startServer` equivalent — that wiring (stdin watchdog,
// SIGINT handlers, etc.) is identical to the current `src/server.ts`.

// Shared CLI output helpers and global state.
import path from "node:path";
import { EngineError } from "../errors.js";

/**
 * Semantic exit codes. Consumed by the skill body (and any shell-driving
 * client) to branch on outcome without parsing stdout. Categorized by
 * "who can do something about this":
 *
 *   0 — success
 *   1 — internal (unexpected throw; agent should report to operator, not retry)
 *   2 — gate/edge blocked (advance couldn't complete given current state; fix context and retry)
 *   3 — validation failed (graph structural validation; authoring-time use)
 *   4 — not found (referenced traversal / graph / edge doesn't exist)
 *   5 — invalid input (caller-supplied arg is malformed or conflicts with state)
 *
 * The skill branches on these to decide whether to retry, surface the
 * error to the user, or stop the loop.
 */
export const EXIT = {
  SUCCESS: 0,
  INTERNAL: 1,
  BLOCKED: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
  INVALID_INPUT: 5,
  // Legacy aliases — kept so authoring commands (validate, init, visualize,
  // config) stay on their existing exit-code conventions without churn.
  // Runtime handlers use the semantic names above.
  GENERAL_ERROR: 1,
  INVALID_USAGE: 2,
  GRAPH_ERROR: 3,
} as const;

/**
 * Map an `EngineError.code` to its exit-code category. Runtime handlers
 * call this inside `catch` blocks. Unknown codes fall back to INTERNAL
 * so a novel error never masquerades as a caller-fixable one.
 */
export function mapEngineErrorToExit(code: string | undefined): number {
  if (!code) return EXIT.INTERNAL;
  switch (code) {
    // Not found
    case "TRAVERSAL_NOT_FOUND":
    case "GRAPH_NOT_FOUND":
    case "EDGE_NOT_FOUND":
    case "NO_TRAVERSAL":
      return EXIT.NOT_FOUND;
    // Invalid input (caller-provided)
    case "STRICT_CONTEXT_VIOLATION":
    case "CONTEXT_VALUE_TOO_LARGE":
    case "CONTEXT_TOTAL_TOO_LARGE":
    case "REQUIRED_META_MISSING":
    case "AMBIGUOUS_TRAVERSAL":
    case "TRAVERSAL_ACTIVE":
      return EXIT.INVALID_INPUT;
    // Runtime blocked (state / constraint)
    case "NO_EDGES":
    case "STACK_DEPTH_EXCEEDED":
    case "HOOK_FAILED":
    case "HOOK_IMPORT_FAILED":
    case "HOOK_BAD_SHAPE":
    case "HOOK_RESOLUTION_MISMATCH":
    case "HOOK_BUILTIN_MISSING":
    case "HOOK_BAD_RETURN":
      return EXIT.BLOCKED;
    default:
      return EXIT.INTERNAL;
  }
}

/**
 * Write a structured error to stdout and return the exit code the caller
 * should use. Shape mirrors the MCP tool-error payload:
 *   { isError: true, error: { code, message } }
 * so a skill consuming either surface sees the same shape. For unknown
 * throws (non-EngineError), `code` is `INTERNAL`.
 */
export function outputError(e: unknown): number {
  if (e instanceof EngineError) {
    process.stdout.write(
      `${JSON.stringify({ isError: true, error: { code: e.code, message: e.message } }, null, 2)}\n`,
    );
    return mapEngineErrorToExit(e.code);
  }
  const message = e instanceof Error ? e.message : String(e);
  process.stdout.write(
    `${JSON.stringify({ isError: true, error: { code: "INTERNAL", message } }, null, 2)}\n`,
  );
  return EXIT.INTERNAL;
}

// Global CLI state — set via setCli() from index.ts before any command runs.
// Exported as readonly; only setCli() can mutate it.
interface CliState {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
}

const _cli: CliState = {
  json: false,
  quiet: false,
  verbose: false,
  noColor: false,
};

export const cli: Readonly<CliState> = _cli;

/** Initialize CLI state from parsed commander options. */
export function setCli(opts: Partial<CliState>): void {
  if (opts.json !== undefined) _cli.json = opts.json;
  if (opts.quiet !== undefined) _cli.quiet = opts.quiet;
  if (opts.verbose !== undefined) _cli.verbose = opts.verbose;
  if (opts.noColor !== undefined) _cli.noColor = opts.noColor;
}

/** Write JSON to stdout. */
export function outputJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Write informational message to stderr (progress, success, etc). */
export function info(msg: string): void {
  if (!cli.quiet) {
    process.stderr.write(`${msg}\n`);
  }
}

/** Write verbose/debug message to stderr. Scaffolding — not yet wired up. */
export function debug(msg: string): void {
  if (cli.verbose && !cli.quiet) {
    process.stderr.write(`${msg}\n`);
  }
}

/** Write error to stderr (always prints, even with --quiet). */
export function error(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Write error to stderr and exit. */
export function fatal(msg: string, exitCode: number = EXIT.GENERAL_ERROR): never {
  error(`Error: ${msg}`);
  process.exit(exitCode);
}

/** Resolve the user's home directory. */
export function homeDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error("Could not determine home directory: neither HOME nor USERPROFILE is set");
  }
  return home;
}

/** Show a path relative to cwd when possible, absolute otherwise. */
export function displayPath(absPath: string): string {
  const rel = path.relative(process.cwd(), absPath);
  return rel.startsWith("..") ? absPath : rel;
}

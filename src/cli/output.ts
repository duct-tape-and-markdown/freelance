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
    case "INVALID_KEY_VALUE_PAIR":
    case "INVALID_CONTEXT_JSON":
    case "INVALID_EMIT_JSON":
    case "INVALID_META":
      return EXIT.INVALID_INPUT;
    // Runtime blocked (state / constraint) — advance couldn't proceed but
    // the traversal itself is intact; caller may recover with new context.
    case "NO_EDGES":
    case "STACK_DEPTH_EXCEEDED":
      return EXIT.BLOCKED;
    // Hook wiring failures are author-time bugs (missing export, bad
    // shape, import error). Retrying with new context won't repair a
    // broken hook script, so surface as INTERNAL — the skill should
    // report to the operator, not loop.
    case "HOOK_FAILED":
    case "HOOK_IMPORT_FAILED":
    case "HOOK_BAD_SHAPE":
    case "HOOK_RESOLUTION_MISMATCH":
    case "HOOK_BUILTIN_MISSING":
    case "HOOK_BAD_RETURN":
      return EXIT.INTERNAL;
    default:
      return EXIT.INTERNAL;
  }
}

/**
 * Write a structured error to stdout and return the exit code. Payload is
 *   { isError: true, error: { code, message } }
 * — `isError` at the top level so a shell consumer can one-pass-parse
 * without checking exit codes, and `error.code` is what
 * `mapEngineErrorToExit` branches on. For unknown throws (non-EngineError),
 * `code` is `INTERNAL`.
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

/**
 * Shared try/catch tail for runtime CLI handlers — emits the structured
 * error payload via `outputError` and exits with the mapped code.
 * Consolidates the identical `catch { outputError(e); process.exit(…) }`
 * shape that lived in traversals.ts / memory.ts / stateless.ts.
 *
 * Re-throws if `e` is the "process.exit" sentinel that tests install in
 * place of `process.exit`. Otherwise a `fatal()` call nested inside a
 * try/catch would double-emit (fatal writes the structured payload and
 * calls process.exit; the mocked throw reaches this catch, which would
 * emit a second INTERNAL payload and mask the original).
 */
export function handleRuntimeError(e: unknown): never {
  if (e instanceof Error && e.message === "process.exit") throw e;
  process.exit(outputError(e));
}

// Global CLI state — set via setCli() from program.ts before any
// command runs. `json` and `noColor` are gone post docs/decisions.md §
// CLI-primary: handlers are JSON-only (no dual-mode) and color has no
// meaning on machine output. `quiet` and `verbose` still gate stderr
// breadcrumbs via info()/debug().
interface CliState {
  quiet: boolean;
  verbose: boolean;
}

const _cli: CliState = {
  quiet: false,
  verbose: false,
};

export const cli: Readonly<CliState> = _cli;

/** Initialize CLI state from parsed commander options. */
export function setCli(opts: Partial<CliState>): void {
  if (opts.quiet !== undefined) _cli.quiet = opts.quiet;
  if (opts.verbose !== undefined) _cli.verbose = opts.verbose;
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

/**
 * Emit a structured fatal error to stdout and exit with the given code.
 * Shape matches `outputError`: `{ isError: true, error: { code, message } }`.
 * Callers pass an exit code that categorizes the failure (see EXIT);
 * `code` defaults to "FATAL" and can be overridden for specificity.
 */
export function fatal(
  msg: string,
  exitCode: number = EXIT.INTERNAL,
  code: string = "FATAL",
): never {
  process.stdout.write(
    `${JSON.stringify({ isError: true, error: { code, message: msg } }, null, 2)}\n`,
  );
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

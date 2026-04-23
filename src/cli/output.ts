// Shared CLI output helpers and global state.
import path from "node:path";
import {
  EC,
  ENGINE_ERROR_CODES,
  type EngineErrorCategory,
  type EngineErrorCode,
  errorKind,
  RECOVERY,
  type RecoveryKind,
} from "../error-codes.js";
import { EngineError } from "../errors.js";

/**
 * Parse a repeated `parseInt(opts.foo, 10)` pattern into a single call-site
 * shape. Returns `undefined` for `undefined`/empty input (commander emits
 * `undefined` when the flag is absent). Throws `INVALID_FLAG_VALUE` when
 * the value isn't a finite integer, so typos like `--limit abc` fail
 * loudly at the CLI boundary instead of silently becoming `NaN`.
 */
export function parseIntArg(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new EngineError(`${flag} must be an integer; got "${raw}".`, EC.INVALID_FLAG_VALUE);
  }
  return parsed;
}

/**
 * Shared primitive for CLI flags that accept `key=value` pairs. Splits on
 * the first `=`, validates a non-empty key, and throws with a consistent
 * error message across `--meta`, `--filter`, and `context set`. Callers
 * layer their own value handling on top (string-only for meta, JSON-
 * coerced for context).
 */
export function splitKeyValue(pair: string, flag: string): [string, string] {
  const eqIdx = pair.indexOf("=");
  if (eqIdx === -1) {
    throw new EngineError(
      `${flag} requires key=value pairs; got "${pair}"`,
      EC.INVALID_KEY_VALUE_PAIR,
    );
  }
  const key = pair.slice(0, eqIdx);
  if (!key) {
    throw new EngineError(`${flag} key is empty in "${pair}"`, EC.INVALID_KEY_VALUE_PAIR);
  }
  return [key, pair.slice(eqIdx + 1)];
}

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
 */
export const EXIT = {
  SUCCESS: 0,
  INTERNAL: 1,
  BLOCKED: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
  INVALID_INPUT: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

// Exit code each `EngineError` category maps to. Typed on
// `EngineErrorCategory` so adding a new category to `ENGINE_ERROR_CODES`
// becomes a compile error here until it's classified — the mapping
// can't drift from the catalog.
const CATEGORY_EXIT: { readonly [K in EngineErrorCategory]: number } = {
  NOT_FOUND: EXIT.NOT_FOUND,
  INVALID_INPUT: EXIT.INVALID_INPUT,
  BLOCKED: EXIT.BLOCKED,
  INTERNAL_HOOK: EXIT.INTERNAL,
  CLI_INVALID_INPUT: EXIT.INVALID_INPUT,
  CLI_NOT_FOUND: EXIT.NOT_FOUND,
  CLI_STRUCTURAL: EXIT.INTERNAL,
  GRAPH_VALIDATION: EXIT.VALIDATION,
};

const CODE_TO_EXIT: ReadonlyMap<EngineErrorCode, number> = new Map(
  (Object.keys(ENGINE_ERROR_CODES) as EngineErrorCategory[]).flatMap((cat) =>
    ENGINE_ERROR_CODES[cat].map((code) => [code, CATEGORY_EXIT[cat]] as const),
  ),
);

/**
 * Map an `EngineError.code` to its exit-code category. Unknown codes
 * fall back to INTERNAL so a novel error never masquerades as a
 * caller-fixable one — only relevant if a consumer constructs an
 * `EngineError` with a cast, since the type system rules it out.
 */
export function mapEngineErrorToExit(code: EngineErrorCode): number {
  return CODE_TO_EXIT.get(code) ?? EXIT.INTERNAL;
}

/**
 * Write a structured error to stdout and return the exit code. Base
 * payload is
 *   {
 *     isError: true,
 *     error: { code, message, kind, recoveryVerb, recoveryKind },
 *     ...envelopeSlots
 *   }
 * Two `EngineError.context` subfields spread to different targets:
 *   - `context.hook` → nested under `envelope.error.hook` (hook
 *     identity on HOOK_* throws, PR D).
 *   - `context.envelopeSlots` → spread at envelope root (e.g.
 *     CONFIRM_REQUIRED carries `commandName`, AMBIGUOUS_TRAVERSAL
 *     carries `candidates`; HOOK_FAILED carries `currentNode`,
 *     `validTransitions`, `context` / `contextDelta` for gate-block
 *     envelope parity). The `recoveryVerb` template in
 *     `RECOVERY[code]` interpolates against these root fields, so
 *     they live next to the envelope's other top-level fields, not
 *     buried under `error.*`.
 *
 * For unknown throws (non-EngineError), `code` is `INTERNAL`.
 */
export function outputError(e: unknown): number {
  if (e instanceof EngineError) {
    const envelope: Record<string, unknown> = errorEnvelope(e.code, e.message);
    if (e.context?.hook) {
      (envelope.error as Record<string, unknown>).hook = e.context.hook;
    }
    if (e.context?.envelopeSlots) {
      Object.assign(envelope, e.context.envelopeSlots);
    }
    outputJson(envelope);
    return mapEngineErrorToExit(e.code);
  }
  const message = e instanceof Error ? e.message : String(e);
  outputJson(errorEnvelope(EC.INTERNAL, message));
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

/**
 * Throw from a CLI handler when the response is a structured payload
 * + a specific exit code — not a simple error envelope. Examples:
 * `memory prune --confirm`-less refusal (plan + errorEnvelope
 * combined), `traversal advance` in-band BLOCKED (full advance result
 * with validTransitions). `runCliHandler` / `runCliHandlerAsync` catch
 * this, close the disposable, write the payload, and exit with the
 * code.
 *
 * Single-envelope failures use `EngineError` + `handleRuntimeError`
 * instead — this class is only for the dual-payload cases that
 * `outputError`'s `errorEnvelope(code, message)` shape can't express.
 */
export class CliExit extends Error {
  constructor(
    public readonly payload: unknown,
    public readonly exitCode: ExitCode,
  ) {
    super("CliExit");
    this.name = "CliExit";
  }
}

/**
 * Wrap a CLI handler whose resources need closing before
 * `handleRuntimeError` / `CliExit` exit the process. `process.exit`
 * doesn't unwind `finally`, so an outer `try { fn() } finally {
 * disposable.close() }` never runs on error — the sidecars leak.
 *
 * `disposable` is anything with `close(): void` (MemoryStore,
 * Runtime, TraversalStore — all already idempotent). The wrapper
 * closes on success, on thrown errors, and on `CliExit` — all before
 * `process.exit`, so callers of `runCliHandler` can drop the surrounding
 * try/finally in `program.ts`.
 */
export function runCliHandler(disposable: { close(): void }, fn: () => void): void {
  try {
    fn();
    disposable.close();
  } catch (e) {
    disposable.close();
    if (e instanceof CliExit) {
      outputJson(e.payload);
      process.exit(e.exitCode);
    }
    handleRuntimeError(e);
  }
}

/** Async variant of `runCliHandler` for `traversalStart` / `traversalAdvance` etc. */
export async function runCliHandlerAsync(
  disposable: { close(): void },
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    disposable.close();
  } catch (e) {
    disposable.close();
    if (e instanceof CliExit) {
      outputJson(e.payload);
      process.exit(e.exitCode);
    }
    handleRuntimeError(e);
  }
}

/**
 * Build the unified error envelope as a plain object (no stdout write,
 * no exit). Used by CLI handlers that need to `outputJson` a payload
 * augmented with the envelope — e.g. `memory prune` returns the prune
 * plan alongside `isError: true` so the caller sees the blast radius
 * and the refusal in one response.
 *
 * Every envelope carries `recoveryVerb` (literal CLI template the
 * driving skill renders after interpolating root-level
 * `envelopeSlots`) and `recoveryKind` (the classifier the skill
 * branches on) sourced from `RECOVERY[code]` — per-code recovery is
 * catalog-owned, not per-throw-site prose.
 *
 * `code` is typed as `EngineErrorCode` so every caller picks from the
 * catalog — typos and uncatalogued strings fail at compile time.
 */
export function errorEnvelope(
  code: EngineErrorCode,
  message: string,
): {
  isError: true;
  error: {
    code: EngineErrorCode;
    message: string;
    kind: ReturnType<typeof errorKind>;
    recoveryVerb: string | null;
    recoveryKind: RecoveryKind;
  };
} {
  const recovery = RECOVERY[code];
  return {
    isError: true,
    error: {
      code,
      message,
      kind: errorKind(code),
      recoveryVerb: recovery.verb,
      recoveryKind: recovery.kind,
    },
  };
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
 * Shape matches `outputError`: `{ isError: true, error: { code,
 * message, kind } }`. Callers pass an exit code that categorizes the
 * failure (see EXIT) and a `code` from the engine catalog — no default,
 * so every call site picks a specific code (the previous `"FATAL"`
 * default hid novel failures behind a generic string). `kind` is
 * derived via `errorKind` — any `fatal()`-produced error whose code
 * isn't in `ENGINE_ERROR_CODES.BLOCKED` falls through to
 * `"structural"`, which is the right default for authoring-time and
 * setup failures.
 */
export function fatal(msg: string, exitCode: number, code: EngineErrorCode): never {
  outputJson(errorEnvelope(code, msg));
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

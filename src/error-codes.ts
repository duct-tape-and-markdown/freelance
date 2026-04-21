/**
 * Canonical catalog of every `EngineError.code` the runtime emits.
 *
 * Codes are grouped by the exit-code category `mapEngineErrorToExit`
 * maps them to — the grouping is the source of truth, so the CLI's
 * exit mapping is derived from this file rather than hand-curated
 * alongside the throw sites. Adding a new code is a single-file edit
 * that compiles everywhere or fails everywhere.
 *
 * Value stability: the string literal values are the wire format the
 * CLI emits on stdout (`error.code`). External consumers branch on
 * them; never rename a value. Adding new codes (into the right group)
 * is always safe.
 */

/**
 * Codes emitted in-band from the engine's `advance` return (see
 * `AdvanceErrorResult` in `types.ts` + `src/engine/gates.ts`) — not
 * thrown. Exported as its own tuple so `AdvanceErrorResult.error.code`
 * can be typed directly from the catalog instead of restating the
 * union; all four are also merged into `ENGINE_ERROR_CODES.BLOCKED`
 * below so they share exit mapping + `kind` classification with
 * thrown BLOCKED-category codes (NO_EDGES, STACK_DEPTH_EXCEEDED).
 */
export const GATE_BLOCK_CODES = [
  "WAIT_BLOCKING",
  "RETURN_SCHEMA_VIOLATION",
  "VALIDATION_FAILED",
  "EDGE_CONDITION_NOT_MET",
] as const;

export type GateBlockCode = (typeof GATE_BLOCK_CODES)[number];

export const ENGINE_ERROR_CODES = {
  NOT_FOUND: ["TRAVERSAL_NOT_FOUND", "GRAPH_NOT_FOUND", "EDGE_NOT_FOUND", "NO_TRAVERSAL"],
  INVALID_INPUT: [
    "STRICT_CONTEXT_VIOLATION",
    "CONTEXT_VALUE_TOO_LARGE",
    "CONTEXT_TOTAL_TOO_LARGE",
    "REQUIRED_META_MISSING",
    "AMBIGUOUS_TRAVERSAL",
    "TRAVERSAL_ACTIVE",
    // Optimistic-concurrency conflict: another writer updated the
    // record between our load and save. Transient — caller should
    // re-read the traversal and retry. Classified as INVALID_INPUT
    // because the caller's implicit precondition ("state hasn't
    // changed since I read it") was violated; semantically retriable
    // without operator intervention.
    "TRAVERSAL_CONFLICT",
    "INVALID_KEY_VALUE_PAIR",
    "INVALID_CONTEXT_JSON",
    "INVALID_EMIT_JSON",
    "INVALID_META",
    "INVALID_SHAPE",
    "INVALID_FLAG_VALUE",
  ],
  BLOCKED: ["NO_EDGES", "STACK_DEPTH_EXCEEDED", ...GATE_BLOCK_CODES],
  // Hook wiring failures (missing export, bad shape, import error,
  // timeout). Retrying with new context won't repair a broken hook
  // script — surface as INTERNAL so the skill reports instead of loops.
  INTERNAL_HOOK: [
    "HOOK_FAILED",
    "HOOK_IMPORT_FAILED",
    "HOOK_BAD_SHAPE",
    "HOOK_RESOLUTION_MISMATCH",
    "HOOK_BUILTIN_MISSING",
    "HOOK_BAD_RETURN",
  ],
} as const;

export type EngineErrorCategory = keyof typeof ENGINE_ERROR_CODES;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[EngineErrorCategory][number];

/**
 * Wire-level discriminator carried on every CLI error envelope. A
 * two-way split distinct from (and derived from) `EngineErrorCategory`:
 *
 *   - `"blocked"` — the traversal is fine; the caller's last
 *     operation can't proceed given current state. Fix context and
 *     retry the same edge.
 *   - `"structural"` — something structural is wrong (missing graph,
 *     unknown edge, strict-context violation, broken hook). Retry
 *     won't help; report to the operator.
 *
 * BLOCKED-category codes map to `"blocked"`; every other category
 * maps to `"structural"`. Exit codes still encode more fine-grained
 * actionability (NOT_FOUND vs INVALID_INPUT vs BLOCKED vs INTERNAL);
 * `errorKind` is the one the driving skill branches on before it
 * picks recover-or-stop.
 */
export type ErrorKind = "blocked" | "structural";

const BLOCKED_CODES: ReadonlySet<string> = new Set<string>(ENGINE_ERROR_CODES.BLOCKED);

/**
 * Classify an error code as `"blocked"` or `"structural"`. Unknown
 * codes (e.g. CLI-surface codes like `INVALID_CONFIG_VALUE`,
 * `CONFIRM_REQUIRED`, `TEMPLATE_NOT_FOUND`, or an uncatalogued throw)
 * are treated as structural — the default "stop and report" stance.
 */
export function errorKind(code: string): ErrorKind {
  return BLOCKED_CODES.has(code) ? "blocked" : "structural";
}

/**
 * Symbol aliases for every code — throw sites use `EC.FOO` so
 * go-to-definition and find-references resolve through the TS symbol
 * instead of text-matching a string literal.
 */
export const EC = {
  TRAVERSAL_NOT_FOUND: "TRAVERSAL_NOT_FOUND",
  GRAPH_NOT_FOUND: "GRAPH_NOT_FOUND",
  EDGE_NOT_FOUND: "EDGE_NOT_FOUND",
  NO_TRAVERSAL: "NO_TRAVERSAL",
  STRICT_CONTEXT_VIOLATION: "STRICT_CONTEXT_VIOLATION",
  CONTEXT_VALUE_TOO_LARGE: "CONTEXT_VALUE_TOO_LARGE",
  CONTEXT_TOTAL_TOO_LARGE: "CONTEXT_TOTAL_TOO_LARGE",
  REQUIRED_META_MISSING: "REQUIRED_META_MISSING",
  AMBIGUOUS_TRAVERSAL: "AMBIGUOUS_TRAVERSAL",
  TRAVERSAL_ACTIVE: "TRAVERSAL_ACTIVE",
  TRAVERSAL_CONFLICT: "TRAVERSAL_CONFLICT",
  INVALID_KEY_VALUE_PAIR: "INVALID_KEY_VALUE_PAIR",
  INVALID_CONTEXT_JSON: "INVALID_CONTEXT_JSON",
  INVALID_EMIT_JSON: "INVALID_EMIT_JSON",
  INVALID_META: "INVALID_META",
  INVALID_SHAPE: "INVALID_SHAPE",
  INVALID_FLAG_VALUE: "INVALID_FLAG_VALUE",
  NO_EDGES: "NO_EDGES",
  STACK_DEPTH_EXCEEDED: "STACK_DEPTH_EXCEEDED",
  WAIT_BLOCKING: "WAIT_BLOCKING",
  RETURN_SCHEMA_VIOLATION: "RETURN_SCHEMA_VIOLATION",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  EDGE_CONDITION_NOT_MET: "EDGE_CONDITION_NOT_MET",
  HOOK_FAILED: "HOOK_FAILED",
  HOOK_IMPORT_FAILED: "HOOK_IMPORT_FAILED",
  HOOK_BAD_SHAPE: "HOOK_BAD_SHAPE",
  HOOK_RESOLUTION_MISMATCH: "HOOK_RESOLUTION_MISMATCH",
  HOOK_BUILTIN_MISSING: "HOOK_BUILTIN_MISSING",
  HOOK_BAD_RETURN: "HOOK_BAD_RETURN",
} as const satisfies { readonly [K in EngineErrorCode]: K };

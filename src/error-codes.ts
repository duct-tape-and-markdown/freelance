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
  BLOCKED: ["NO_EDGES", "STACK_DEPTH_EXCEEDED", "DATABASE_BUSY", ...GATE_BLOCK_CODES],
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
  // CLI-surface malformed input: missing project, invalid config
  // value, unresolvable prune ref, source outside root, memory
  // disabled when required. Shares exit 5 with INVALID_INPUT — the
  // operator's shell invocation is wrong, not the engine state.
  CLI_INVALID_INPUT: [
    "NO_FREELANCE_DIR",
    "INVALID_CONFIG_VALUE",
    "UNKNOWN_CONFIG_KEY",
    "INVALID_SOURCE_FORMAT",
    "INVALID_EXTENSION",
    "UNKNOWN_SHELL",
    "CONFIRM_REQUIRED",
    "MISSING_KEEP",
    "PRUNE_NOT_GIT_CHECKOUT",
    "PRUNE_UNRESOLVABLE_REF",
    "SOURCE_OUTSIDE_ROOT",
    "MEMORY_DISABLED",
    "MEMORY_UNRESOLVED_SOURCE_ROOT",
  ],
  // CLI-surface missing-target: topic / graph dir / file / entity
  // the operator referenced doesn't resolve. Shares exit 4 with
  // engine NOT_FOUND.
  CLI_NOT_FOUND: [
    "TOPIC_NOT_FOUND",
    "NO_GRAPHS_DIR",
    "NO_GRAPHS_LOADED",
    "FILE_NOT_FOUND",
    "COMPLETION_NOT_FOUND",
    "ENTITY_NOT_FOUND",
    "TEMPLATE_NOT_FOUND",
  ],
  // CLI-surface structural failure: graph load, internal invariant,
  // source file unreadable, missing optional peer dep. Maps to exit 1
  // like engine internal errors — not operator-fixable via retry,
  // report-and-stop.
  CLI_STRUCTURAL: [
    "GRAPH_LOAD_FAILED",
    "INTERNAL",
    "FATAL",
    "SOURCE_FILE_UNREADABLE",
    "MISSING_OPTIONAL_DEP",
  ],
  // Authoring-time graph validation failure. Exit 3 is reserved for
  // these so CI pipelines and `freelance validate` can branch on
  // "graph is malformed" distinct from runtime failures.
  GRAPH_VALIDATION: ["GRAPH_STRUCTURE_INVALID"],
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
  DATABASE_BUSY: "DATABASE_BUSY",
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
  NO_FREELANCE_DIR: "NO_FREELANCE_DIR",
  INVALID_CONFIG_VALUE: "INVALID_CONFIG_VALUE",
  UNKNOWN_CONFIG_KEY: "UNKNOWN_CONFIG_KEY",
  INVALID_SOURCE_FORMAT: "INVALID_SOURCE_FORMAT",
  INVALID_EXTENSION: "INVALID_EXTENSION",
  UNKNOWN_SHELL: "UNKNOWN_SHELL",
  CONFIRM_REQUIRED: "CONFIRM_REQUIRED",
  MISSING_KEEP: "MISSING_KEEP",
  PRUNE_NOT_GIT_CHECKOUT: "PRUNE_NOT_GIT_CHECKOUT",
  PRUNE_UNRESOLVABLE_REF: "PRUNE_UNRESOLVABLE_REF",
  SOURCE_OUTSIDE_ROOT: "SOURCE_OUTSIDE_ROOT",
  MEMORY_DISABLED: "MEMORY_DISABLED",
  MEMORY_UNRESOLVED_SOURCE_ROOT: "MEMORY_UNRESOLVED_SOURCE_ROOT",
  TOPIC_NOT_FOUND: "TOPIC_NOT_FOUND",
  NO_GRAPHS_DIR: "NO_GRAPHS_DIR",
  NO_GRAPHS_LOADED: "NO_GRAPHS_LOADED",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  COMPLETION_NOT_FOUND: "COMPLETION_NOT_FOUND",
  ENTITY_NOT_FOUND: "ENTITY_NOT_FOUND",
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  GRAPH_LOAD_FAILED: "GRAPH_LOAD_FAILED",
  INTERNAL: "INTERNAL",
  FATAL: "FATAL",
  SOURCE_FILE_UNREADABLE: "SOURCE_FILE_UNREADABLE",
  MISSING_OPTIONAL_DEP: "MISSING_OPTIONAL_DEP",
  GRAPH_STRUCTURE_INVALID: "GRAPH_STRUCTURE_INVALID",
} as const satisfies { readonly [K in EngineErrorCode]: K };

/**
 * Structured hook identification carried on `EngineError.context.hook`
 * when a hook execution fails. The CLI envelope spreads this into
 * `error.hook` so the driving skill can point the operator at the
 * exact hook call site (`name` + `nodeId`, plus `index` to
 * disambiguate repeated calls on the same node).
 *
 * Defined here (not in `engine/hooks.ts`) because the CLI output
 * layer spreads it into the envelope — keeping the type adjacent to
 * `EngineErrorCode` avoids an engine → cli dependency for a plain
 * data contract. PR D wires the engine to populate it on HOOK_*
 * throws; PR B defines the shape and the envelope plumbing.
 */
export interface HookErrorContext {
  name: string;
  nodeId: string;
  index: number;
}

/**
 * Flat tuple of every known code, for Zod's `z.enum` in the
 * envelope-contract test. Derived from `ENGINE_ERROR_CODES` so it
 * stays in lockstep with the catalog.
 */
export const ALL_ENGINE_ERROR_CODES = (
  Object.keys(ENGINE_ERROR_CODES) as EngineErrorCategory[]
).flatMap((cat) => [...ENGINE_ERROR_CODES[cat]]) as [EngineErrorCode, ...EngineErrorCode[]];

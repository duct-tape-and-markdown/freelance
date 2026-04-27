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
  NOT_FOUND: [
    "TRAVERSAL_NOT_FOUND",
    "GRAPH_NOT_FOUND",
    // Runtime orphan: traversal record exists but its graph yaml is
    // missing/renamed/failed to parse. Distinct from GRAPH_NOT_FOUND
    // (which fires on `start <typo>` where there's no stale state to
    // clear) so the recovery verb can be `reset {traversalId} --confirm`
    // instead of null. See traversal-store.ts loadEngine.
    "TRAVERSAL_ORPHANED",
    "EDGE_NOT_FOUND",
    "NO_TRAVERSAL",
  ],
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
    "INVALID_EMIT_SHAPE",
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
 * `TEMPLATE_NOT_FOUND`, or an uncatalogued throw) are treated as
 * structural — the default "stop and report" stance.
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
  TRAVERSAL_ORPHANED: "TRAVERSAL_ORPHANED",
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
  INVALID_EMIT_SHAPE: "INVALID_EMIT_SHAPE",
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

/**
 * Classifier the driving skill branches on to pick its recovery
 * strategy without re-parsing the error message:
 *
 *   - `"retry"` — transient (lock contention, optimistic-concurrency
 *     conflict). Same call site should succeed on a fresh read.
 *   - `"fix-context"` — operator-fixable: edit context / pick a
 *     candidate / re-run with a flag, then execute `recoveryVerb`.
 *   - `"report"` — structural bug or missing external resource the
 *     skill can't fix programmatically. Surface to the operator and
 *     stop.
 *   - `"clear"` — stale reference (deleted traversal, deleted graph).
 *     Drop the stale pointer and resume from a fresh starting state.
 */
export type RecoveryKind = "retry" | "fix-context" | "report" | "clear";

/**
 * Per-code recovery instruction. `verb` is a literal CLI template;
 * `{camelCase}` slots interpolate against top-level envelope fields
 * (see `EngineErrorContext.envelopeSlots`). `null` means "no verb
 * recovers this" — skill reports and stops.
 *
 * Values authored alongside the catalog as a sidecar rather than
 * restructuring `ENGINE_ERROR_CODES` itself — the flat category →
 * code[] shape is load-bearing across `mapEngineErrorToExit`,
 * `BLOCKED_CODES`, and `ALL_ENGINE_ERROR_CODES`, and a `satisfies`
 * check below gives identical exhaustiveness at zero ripple cost.
 */
export interface Recovery {
  readonly verb: string | null;
  readonly kind: RecoveryKind;
}

/**
 * Recovery instruction for every `EngineErrorCode`. Missing code →
 * compile error via the `satisfies` clause; same source-of-truth
 * guarantee as embedding the fields inside `ENGINE_ERROR_CODES`
 * entries, without the downstream ripple.
 *
 * Slot convention: `{camelCase}` slot names match envelope root
 * fields carried via `EngineErrorContext.envelopeSlots` at throw
 * time — e.g. CONFIRM_REQUIRED carries `commandName`, so the verb
 * template `{commandName} --confirm` interpolates against the
 * `commandName` value the throw site attached. No casing
 * translation; template key === envelope key === throw-site key.
 */
export const RECOVERY = {
  // NOT_FOUND — stale pointer, clear and continue
  TRAVERSAL_NOT_FOUND: { verb: null, kind: "clear" },
  GRAPH_NOT_FOUND: { verb: null, kind: "clear" },
  TRAVERSAL_ORPHANED: { verb: "reset {traversalId} --confirm", kind: "clear" },
  EDGE_NOT_FOUND: { verb: null, kind: "clear" },
  NO_TRAVERSAL: { verb: "start {graphId}", kind: "fix-context" },

  // INVALID_INPUT — caller context is wrong
  STRICT_CONTEXT_VIOLATION: { verb: "advance", kind: "fix-context" },
  CONTEXT_VALUE_TOO_LARGE: { verb: "advance", kind: "fix-context" },
  CONTEXT_TOTAL_TOO_LARGE: { verb: "advance", kind: "fix-context" },
  REQUIRED_META_MISSING: { verb: "advance", kind: "fix-context" },
  AMBIGUOUS_TRAVERSAL: { verb: "advance --traversal {traversalId}", kind: "fix-context" },
  TRAVERSAL_ACTIVE: { verb: "advance --traversal {traversalId}", kind: "fix-context" },
  TRAVERSAL_CONFLICT: { verb: "advance", kind: "retry" },
  INVALID_KEY_VALUE_PAIR: { verb: "advance", kind: "fix-context" },
  INVALID_CONTEXT_JSON: { verb: "advance", kind: "fix-context" },
  INVALID_EMIT_JSON: { verb: "memory emit", kind: "fix-context" },
  INVALID_EMIT_SHAPE: { verb: "memory emit", kind: "fix-context" },
  INVALID_META: { verb: "advance", kind: "fix-context" },
  INVALID_SHAPE: { verb: "advance", kind: "fix-context" },
  INVALID_FLAG_VALUE: { verb: null, kind: "fix-context" },

  // BLOCKED — traversal state fine, fix context and re-advance
  NO_EDGES: { verb: "advance", kind: "fix-context" },
  STACK_DEPTH_EXCEEDED: { verb: null, kind: "report" },
  DATABASE_BUSY: { verb: "advance", kind: "retry" },
  WAIT_BLOCKING: { verb: "advance", kind: "fix-context" },
  RETURN_SCHEMA_VIOLATION: { verb: "advance", kind: "fix-context" },
  VALIDATION_FAILED: { verb: "advance", kind: "fix-context" },
  EDGE_CONDITION_NOT_MET: { verb: "advance", kind: "fix-context" },

  // INTERNAL_HOOK — hook misbehavior, transition committed
  HOOK_FAILED: { verb: "advance", kind: "fix-context" },
  HOOK_IMPORT_FAILED: { verb: "advance", kind: "fix-context" },
  HOOK_BAD_SHAPE: { verb: "advance", kind: "fix-context" },
  HOOK_RESOLUTION_MISMATCH: { verb: null, kind: "report" },
  HOOK_BUILTIN_MISSING: { verb: "advance", kind: "fix-context" },
  HOOK_BAD_RETURN: { verb: "advance", kind: "fix-context" },

  // CLI_INVALID_INPUT — shell invocation malformed
  NO_FREELANCE_DIR: { verb: null, kind: "fix-context" },
  INVALID_CONFIG_VALUE: { verb: null, kind: "fix-context" },
  UNKNOWN_CONFIG_KEY: { verb: null, kind: "fix-context" },
  INVALID_SOURCE_FORMAT: { verb: null, kind: "fix-context" },
  INVALID_EXTENSION: { verb: null, kind: "fix-context" },
  UNKNOWN_SHELL: { verb: null, kind: "fix-context" },
  CONFIRM_REQUIRED: { verb: "{commandName} --confirm", kind: "fix-context" },
  MISSING_KEEP: { verb: null, kind: "fix-context" },
  PRUNE_NOT_GIT_CHECKOUT: { verb: null, kind: "report" },
  PRUNE_UNRESOLVABLE_REF: { verb: null, kind: "fix-context" },
  SOURCE_OUTSIDE_ROOT: { verb: null, kind: "fix-context" },
  MEMORY_DISABLED: { verb: null, kind: "fix-context" },
  MEMORY_UNRESOLVED_SOURCE_ROOT: { verb: null, kind: "fix-context" },

  // CLI_NOT_FOUND — operator referenced non-existent target
  TOPIC_NOT_FOUND: { verb: null, kind: "report" },
  NO_GRAPHS_DIR: { verb: null, kind: "report" },
  NO_GRAPHS_LOADED: { verb: null, kind: "report" },
  FILE_NOT_FOUND: { verb: null, kind: "report" },
  COMPLETION_NOT_FOUND: { verb: null, kind: "report" },
  ENTITY_NOT_FOUND: { verb: null, kind: "clear" },
  TEMPLATE_NOT_FOUND: { verb: null, kind: "report" },

  // CLI_STRUCTURAL — internal/env failure, no operator fix
  GRAPH_LOAD_FAILED: { verb: null, kind: "report" },
  INTERNAL: { verb: null, kind: "report" },
  FATAL: { verb: null, kind: "report" },
  SOURCE_FILE_UNREADABLE: { verb: null, kind: "report" },
  MISSING_OPTIONAL_DEP: { verb: null, kind: "report" },

  // GRAPH_VALIDATION — authoring-time, operator fixes yaml
  GRAPH_STRUCTURE_INVALID: { verb: "validate {graphDir}", kind: "report" },
} as const satisfies { readonly [K in EngineErrorCode]: Recovery };

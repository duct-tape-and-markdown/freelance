import type { EngineErrorCode, HookErrorContext } from "./error-codes.js";

export { EC, type EngineErrorCode } from "./error-codes.js";

/**
 * Optional structured context attached to an `EngineError`. Two
 * subfields, distinguished by where the CLI envelope spreads them:
 *
 *   - `hook` — nested under `envelope.error.hook`. PR D populates it
 *     on HOOK_* throws with the hook's identity (name, nodeId,
 *     index) so the driving skill can point the operator at the
 *     exact broken hook.
 *   - `envelopeSlots` — spread at `envelope` root (same level as
 *     `isError`, `error`). Carries the top-level fields a
 *     `recoveryVerb` template interpolates against (e.g.
 *     CONFIRM_REQUIRED carries `commandName`, AMBIGUOUS_TRAVERSAL
 *     carries `candidates`). PR D populates `currentNode` /
 *     `validTransitions` / `context` / `contextDelta` here on
 *     HOOK_FAILED for gate-block envelope parity — caller is in
 *     the same recover-or-stop state, wire shape must not differ
 *     by code path. Values are `unknown` so throw sites don't
 *     fight the type system for structured payloads — `outputError`
 *     is the only consumer and it spreads directly.
 *
 * Open-ended — add a new subfield when a fourth spread target (e.g.
 * a future `breadcrumb` field) emerges. Don't widen `envelopeSlots`
 * to cover the hook payload; keeping the nested-vs-root distinction
 * explicit matches what the skill branches on.
 */
export interface EngineErrorContext {
  hook?: HookErrorContext;
  envelopeSlots?: Record<string, unknown>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    public code: EngineErrorCode,
    public context?: EngineErrorContext,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

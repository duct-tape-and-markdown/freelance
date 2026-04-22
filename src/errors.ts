import type { EngineErrorCode, HookErrorContext } from "./error-codes.js";

export { EC, type EngineErrorCode } from "./error-codes.js";

/**
 * Optional structured context attached to an `EngineError`. Currently
 * only `hook` is defined (populated by PR D when a hook throws) — the
 * CLI output layer spreads matching keys into the envelope so
 * downstream consumers get `error.hook` without introspecting
 * `context`. Open-ended to leave room for future structured fields
 * without widening the constructor.
 */
export interface EngineErrorContext {
  hook?: HookErrorContext;
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

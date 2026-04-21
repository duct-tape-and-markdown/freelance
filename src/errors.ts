import type { EngineErrorCode } from "./error-codes.js";

export { EC, type EngineErrorCode } from "./error-codes.js";

export class EngineError extends Error {
  constructor(
    message: string,
    public code: EngineErrorCode,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

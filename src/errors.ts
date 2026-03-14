export class EngineError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "EngineError";
  }
}

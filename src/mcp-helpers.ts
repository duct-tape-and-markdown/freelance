/**
 * Shared MCP response helpers for tool handlers.
 */

import { EngineError } from "./errors.js";

export function jsonResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function errorResponse(message: string, detail?: unknown) {
  const payload = detail ?? { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

/**
 * Catch-all error handler for tool handlers. EngineError messages are
 * domain errors meant for the agent; anything else is prefixed
 * "Internal error:" so users can tell a bug from a usage issue.
 */
export function handleError(e: unknown) {
  if (e instanceof EngineError) {
    return errorResponse(e.message);
  }
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse(`Internal error: ${message}`);
}

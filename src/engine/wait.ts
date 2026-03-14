import type { NodeDefinition, WaitOnEntry, WaitCondition, SessionState } from "../types.js";
import { checkType } from "./returns.js";

export function parseDuration(duration: string): number | null {
  const regex = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = duration.match(regex);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export function evaluateWaitConditions(
  waitOn: WaitOnEntry[],
  context: Record<string, unknown>
): WaitCondition[] {
  return waitOn.map((entry) => {
    const value = context[entry.key];
    const exists = entry.key in context && value !== undefined && value !== null;
    let typeMatch = false;
    if (exists) {
      typeMatch = checkType(value, entry.type);
    }
    return {
      key: entry.key,
      type: entry.type,
      ...(entry.description ? { description: entry.description } : {}),
      satisfied: exists && typeMatch,
    };
  });
}

export function checkWaitTimeout(session: SessionState, nodeDef: NodeDefinition): boolean {
  if (!nodeDef.timeout || !session.waitArrivedAt) return false;
  if (session.context._waitTimedOut === true) return true;

  const timeoutMs = parseDuration(nodeDef.timeout);
  if (timeoutMs === null) return false;

  const arrivedAt = new Date(session.waitArrivedAt).getTime();
  const now = Date.now();
  if (now >= arrivedAt + timeoutMs) {
    session.context._waitTimedOut = true;
    return true;
  }
  return false;
}

export function computeTimeoutAt(arrivedAt: string, timeout?: string): string | undefined {
  if (!timeout) return undefined;
  const timeoutMs = parseDuration(timeout);
  if (timeoutMs === null) return undefined;
  return new Date(new Date(arrivedAt).getTime() + timeoutMs).toISOString();
}

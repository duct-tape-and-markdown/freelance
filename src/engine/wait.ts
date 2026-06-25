import type { NodeDefinition, SessionState, WaitCondition, WaitOnEntry } from "../types.js";
import { checkType } from "./returns.js";

function parseDuration(duration: string): number | null {
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
  context: Record<string, unknown>,
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

/**
 * Pure timeout test: returns whether the wait deadline has elapsed
 * WITHOUT mutating the session. Honors an already-stamped
 * `waitTimedOutAt` as a short-circuit read. Safe on read-only paths
 * (inspect) — see #224. The gate/write path pairs this with
 * `markWaitTimedOut` to persist the latch.
 */
export function evaluateWaitTimeout(session: SessionState, nodeDef: NodeDefinition): boolean {
  if (!nodeDef.timeout || !session.waitArrivedAt) return false;
  if (session.waitTimedOutAt) return true;

  const timeoutMs = parseDuration(nodeDef.timeout);
  if (timeoutMs === null) return false;

  const arrivedAt = new Date(session.waitArrivedAt).getTime();
  return Date.now() >= arrivedAt + timeoutMs;
}

/**
 * Latch the timeout onto the session, idempotently. Only the
 * gate/write path (`checkWaitBlocking`) calls this, where the write is
 * persisted by the post-transition saveEngine. Paired with
 * `evaluateWaitTimeout` (#224).
 */
export function markWaitTimedOut(session: SessionState): void {
  if (!session.waitTimedOutAt) {
    session.waitTimedOutAt = new Date().toISOString();
  }
}

/**
 * Enter a wait node: reset the `(waitArrivedAt, waitTimedOutAt)` pair
 * atomically. Both fields are scoped to the CURRENT wait occupancy, so
 * a fresh arrival stamps the arrival time and clears any prior wait's
 * timeout latch — otherwise the stale latch makes `evaluateWaitTimeout`
 * short-circuit and instantly bypass this wait's gate (#272). Keeping
 * init here next to the latch/read keeps the pair's whole lifecycle in
 * `wait.ts` rather than spread by convention across the engine. Returns
 * the arrival timestamp for the caller's `timeoutAt` computation.
 */
export function enterWait(session: SessionState): string {
  const arrivedAt = new Date().toISOString();
  session.waitArrivedAt = arrivedAt;
  session.waitTimedOutAt = undefined;
  return arrivedAt;
}

export function computeTimeoutAt(arrivedAt: string, timeout?: string): string | undefined {
  if (!timeout) return undefined;
  const timeoutMs = parseDuration(timeout);
  if (timeoutMs === null) return undefined;
  return new Date(new Date(arrivedAt).getTime() + timeoutMs).toISOString();
}

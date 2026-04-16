#!/usr/bin/env node
/**
 * Freelance plugin — UserPromptSubmit hook.
 *
 * Fires before every user prompt is sent to the model. If any active
 * traversal has been sitting in a wait node for longer than the stale
 * threshold, nudge the agent to inspect it. The hope: unstick
 * traversals that the agent forgot about mid-conversation.
 *
 * Hooks are stateless between invocations. We use `lastUpdated` on the
 * traversal record as a proxy for "agent has not touched this in a
 * while" — time-since-update is the closest thing to a "turns" counter
 * we can read without persisting state ourselves.
 *
 * Failure modes — silent exit (no output) in every one:
 *   - freelance CLI not on PATH
 *   - no active traversals
 *   - no traversals in a wait node
 *   - no stuck wait traversals by the time threshold
 *   - JSON parse / timeout failure
 */

import { spawnSync } from "node:child_process";

const CLI_TIMEOUT_MS = 3000;
// Default staleness threshold. 5 minutes is a compromise — short enough
// to fire in the same work session, long enough to avoid nudging on
// every prompt while the agent is actively investigating a wait node.
const DEFAULT_STUCK_MS = 5 * 60 * 1000;

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function emit(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })}\n`,
  );
}

function exitSilent() {
  process.exit(0);
}

function runInspect() {
  const result = spawnSync("freelance", ["inspect", "--active", "--waits", "--json"], {
    encoding: "utf-8",
    timeout: CLI_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  return safeParse(result.stdout);
}

function resolveStuckMs() {
  const raw = process.env.FREELANCE_STUCK_THRESHOLD_MS;
  if (!raw) return DEFAULT_STUCK_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STUCK_MS;
  return parsed;
}

// Main ---------------------------------------------------------------------

const inspect = runInspect();
if (!inspect || !Array.isArray(inspect.traversals) || inspect.traversals.length === 0) {
  exitSilent();
}

const threshold = resolveStuckMs();
const now = Date.now();

const stuck = inspect.traversals.filter((tr) => {
  if (tr.nodeType !== "wait") return false;
  if (!tr.lastUpdated) return false;
  const updatedAt = Date.parse(tr.lastUpdated);
  if (!Number.isFinite(updatedAt)) return false;
  return now - updatedAt >= threshold;
});

if (stuck.length === 0) exitSilent();

const lines = stuck.map((tr) => {
  const desc = tr.description ? ` — ${tr.description}` : "";
  const status = tr.waitStatus ? ` [${tr.waitStatus}]` : "";
  return `  - ${tr.traversalId} @ ${tr.currentNode}${status}${desc}`;
});

const header =
  stuck.length === 1
    ? "A Freelance traversal has been sitting in a wait node — it may need attention. Call `freelance_inspect` to check the wait conditions."
    : `${stuck.length} Freelance traversals have been sitting in wait nodes. Call \`freelance_inspect\` on each to check.`;

emit(`${header}\n${lines.join("\n")}`);

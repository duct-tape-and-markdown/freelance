#!/usr/bin/env node
/**
 * Freelance plugin — PostToolUse hook.
 *
 * Fires after every tool call. If any active traversal is sitting on a
 * wait node, surface the traversal ids, their wait conditions, and the
 * recent tool call so the agent can decide whether the call satisfied
 * the wait and, if so, call `freelance_advance`.
 *
 * No matching heuristic. No keyword guessing. The hook reports the
 * state and the agent does the reasoning — that's the only layer that
 * can reliably judge whether a tool call met a condition.
 *
 * Silent exit (no output) in every failure mode: CLI missing, no
 * traversals, no wait traversals, CLI timeout, JSON parse failure.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const CLI_TIMEOUT_MS = 3000;

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

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
        hookEventName: "PostToolUse",
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

function formatWaitingOn(waitingOn) {
  if (!Array.isArray(waitingOn) || waitingOn.length === 0) return "";
  return waitingOn
    .map((w) => {
      const mark = w.satisfied ? "✓" : "·";
      const desc = w.description ? ` — ${w.description}` : "";
      return `      ${mark} ${w.key} (${w.type})${desc}`;
    })
    .join("\n");
}

// Main ---------------------------------------------------------------------

const rawInput = readStdinSync();
const input = safeParse(rawInput) ?? {};
const toolName = input.tool_name ?? input.toolName ?? "";

const inspect = runInspect();
if (!inspect || !Array.isArray(inspect.traversals)) exitSilent();

const waits = inspect.traversals.filter((tr) => tr.nodeType === "wait");
if (waits.length === 0) exitSilent();

const lines = waits.map((tr) => {
  const desc = tr.description ? ` — ${tr.description}` : "";
  const status = tr.waitStatus ? ` [${tr.waitStatus}]` : "";
  const conditions = formatWaitingOn(tr.waitingOn);
  return `  - ${tr.traversalId} @ ${tr.currentNode}${status}${desc}${conditions ? `\n${conditions}` : ""}`;
});

const toolLabel = toolName ? `The \`${toolName}\` call` : "That tool call";
const header =
  waits.length === 1
    ? `A Freelance traversal is in a wait node. ${toolLabel} may have satisfied a wait condition — if so, call \`freelance_advance\` (setting any required context keys first).`
    : `${waits.length} Freelance traversals are in wait nodes. ${toolLabel} may have satisfied one — call \`freelance_advance\` on any that are ready.`;

emit(`${header}\n${lines.join("\n")}`);

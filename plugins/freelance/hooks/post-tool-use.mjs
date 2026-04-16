#!/usr/bin/env node
/**
 * Freelance plugin — PostToolUse hook.
 *
 * Fires after every tool call. If the agent is in a `wait` node whose
 * description plausibly matches the tool call that just happened — e.g.
 * a node described "wait for commit" right after a `Bash: git commit` —
 * inject a short nudge telling the agent which traversal is waiting and
 * hint that it should call `freelance_advance`.
 *
 * The hook is a pure nudge: it never advances traversals itself. That
 * preserves the agent's agency to decide whether the wait condition is
 * actually met.
 *
 * Matching heuristic is deliberately cheap: tokenize the wait node's
 * description, strip obvious stopwords, and check if any remaining
 * keyword appears in the tool name or its JSON-stringified arguments.
 * False positives are expected; the hook surfaces the matched substring
 * so the agent can sanity-check before acting. False negatives are
 * tolerated — the user will eventually `advance` manually.
 *
 * Failure modes (all treated identically — silent exit with zero output):
 *   - freelance CLI not on PATH
 *   - no active traversals
 *   - no traversals in a wait node
 *   - no wait node description matched the tool call
 *   - JSON parse of CLI output failed
 *   - CLI exceeded the timeout
 *
 * Silence-on-failure is intentional: this hook runs on every tool call
 * and has to be invisible when nothing interesting is happening.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const CLI_TIMEOUT_MS = 3000;
const MAX_ARG_LEN = 2000;

// Stopwords that show up in almost every wait description and would
// otherwise match everything. Keep the list short — over-filtering turns
// the match into nothing.
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "to",
  "for",
  "of",
  "on",
  "in",
  "at",
  "by",
  "with",
  "from",
  "up",
  "down",
  "out",
  "off",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "user",
  "agent",
  "wait",
  "waiting",
  "then",
  "when",
  "until",
  "before",
  "after",
  "while",
]);

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

function extractKeywords(description) {
  if (!description) return [];
  return description
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function buildSearchBlob(toolName, toolInput) {
  let blob = String(toolName ?? "").toLowerCase();
  try {
    const serialized = JSON.stringify(toolInput ?? {}).toLowerCase();
    blob += ` ${serialized.slice(0, MAX_ARG_LEN)}`;
  } catch {
    // ignore; blob stays as just the tool name
  }
  return blob;
}

function findMatch(keywords, blob) {
  for (const kw of keywords) {
    if (blob.includes(kw)) return kw;
  }
  return null;
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

// Main ---------------------------------------------------------------------

const rawInput = readStdinSync();
const input = safeParse(rawInput) ?? {};

const toolName = input.tool_name ?? input.toolName ?? "";
const toolInput = input.tool_input ?? input.toolInput ?? {};

const inspect = runInspect();
if (!inspect || !Array.isArray(inspect.traversals) || inspect.traversals.length === 0) {
  exitSilent();
}

const blob = buildSearchBlob(toolName, toolInput);

const matches = [];
for (const tr of inspect.traversals) {
  if (tr.nodeType !== "wait") continue;
  // Collect candidate keywords from the node description and any
  // per-condition descriptions on waitingOn entries. Both are
  // authored-for-humans prose so both are plausible match sources.
  const sources = [tr.description];
  if (Array.isArray(tr.waitingOn)) {
    for (const w of tr.waitingOn) {
      if (w.description) sources.push(w.description);
      if (w.key) sources.push(w.key);
    }
  }
  const keywords = new Set();
  for (const s of sources) {
    for (const kw of extractKeywords(s)) keywords.add(kw);
  }
  const match = findMatch(Array.from(keywords), blob);
  if (match) {
    matches.push({ traversal: tr, match });
  }
}

if (matches.length === 0) exitSilent();

const lines = matches.map(({ traversal, match }) => {
  const desc = traversal.description ? ` (${traversal.description})` : "";
  return `  - ${traversal.traversalId} @ ${traversal.currentNode}${desc} — matched "${match}"`;
});

const toolLabel = toolName ? `\`${toolName}\`` : "that tool call";
const header =
  matches.length === 1
    ? `A Freelance traversal is in a wait node whose description overlaps with ${toolLabel}. The wait condition may now be satisfied — call \`freelance_inspect\` to confirm, then \`freelance_advance\` if ready.`
    : `${matches.length} Freelance traversals are in wait nodes whose descriptions overlap with ${toolLabel}. Call \`freelance_inspect\` on each to confirm before advancing.`;

emit(`${header}\n${lines.join("\n")}`);

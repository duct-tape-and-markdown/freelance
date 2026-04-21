#!/usr/bin/env node
/**
 * Freelance plugin — systemMessage nudges for SessionStart / PostCompact.
 *
 * Dispatch by `process.argv[2]`. Uses the top-level `systemMessage`
 * field rather than `hookSpecificOutput.additionalContext`: the Claude
 * Code hook schema only permits `additionalContext` for
 * UserPromptSubmit / PostToolUse, so it'd be dropped on
 * SessionStart / PostCompact. `systemMessage` is schema-compliant for
 * every event.
 */

const MESSAGES = {
  "session-start":
    "Freelance is loaded. The `Freelance` skill drives workflows via the " +
    "`freelance` CLI — run `freelance status` to see loaded workflows and " +
    "any active traversals, `freelance memory status` to check the " +
    "persistent knowledge graph. Workflow and memory state lives on disk " +
    "under `.freelance/` and survives context compaction.",

  "post-compact":
    "Context was just compacted. Freelance traversal state lives on disk " +
    "and survived — every active workflow traversal is still at its current " +
    "node with its context intact. If you were mid-workflow before the " +
    "compaction, run `freelance inspect` to re-orient (returns current " +
    "node, valid transitions, and context). Memory and knowledge graph " +
    "state are also persistent — run `freelance memory status` if you " +
    "need to check.",
};

const which = process.argv[2];
const message = MESSAGES[which];
if (!message) {
  process.stderr.write(
    `freelance nudge: unknown event "${which}"; expected one of ${Object.keys(MESSAGES).join(", ")}\n`,
  );
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

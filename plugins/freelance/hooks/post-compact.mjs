#!/usr/bin/env node
/**
 * Freelance plugin — PostCompact hook.
 *
 * Fires after context compaction (both `auto` and `manual` matchers).
 * The whole point of on-disk traversal state was to survive
 * compaction — but the agent's *awareness* of being in a traversal
 * doesn't survive. This hook is the reminder that makes the affordance
 * actually usable post-compaction: "you may have been mid-workflow,
 * check."
 *
 * Uses the top-level `systemMessage` field rather than
 * `hookSpecificOutput.additionalContext`. The Claude Code hook schema
 * only permits `hookSpecificOutput.additionalContext` for a specific
 * set of events (UserPromptSubmit, PostToolUse); using it on
 * PostCompact fails output validation and the hook is dropped.
 * `systemMessage` is schema-compliant for every event.
 */

const message =
  "Context was just compacted. Freelance traversal state lives on disk " +
  "and survived — every active workflow traversal is still at its current " +
  "node with its context intact. If you were mid-workflow before the " +
  "compaction, run `freelance inspect` to re-orient (returns current " +
  "node, valid transitions, and context). Memory and knowledge graph " +
  "state are also persistent — run `freelance memory status` if you " +
  "need to check.";

process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

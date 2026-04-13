#!/usr/bin/env node
/**
 * Freelance plugin — PostCompact hook.
 *
 * Fires after context compaction (both `auto` and `manual` matchers).
 * The whole point of server-side traversal state was to survive
 * compaction — but the agent's *awareness* of being in a traversal
 * doesn't survive. This hook is the reminder that makes the affordance
 * actually usable post-compaction: "you may have been mid-workflow,
 * check."
 *
 * Outputs JSON on stdout in the `hookSpecificOutput.additionalContext`
 * format. Uses the PostCompact event name per the schema.
 */

const message =
  "Context was just compacted. Freelance traversal state is server-side " +
  "and survived — every active workflow traversal is still at its current " +
  "node with its context intact. If you were mid-workflow before the " +
  "compaction, call `freelance_inspect` to re-orient (returns current " +
  "node, valid transitions, and context). Memory and knowledge graph " +
  "state are also persistent — call `memory_status` if you need to check.";

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostCompact",
      additionalContext: message,
    },
  })}\n`,
);

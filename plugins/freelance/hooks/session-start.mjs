#!/usr/bin/env node
/**
 * Freelance plugin — SessionStart hook.
 *
 * Fires on Claude Code `startup` and `resume` matchers. Injects a short
 * orientation reminder so the agent discovers freelance_* tools without
 * having to be told the plugin exists. Intentionally minimal — one
 * nudge, no tool invocation, no configuration. If this feels noisy the
 * user can disable it via their Claude Code settings.
 *
 * Outputs JSON on stdout in the `hookSpecificOutput.additionalContext`
 * format so the message is injected as a system reminder.
 */

const message =
  "Freelance is loaded. Workflow enforcement is available via `freelance_*` " +
  "tools; persistent knowledge graph via `memory_*` tools. Call " +
  "`freelance_list` to discover available workflows; call `memory_status` " +
  "to check the knowledge graph (propositions, staleness, entity counts). " +
  "Workflow and memory state lives server-side and survives context compaction.";

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: message,
    },
  })}\n`,
);

#!/usr/bin/env node
/**
 * Freelance plugin — SessionStart hook.
 *
 * Fires on Claude Code `startup` and `resume` matchers. Injects a short
 * orientation reminder so the agent discovers the Freelance CLI without
 * having to be told the plugin exists. Intentionally minimal — one
 * nudge, no command invocation, no configuration. If this feels noisy
 * the user can disable it via their Claude Code settings.
 *
 * Uses the top-level `systemMessage` field rather than
 * `hookSpecificOutput.additionalContext`. The Claude Code hook schema
 * only permits `hookSpecificOutput.additionalContext` for a specific
 * set of events (UserPromptSubmit, PostToolUse); using it on
 * SessionStart fails output validation and the hook is dropped.
 * `systemMessage` is schema-compliant for every event.
 */

const message =
  "Freelance is loaded. The `Freelance` skill drives workflows via the " +
  "`freelance` CLI — run `freelance status` to see loaded workflows and " +
  "any active traversals, `freelance memory status` to check the " +
  "persistent knowledge graph. Workflow and memory state lives on disk " +
  "under `.freelance/` and survives context compaction.";

process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

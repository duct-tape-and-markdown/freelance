#!/usr/bin/env node
/**
 * Freelance plugin — systemMessage nudges for SessionStart / PostCompact.
 *
 * SessionStart compares `plugin.json#version` against `freelance --version`
 * and surfaces an install / sync recommendation when the CLI is missing
 * or older than the plugin. Asymmetric comparison: CLI ahead of plugin
 * stays silent (forward-compat on minor releases). PostCompact is
 * unconditional — always re-orients the agent.
 *
 * Uses the top-level `systemMessage` field rather than
 * `hookSpecificOutput.additionalContext` — the Claude Code hook schema
 * only permits `additionalContext` for UserPromptSubmit / PostToolUse,
 * so it'd be dropped on SessionStart / PostCompact. `systemMessage` is
 * schema-compliant for every event.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const which = process.argv[2];

const pluginVersion = () => {
  const root =
    process.env.CLAUDE_PLUGIN_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const raw = fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf-8");
  return JSON.parse(raw).version;
};

const cliVersion = () => {
  try {
    const out = execFileSync("freelance", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const m = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]*)?)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
};

// Coarse semver: treat x.y.z.<suffix> as integers where possible. Adequate
// for the "is CLI older than plugin" check we care about. Prerelease
// suffixes are unlikely in practice on shipped plugin versions; if they
// appear they'll just compare as 0 and fall through correctly.
const cliOlderThanPlugin = (cli, plugin) => {
  const parse = (v) => v.split(".").map((s) => parseInt(s, 10) || 0);
  const a = parse(cli);
  const b = parse(plugin);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return false;
  }
  return false;
};

const happyPathNudge =
  "Freelance is loaded. The `Freelance` skill drives workflows via the " +
  "`freelance` CLI — run `freelance status` to see loaded workflows and " +
  "any active traversals, `freelance memory status` to check the " +
  "persistent knowledge graph. Workflow and memory state lives on disk " +
  "under `.freelance/` and survives context compaction.";

const postCompactNudge =
  "Context was just compacted. Freelance traversal state lives on disk " +
  "and survived — every active workflow traversal is still at its current " +
  "node with its context intact. If you were mid-workflow before the " +
  "compaction, run `freelance inspect` to re-orient (returns current " +
  "node, valid transitions, and context). Memory and knowledge graph " +
  "state are also persistent — run `freelance memory status` if you " +
  "need to check.";

const missingCliNudge = (pv) =>
  `Freelance plugin v${pv} is loaded but the \`freelance\` CLI is not on ` +
  `PATH. Run \`npm install -g freelance-mcp@${pv}\` to install, then ` +
  "`freelance status` to begin. For one-off use without a global install, " +
  `\`npx -y freelance-mcp@${pv} <verb>\` works for every verb the skill ` +
  "describes.";

const staleCliNudge = (cv, pv) =>
  `Freelance plugin is v${pv} but installed CLI is v${cv}. The skill ` +
  "may reference verbs or flags your CLI doesn't have yet. Run " +
  `\`npm install -g freelance-mcp@${pv}\` to sync. Meanwhile ` +
  `\`npx -y freelance-mcp@${pv} <verb>\` is safe.`;

let message;

if (which === "session-start") {
  const pv = pluginVersion();
  const cv = cliVersion();
  if (cv === null) message = missingCliNudge(pv);
  else if (cliOlderThanPlugin(cv, pv)) message = staleCliNudge(cv, pv);
  else message = happyPathNudge;
} else if (which === "post-compact") {
  message = postCompactNudge;
} else {
  process.stderr.write(
    `freelance nudge: unknown event "${which}"; expected session-start or post-compact\n`,
  );
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

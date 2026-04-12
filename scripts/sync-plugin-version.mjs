#!/usr/bin/env node
/**
 * Keep plugins/freelance/.claude-plugin/plugin.json's version in sync with
 * package.json. Claude Code's plugin cache uses the plugin.json version to
 * decide whether to refresh an installed plugin, so a stale version here
 * means users silently don't see updates.
 *
 * Wired via the `version` and `prepublishOnly` npm script hooks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(repoRoot, "package.json");
const pluginPath = path.join(repoRoot, "plugins", "freelance", ".claude-plugin", "plugin.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));

if (plugin.version === pkg.version) {
  console.log(`plugin.json already at ${pkg.version}`);
  process.exit(0);
}

const prev = plugin.version;
plugin.version = pkg.version;
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
console.log(`plugin.json: ${prev} \u2192 ${pkg.version}`);

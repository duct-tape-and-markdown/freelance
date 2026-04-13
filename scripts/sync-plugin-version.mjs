#!/usr/bin/env node
/**
 * Keep plugin version metadata in sync with package.json#version.
 *
 * Two files need to track the package version:
 *
 *   1. plugins/freelance/.claude-plugin/plugin.json
 *      Claude Code's plugin cache uses plugin.json#version to decide
 *      whether to refresh an installed plugin. Stale version → users
 *      silently don't see updates.
 *
 *   2. .claude-plugin/marketplace.json (plugins[name="freelance"].version)
 *      The top-level marketplace manifest lists each plugin with its
 *      version. Matches Anthropic's plugin.schema convention so future
 *      Claude Code versions that expect it here work correctly.
 *
 * Wired via the `version` and `prepublishOnly` npm script hooks.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(repoRoot, "package.json");
const pluginPath = path.join(repoRoot, "plugins", "freelance", ".claude-plugin", "plugin.json");
const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const target = pkg.version;

/**
 * Write JSON back with a trailing newline. Returns the previous value
 * (or null if none was set) so the caller can log what changed.
 */
function syncField(filePath, update) {
  const obj = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const prev = update(obj);
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`);
  return prev;
}

// --- plugin.json ---
const prevPluginVersion = syncField(pluginPath, (plugin) => {
  const prev = plugin.version;
  plugin.version = target;
  return prev;
});

if (prevPluginVersion === target) {
  console.log(`plugin.json already at ${target}`);
} else {
  console.log(`plugin.json: ${prevPluginVersion} \u2192 ${target}`);
}

// --- marketplace.json ---
const prevMarketplaceVersion = syncField(marketplacePath, (market) => {
  const entry = market.plugins?.find((p) => p.name === "freelance");
  if (!entry) {
    throw new Error(
      `marketplace.json: no plugins[name="freelance"] entry found; cannot sync version`,
    );
  }
  const prev = entry.version ?? null;
  entry.version = target;
  return prev;
});

if (prevMarketplaceVersion === target) {
  console.log(`marketplace.json already at ${target}`);
} else if (prevMarketplaceVersion === null) {
  console.log(`marketplace.json: (none) \u2192 ${target}`);
} else {
  console.log(`marketplace.json: ${prevMarketplaceVersion} \u2192 ${target}`);
}

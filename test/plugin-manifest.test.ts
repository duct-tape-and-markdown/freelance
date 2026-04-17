import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Plugin manifest integrity tests. The plugin distribution has three
// files that must stay coherent with each other and with package.json:
//
//   1. plugins/freelance/.mcp.json — launcher config. Must use the
//      public `npx -y freelance-mcp@^<major>` form so the plugin works
//      on any machine and picks up patch releases automatically. Was
//      shipped broken in 1.3.1 with hardcoded dev paths (#70).
//   2. plugins/freelance/.claude-plugin/plugin.json — plugin version.
//      Claude Code's plugin cache uses plugin.json#version to decide
//      whether to refresh an installed plugin.
//   3. .claude-plugin/marketplace.json — marketplace listing version.
//
// `sync-plugin-version.mjs` runs on `npm version` and keeps (2)+(3) in
// lockstep with package.json. These tests catch any manual edit that
// skips that hook, plus #70's class of bug where the .mcp.json ships
// with machine-local paths.

const repoRoot = path.resolve(import.meta.dirname, "..");

function readJson<T>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8")) as T;
}

interface PkgJson {
  version: string;
}

interface McpJson {
  [serverName: string]: {
    command: string;
    args: string[];
  };
}

interface PluginJson {
  version: string;
  name: string;
}

interface MarketplaceJson {
  plugins: Array<{ name: string; version: string }>;
}

const pkg = readJson<PkgJson>("package.json");
const mcp = readJson<McpJson>("plugins/freelance/.mcp.json");
const plugin = readJson<PluginJson>("plugins/freelance/.claude-plugin/plugin.json");
const marketplace = readJson<MarketplaceJson>(".claude-plugin/marketplace.json");

describe("plugin .mcp.json launcher shape", () => {
  // Regression guard for #70: the 1.3.1 plugin shipped with
  // hardcoded /home/jwcam/... paths, silently breaking every install
  // on any machine that wasn't the author's dev box.

  const server = mcp.freelance;

  it("has a freelance server entry", () => {
    expect(server).toBeDefined();
  });

  it("uses npx as the launcher command (not a hardcoded path)", () => {
    expect(server.command).toBe("npx");
  });

  it("has no absolute filesystem paths in args", () => {
    // Catches /home/.../, /Users/.../, C:\..., and bare-drive absolutes.
    // A public plugin manifest should not reference any machine-local path.
    const absolutePathPattern = /^(\/|[A-Za-z]:[\\/])/;
    for (const arg of server.args) {
      expect(
        absolutePathPattern.test(arg),
        `arg "${arg}" looks like an absolute path — the plugin manifest must be portable`,
      ).toBe(false);
    }
  });

  it("references the freelance-mcp package with a semver range matching package.json's major", () => {
    // The launcher pins to ^<major> so `npm publish` of a new patch/minor
    // reaches users automatically, but a deliberate major bump doesn't
    // silently break existing installs. If the range drifts off the
    // current major, the plugin is either stuck on an old major or
    // pointing at an unreleased one.
    const packageArg = server.args.find((a) => a.startsWith("freelance-mcp"));
    expect(packageArg, "freelance-mcp package arg missing").toBeDefined();

    const match = packageArg?.match(/^freelance-mcp@\^(\d+)$/);
    expect(match, `expected freelance-mcp@^<major>, got "${packageArg}"`).not.toBeNull();

    const pluginMajor = match?.[1];
    const pkgMajor = pkg.version.split(".")[0];
    expect(pluginMajor).toBe(pkgMajor);
  });

  it("invokes the mcp subcommand", () => {
    expect(server.args).toContain("mcp");
  });
});

describe("plugin version metadata stays in sync with package.json", () => {
  // Guards against manual edits that skip the sync-plugin-version hook.
  // Claude Code's plugin cache uses plugin.json#version to refresh
  // installs; drift here means users silently don't see updates.

  it("plugin.json version matches package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json freelance entry version matches package.json", () => {
    const entry = marketplace.plugins.find((p) => p.name === "freelance");
    expect(entry, "freelance plugin missing from marketplace.json").toBeDefined();
    expect(entry?.version).toBe(pkg.version);
  });
});

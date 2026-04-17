import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Plugin manifest integrity tests. Three files must stay coherent with
// each other and with package.json:
//   1. plugins/freelance/.mcp.json — launcher config (must use the
//      public `npx -y freelance-mcp@^<major>` form so it works on any
//      machine). Shipped broken in 1.3.1 with hardcoded dev paths (#70).
//   2. plugins/freelance/.claude-plugin/plugin.json — version the Claude
//      Code plugin cache uses to refresh installs.
//   3. .claude-plugin/marketplace.json — marketplace listing version.
// sync-plugin-version.mjs runs on `npm version` and keeps (2)+(3) in
// lockstep with package.json. These tests catch manual edits that skip
// the hook plus the #70 class of bug where .mcp.json ships machine-local.

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
  const server = mcp.freelance;

  it("has a freelance server entry", () => {
    expect(server).toBeDefined();
  });

  it("uses npx as the launcher command (not a hardcoded path)", () => {
    expect(server.command).toBe("npx");
  });

  it("has no absolute filesystem paths in args", () => {
    // Reject both POSIX (/home/...) and Win32 (C:\...) absolutes so the
    // test catches machine-local paths regardless of the CI/dev platform
    // where they were introduced. A public plugin manifest must be portable.
    for (const arg of server.args) {
      const isAbsolute = path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg);
      expect(
        isAbsolute,
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

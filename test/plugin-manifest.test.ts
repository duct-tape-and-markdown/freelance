import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The .mcp.json launcher must pin freelance-mcp exactly, not use a
// range: npx keys its _npx/<hash> cache by the raw spec string, so
// `freelance-mcp@^1` reuses any cached 1.x and never re-resolves
// against the registry (npm/cli#7838, #6804). sync-plugin-version.mjs
// rewrites the pin on every `npm version`; this file catches manual
// edits that skip the hook or drop back to a range, plus the #70 class
// of bug where .mcp.json ships with machine-local dev paths.

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

  it("pins freelance-mcp to the exact package.json version", () => {
    const packageArg = server.args.find((a) => a.startsWith("freelance-mcp"));
    expect(packageArg, "freelance-mcp package arg missing").toBeDefined();
    expect(packageArg).toBe(`freelance-mcp@${pkg.version}`);
  });

  it("invokes the mcp subcommand", () => {
    expect(server.args).toContain("mcp");
  });
});

describe("plugin version metadata stays in sync with package.json", () => {
  it("plugin.json version matches package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json freelance entry version matches package.json", () => {
    const entry = marketplace.plugins.find((p) => p.name === "freelance");
    expect(entry, "freelance plugin missing from marketplace.json").toBeDefined();
    expect(entry?.version).toBe(pkg.version);
  });
});

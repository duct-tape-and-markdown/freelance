import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readJson<T>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), "utf-8")) as T;
}

interface PkgJson {
  version: string;
}

interface PluginJson {
  version: string;
  name: string;
}

interface MarketplaceJson {
  plugins: Array<{ name: string; version: string }>;
}

const pkg = readJson<PkgJson>("package.json");
const plugin = readJson<PluginJson>("plugins/freelance/.claude-plugin/plugin.json");
const marketplace = readJson<MarketplaceJson>(".claude-plugin/marketplace.json");

describe("driving skill ships with the plugin and the npm template tree", () => {
  const pluginSkill = path.join(repoRoot, "plugins/freelance/skills/freelance/SKILL.md");
  const templateSkill = path.join(repoRoot, "templates/skills/freelance/SKILL.md");

  it("exists in the plugin distribution", () => {
    expect(fs.existsSync(pluginSkill), `missing: ${pluginSkill}`).toBe(true);
  });

  it("exists in templates/ (npm CLI init reads from here)", () => {
    expect(fs.existsSync(templateSkill), `missing: ${templateSkill}`).toBe(true);
  });

  // Plugin users load SKILL.md from the plugin dir; CLI-init users
  // copy from templates/. Content identity prevents the plugin crowd
  // and the CLI crowd from drifting apart at release time.
  it("plugin and template copies are identical", () => {
    expect(fs.readFileSync(templateSkill, "utf-8")).toBe(fs.readFileSync(pluginSkill, "utf-8"));
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

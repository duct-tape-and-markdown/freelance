import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allClientChoices, clientDisplayName, detectClients } from "../src/cli/clients.js";

describe("clientDisplayName", () => {
  it("returns human-readable names for all clients", () => {
    expect(clientDisplayName("claude-code")).toBe("Claude Code");
    expect(clientDisplayName("cursor")).toBe("Cursor");
    expect(clientDisplayName("windsurf")).toBe("Windsurf");
    expect(clientDisplayName("cline")).toBe("Cline");
    expect(clientDisplayName("manual")).toBe("Other / manual");
  });
});

describe("allClientChoices", () => {
  it("returns all 5 client choices", () => {
    const choices = allClientChoices();
    expect(choices).toHaveLength(5);
    expect(choices.map((c) => c.value)).toEqual([
      "claude-code",
      "cursor",
      "windsurf",
      "cline",
      "manual",
    ]);
  });
});

describe("detectClients", () => {
  let originalCwd: string;
  let workDir: string;
  let origPath: string | undefined;
  let origHome: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-clients-"));
    process.chdir(workDir);
    origPath = process.env.PATH;
    origHome = process.env.HOME;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (origPath !== undefined) process.env.PATH = origPath;
    else delete process.env.PATH;
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
  });

  it("detects all three clients when present", () => {
    const binDir = path.join(workDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "claude"), "");
    fs.mkdirSync(path.join(workDir, ".cursor"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    fs.mkdirSync(path.join(fakeHome, ".codeium", "windsurf"), { recursive: true });

    process.env.PATH = binDir;
    process.env.HOME = fakeHome;

    const clients = detectClients();
    expect(clients).toContain("claude-code");
    expect(clients).toContain("cursor");
    expect(clients).toContain("windsurf");

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
});

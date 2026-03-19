import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./output.js";

export type Client = "claude-code" | "cursor" | "windsurf" | "cline" | "manual";

export function detectClients(): Client[] {
  const detected: Client[] = [];

  const envPath = process.env.PATH;
  if (!envPath) return detected;
  const pathDirs = envPath.split(path.delimiter);
  for (const dir of pathDirs) {
    if (fs.existsSync(path.join(dir, "claude"))) {
      detected.push("claude-code");
      break;
    }
  }

  if (fs.existsSync(path.join(process.cwd(), ".cursor"))) {
    detected.push("cursor");
  }

  const home = homeDir();
  if (fs.existsSync(path.join(home, ".codeium", "windsurf"))) {
    detected.push("windsurf");
  }

  return detected;
}

export function clientDisplayName(client: Client): string {
  switch (client) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "manual":
      return "Other / manual";
  }
}

export function allClientChoices() {
  return [
    { value: "claude-code" as const, name: "Claude Code" },
    { value: "cursor" as const, name: "Cursor" },
    { value: "windsurf" as const, name: "Windsurf" },
    { value: "cline" as const, name: "Cline" },
    { value: "manual" as const, name: "Other / manual" },
  ];
}

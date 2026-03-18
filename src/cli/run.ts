import { execSync } from "node:child_process";
import { info, fatal, EXIT } from "./output.js";

export interface RunOptions {
  graphId: string;
  agent: string;
  prompt?: string;
  model?: string;
  dryRun?: boolean;
  port: number;
  host: string;
}

/**
 * Thin convenience wrapper — builds the right CLI command to start
 * an agent with Freelance's MCP server connected, then either
 * prints it (--dry-run) or executes it.
 */
export function run(options: RunOptions): void {
  const mcpUrl = `http://${options.host}:${options.port}`;
  const prompt = options.prompt
    ? options.prompt
    : `You have a Freelance daemon at ${mcpUrl}. Start a traversal for "${options.graphId}" and follow the graph.`;

  let command: string;

  switch (options.agent) {
    case "claude-code":
      command = `claude`;
      if (options.model) command += ` --model ${options.model}`;
      command += ` --prompt ${JSON.stringify(prompt)}`;
      break;

    case "opencode":
      command = `opencode`;
      if (options.model) command += ` --model ${options.model}`;
      command += ` ${JSON.stringify(prompt)}`;
      break;

    default:
      // Generic: just print the prompt and let user figure it out
      command = `${options.agent} ${JSON.stringify(prompt)}`;
      break;
  }

  if (options.dryRun) {
    info("Would run:");
    info(`  ${command}`);
    info("");
    info("Make sure your agent has Freelance configured as an MCP server.");
    info(`Daemon: ${mcpUrl}`);
    return;
  }

  info(`Starting ${options.agent} for "${options.graphId}"...`);
  info(`  ${command}`);
  info("");

  try {
    execSync(command, { stdio: "inherit" });
  } catch (err) {
    // Agent exited — that's normal
  }
}

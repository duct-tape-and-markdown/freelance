/**
 * Agent registry — maps agent names to CLI commands, MCP config methods,
 * and permission bypass flags.
 */

export interface AgentDefinition {
  name: string;
  command: string;
  /** Build CLI args for spawning. Returns the full args array. */
  buildArgs(options: AgentSpawnOptions): string[];
  /** How to pass MCP config to this agent */
  mcpConfigMethod: "cli-flag" | "config-file" | "env" | "manual";
}

export interface AgentSpawnOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  mcpConfig?: Record<string, unknown>;
  dangerouslySkipPermissions?: boolean;
}

const claudeCode: AgentDefinition = {
  name: "claude-code",
  command: "claude",
  mcpConfigMethod: "cli-flag",
  buildArgs(options) {
    const args: string[] = ["--print", options.prompt];
    if (options.model) args.push("--model", options.model);
    if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    return args;
  },
};

const opencode: AgentDefinition = {
  name: "opencode",
  command: "opencode",
  mcpConfigMethod: "config-file",
  buildArgs(options) {
    const args: string[] = [options.prompt];
    if (options.model) args.push("--model", options.model);
    return args;
  },
};

const cursor: AgentDefinition = {
  name: "cursor",
  command: "cursor",
  mcpConfigMethod: "config-file",
  buildArgs(options) {
    const args: string[] = ["--agent", options.prompt];
    if (options.dangerouslySkipPermissions) args.push("--yolo");
    return args;
  },
};

const REGISTRY: Record<string, AgentDefinition> = {
  "claude-code": claudeCode,
  opencode,
  cursor,
};

export function getAgent(name: string): AgentDefinition | undefined {
  return REGISTRY[name];
}

export function listAgents(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * Create a custom agent definition from a user-provided command string.
 */
export function createCustomAgent(command: string): AgentDefinition {
  return {
    name: "custom",
    command,
    mcpConfigMethod: "manual",
    buildArgs(options) {
      return [options.prompt];
    },
  };
}

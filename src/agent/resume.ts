import { generateInitialPrompt } from "./prompt.js";
import { spawnAgent, type SpawnResult } from "./spawner.js";
import type { AgentDefinition, AgentSpawnOptions } from "./registry.js";
import type { DaemonClient } from "../dashboard/client.js";

export interface ResumeOptions {
  traversalId: string;
  agent: AgentDefinition;
  client: DaemonClient;
  model?: string;
  cwd?: string;
  attach?: boolean;
  additionalPrompt?: string;
  dangerouslySkipPermissions?: boolean;
}

/**
 * Resume an existing traversal by spawning a new agent for it.
 * Validates the traversal is active, generates a resume prompt,
 * spawns the agent, and registers it with the daemon.
 */
export async function resumeTraversal(options: ResumeOptions): Promise<SpawnResult> {
  // Validate traversal exists and get current state
  const detail = await options.client.inspectTraversal(options.traversalId, "position");

  const prompt = generateInitialPrompt({
    traversalId: options.traversalId,
    graphId: detail.graphId,
    currentNode: detail.currentNode,
    resume: true,
    additionalPrompt: options.additionalPrompt,
  });

  const spawnOpts: AgentSpawnOptions & { attach?: boolean; traversalId: string } = {
    prompt,
    model: options.model,
    cwd: options.cwd,
    attach: options.attach,
    traversalId: options.traversalId,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  };

  const result = spawnAgent(options.agent, spawnOpts);

  // Register with daemon
  await options.client.registerAgent(options.traversalId, result.pid, options.agent.name);

  return result;
}

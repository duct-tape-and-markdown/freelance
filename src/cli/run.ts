import { DaemonClient, DaemonConnectionError } from "../dashboard/client.js";
import { getAgent, createCustomAgent, listAgents } from "../agent/registry.js";
import { generateInitialPrompt } from "../agent/prompt.js";
import { spawnAgent } from "../agent/spawner.js";
import { info, fatal, EXIT } from "./output.js";
import { DEFAULT_PORT } from "../paths.js";

export interface RunOptions {
  graphId?: string;
  agent: string;
  agentCmd?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  attach: boolean;
  port: number;
  host: string;
  resume?: string;
  dangerouslySkipPermissions?: boolean;
}

export async function run(options: RunOptions): Promise<void> {
  const client = new DaemonClient({ host: options.host, port: options.port });

  // Verify daemon is running
  try {
    await client.health();
  } catch (err) {
    if (err instanceof DaemonConnectionError) {
      fatal(err.message, EXIT.GENERAL_ERROR);
    }
    throw err;
  }

  // Resolve agent
  const agentDef = options.agentCmd
    ? createCustomAgent(options.agentCmd)
    : getAgent(options.agent);

  if (!agentDef) {
    fatal(
      `Unknown agent "${options.agent}". Available: ${listAgents().join(", ")}`,
      EXIT.INVALID_USAGE
    );
  }

  let traversalId: string;
  let graphId: string;
  let currentNode: string | undefined;

  if (options.resume) {
    // Resume existing traversal
    traversalId = options.resume;
    const detail = await client.inspectTraversal(traversalId, "position");
    graphId = detail.graphId;
    currentNode = detail.currentNode;
    info(`Resuming traversal ${traversalId} for "${graphId}" at node "${currentNode}"`);
  } else {
    // Start new traversal
    if (!options.graphId) {
      fatal("Graph ID is required (or use --resume <id>)", EXIT.INVALID_USAGE);
    }
    graphId = options.graphId;
    const result = await client.startTraversal(graphId);
    traversalId = result.traversalId;
    info(`Started traversal ${traversalId} for "${graphId}"`);
  }

  // Generate prompt
  const prompt = generateInitialPrompt({
    traversalId,
    graphId,
    currentNode,
    resume: !!options.resume,
    additionalPrompt: options.prompt,
  });

  // Spawn agent
  const result = spawnAgent(agentDef!, {
    prompt,
    model: options.model,
    cwd: options.cwd,
    attach: options.attach,
    traversalId,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  });

  // Register agent with daemon
  await client.registerAgent(traversalId, result.pid, agentDef!.name);

  if (options.attach) {
    info(`Agent attached (pid ${result.pid})`);
    // Wait for process to exit
    result.process.on("exit", (code) => {
      info(`Agent exited with code ${code}`);
    });
  } else {
    info(`Agent spawned in background (pid ${result.pid})`);
    if (result.logFile) {
      info(`Log: ${result.logFile}`);
    }
    info(`Monitor with: freelance dashboard`);
  }
}

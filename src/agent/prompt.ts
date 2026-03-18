/**
 * Generate initial prompts for agent sessions.
 */

export interface PromptOptions {
  traversalId: string;
  graphId: string;
  currentNode?: string;
  resume?: boolean;
  additionalPrompt?: string;
}

export function generateInitialPrompt(options: PromptOptions): string {
  const parts: string[] = [];

  if (options.resume) {
    parts.push(
      `Resuming Freelance traversal ${options.traversalId} for "${options.graphId}".`,
      `Currently at node "${options.currentNode ?? "unknown"}" . Call graph_inspect to see your state.`
    );
  } else {
    parts.push(
      `You have an active Freelance traversal (${options.traversalId}) for "${options.graphId}".`,
      `Call graph_inspect to see your current position and instructions.`
    );
  }

  if (options.additionalPrompt) {
    parts.push("", options.additionalPrompt);
  }

  return parts.join("\n");
}

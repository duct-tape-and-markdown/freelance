import type { NodeDefinition, NodeInfo } from "../types.js";

export function cloneContext(ctx: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(ctx);
}

export function toNodeInfo(node: NodeDefinition): NodeInfo {
  return {
    type: node.type,
    description: node.description,
    ...(node.instructions ? { instructions: node.instructions } : {}),
    suggestedTools: node.suggestedTools ?? [],
    ...(node.returns ? { returns: node.returns } : {}),
    ...(node.readOnly ? { readOnly: node.readOnly } : {}),
  };
}

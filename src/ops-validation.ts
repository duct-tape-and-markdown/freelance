import type { OpsRegistry } from "./engine/operations.js";
import type { ValidatedGraph } from "./types.js";

export interface OpValidationError {
  readonly graphId: string;
  readonly nodeId: string;
  readonly opName: string;
  readonly message: string;
}

/**
 * Check every programmatic node in every graph against the given ops
 * registry. Returns a structured error for each unknown op reference.
 * Callers decide whether to throw, warn, or remove the offending graph —
 * the function never mutates the input.
 */
export function validateOps(
  graphs: Map<string, ValidatedGraph>,
  registry: OpsRegistry,
): OpValidationError[] {
  const errors: OpValidationError[] = [];
  const registered = registry.list().join(", ");
  for (const [graphId, vg] of graphs) {
    for (const [nodeId, node] of Object.entries(vg.definition.nodes)) {
      if (node.type !== "programmatic" || !node.operation) continue;
      if (!registry.has(node.operation.name)) {
        errors.push({
          graphId,
          nodeId,
          opName: node.operation.name,
          message:
            `Unknown operation "${node.operation.name}" on programmatic node "${nodeId}" ` +
            `in graph "${graphId}". Registered ops: [${registered}]`,
        });
      }
    }
  }
  return errors;
}

/**
 * Convenience wrapper: validate and remove any graph whose programmatic
 * nodes reference unknown ops, preserving the "graph fails to load"
 * semantic the previous load-time check gave us. Returns the errors so
 * the caller can log or surface them through its own channel.
 */
export function validateOpsAndPrune(
  graphs: Map<string, ValidatedGraph>,
  registry: OpsRegistry,
): OpValidationError[] {
  const errors = validateOps(graphs, registry);
  const pruned = new Set<string>();
  for (const err of errors) {
    if (!pruned.has(err.graphId)) {
      graphs.delete(err.graphId);
      pruned.add(err.graphId);
    }
  }
  return errors;
}

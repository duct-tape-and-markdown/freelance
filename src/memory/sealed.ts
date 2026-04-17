/**
 * Sealed workflows registry. Single source of truth for the workflow graphs
 * that ship built-in with memory — `memory:compile` and `memory:recall`.
 *
 * Centralized so the loader, the MCP server, and the CLI `validate` command
 * all see the same set of sealed graph ids. Cross-graph validation needs
 * these to resolve subgraph references from user-authored workflows before
 * the server has had a chance to inject them into the runtime graphs map.
 */

import type { ValidatedGraph } from "../types.js";
import { buildRecollectionWorkflow, RECOLLECTION_ID } from "./recollection.js";
import { buildCompileKnowledgeWorkflow, COMPILE_KNOWLEDGE_ID } from "./workflow.js";

export { COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID };

/** IDs of all sealed workflows. Cheap to compute — no graph construction. */
export const SEALED_GRAPH_IDS: ReadonlySet<string> = new Set([
  COMPILE_KNOWLEDGE_ID,
  RECOLLECTION_ID,
]);

/** Build a fresh Map of sealed workflow id → ValidatedGraph. */
export function getSealedGraphs(): Map<string, ValidatedGraph> {
  const sealed = new Map<string, ValidatedGraph>();
  sealed.set(COMPILE_KNOWLEDGE_ID, buildCompileKnowledgeWorkflow());
  sealed.set(RECOLLECTION_ID, buildRecollectionWorkflow());
  return sealed;
}

/**
 * Merge sealed graphs into a target map. User-authored entries take
 * precedence — a sealed id only lands if nothing has claimed it yet.
 * Mutates `target` in place and returns it for convenience.
 */
export function mergeSealedGraphs(
  target: Map<string, ValidatedGraph>,
  sealed: Map<string, ValidatedGraph>,
): Map<string, ValidatedGraph> {
  for (const [id, graph] of sealed) {
    if (!target.has(id)) target.set(id, graph);
  }
  return target;
}

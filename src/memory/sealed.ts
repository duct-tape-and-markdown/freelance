/**
 * Built-in memory workflows (`memory:compile`, `memory:recall`) and the
 * helpers used to merge them into a graphs map. The loader needs these
 * visible during cross-graph validation or user workflows that subgraph
 * into memory:* fail as "unknown graph" before runtime injection.
 */

import type { ValidatedGraph } from "../types.js";
import { buildRecollectionWorkflow, RECOLLECTION_ID } from "./recollection.js";
import { buildCompileKnowledgeWorkflow, COMPILE_KNOWLEDGE_ID } from "./workflow.js";

export { COMPILE_KNOWLEDGE_ID, RECOLLECTION_ID };

export const SEALED_GRAPH_IDS: ReadonlySet<string> = new Set([
  COMPILE_KNOWLEDGE_ID,
  RECOLLECTION_ID,
]);

export function getSealedGraphs(): Map<string, ValidatedGraph> {
  const sealed = new Map<string, ValidatedGraph>();
  sealed.set(COMPILE_KNOWLEDGE_ID, buildCompileKnowledgeWorkflow());
  sealed.set(RECOLLECTION_ID, buildRecollectionWorkflow());
  return sealed;
}

/** Merge sealed graphs into `target`. User-authored ids win. Mutates `target`. */
export function mergeSealedGraphs(
  target: Map<string, ValidatedGraph>,
  sealed: Map<string, ValidatedGraph>,
): Map<string, ValidatedGraph> {
  for (const [id, graph] of sealed) {
    if (!target.has(id)) target.set(id, graph);
  }
  return target;
}

/**
 * Sealed compile-knowledge workflow.
 *
 * Built programmatically, injected into the graphs map when memory is enabled.
 * Not user-editable. Agent-facing prose lives in messages.ts.
 */

import { GraphBuilder } from "../builder.js";
import type { ValidatedGraph } from "../types.js";
import { compileMessages as M } from "./messages.js";

export const COMPILE_KNOWLEDGE_ID = "memory:compile";

export function buildCompileKnowledgeWorkflow(): ValidatedGraph {
  return new GraphBuilder(COMPILE_KNOWLEDGE_ID, "Compile Knowledge")
    .setDescription(M.description)
    .setContext({
      query: "",
      filesReadPaths: [],
      // Raw claim objects pushed by `staging` and drained by `addressing`.
      // Schema per claim: { content: string, sources: string[], draftEntities?: string[] }.
      // No store changes — staging is a pure context pattern.
      stagedClaims: [],
      // Populated by addressing's onEnter memory_browse hook so the
      // addressing instruction can prefer existing entity names.
      entities: [],
      // Populated by exploring's onEnter memory_by_source hook on every
      // node arrival — keyed by the file paths in context.filesReadPaths.
      // The agent uses this to stage only deltas (warm-exit emergence).
      priorKnowledgeByPath: {},
      priorKnowledgePathsConsidered: 0,
      priorKnowledgePathsTruncated: false,
      coverageSatisfied: false,
    })
    .node("exploring", {
      type: "action",
      description: M.nodes.exploring.description,
      instructions: M.nodes.exploring.instructions,
      // onEnter populates context with three things on every arrival:
      //  - memory_status: total/valid/stale proposition counts + total entities
      //  - memory_browse: page of existing entities (limit 50)
      //  - memory_by_source: priorKnowledgeByPath keyed by filesReadPaths
      // Together these replace three manual round-trips the agent
      // previously had to make — the agent arrives with everything it
      // needs to decide what to read next and stage only deltas.
      onEnter: [
        {
          call: "memory_status",
          args: {},
        },
        {
          call: "memory_browse",
          args: {
            limit: 50,
          },
        },
        {
          call: "memory_by_source",
          args: {
            paths: "context.filesReadPaths",
          },
        },
      ],
      edges: [
        {
          target: "staging",
          label: M.edges.filesRead.label,
          condition: "len(context.filesReadPaths) > 0",
          description: M.edges.filesRead.description,
        },
        // Warm-exit shortcut: when priorKnowledgeByPath already covers
        // the target files (agent sets coverageSatisfied=true from the
        // exploring node itself), skip staging/addressing/emit entirely
        // and route straight to the evaluating decision — which then
        // routes to complete on the same flag. Enables cold-start warm
        // runs when the agent passes filesReadPaths via initialContext.
        {
          target: "evaluating",
          label: M.edges.warmExit.label,
          condition: "context.coverageSatisfied == true",
          description: M.edges.warmExit.description,
        },
      ],
    })
    .node("staging", {
      type: "action",
      description: M.nodes.staging.description,
      instructions: M.nodes.staging.instructions,
      edges: [
        {
          target: "addressing",
          label: M.edges.claimsStaged.label,
          condition: "len(context.stagedClaims) > 0",
          description: M.edges.claimsStaged.description,
        },
      ],
    })
    .node("addressing", {
      type: "action",
      description: M.nodes.addressing.description,
      instructions: M.nodes.addressing.instructions,
      suggestedTools: ["memory_emit"],
      // onEnter populates context.entities with the existing vocabulary
      // so the addressing prose can ground its entity-reuse rules in
      // real names — replaces an agent round-trip that previously had
      // to call memory_browse manually.
      onEnter: [
        {
          call: "memory_browse",
          args: {
            limit: 50,
          },
        },
      ],
      edges: [
        {
          target: "evaluating",
          label: M.edges.propositionsEmitted.label,
          description: M.edges.propositionsEmitted.description,
        },
      ],
    })
    .node("evaluating", {
      type: "decision",
      description: M.nodes.evaluating.description,
      instructions: M.nodes.evaluating.instructions,
      edges: [
        {
          target: "complete",
          label: M.edges.coverageSatisfied.label,
          condition: "context.coverageSatisfied == true",
          description: M.edges.coverageSatisfied.description,
        },
        {
          target: "exploring",
          label: M.edges.gapsRemain.label,
          condition: "context.coverageSatisfied == false",
          description: M.edges.gapsRemain.description,
        },
      ],
    })
    .node("complete", {
      type: "terminal",
      description: M.nodes.complete.description,
    })
    .build();
}

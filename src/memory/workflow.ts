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
      // Populated by compiling's onEnter memory_browse hook so the
      // compiling instruction can prefer existing entity names.
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
      suggestedTools: ["Read", "freelance_context_set"],
      // Guard against runaway gaps-remain loops. Each return to
      // exploring is a deliberate "we missed coverage" lap; a sane
      // compile shouldn't need more than a few. Beyond this the
      // traversal errors out rather than burning infinite turns.
      maxTurns: 5,
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
          target: "compiling",
          label: M.edges.filesRead.label,
          condition: "len(context.filesReadPaths) > 0",
          description: M.edges.filesRead.description,
        },
        // Warm-exit shortcut: when priorKnowledgeByPath already covers
        // the target files (agent sets coverageSatisfied=true from the
        // exploring node itself), skip compiling/emit entirely and route
        // straight to the evaluating decision — which then routes to
        // complete on the same flag.
        {
          target: "evaluating",
          label: M.edges.warmExit.label,
          condition: "context.coverageSatisfied == true",
          description: M.edges.warmExit.description,
        },
      ],
    })
    .node("compiling", {
      type: "action",
      description: M.nodes.compiling.description,
      instructions: M.nodes.compiling.instructions,
      suggestedTools: ["memory_emit"],
      maxTurns: 3,
      // onEnter populates context.entities with the existing vocabulary
      // so the compiling prose can ground its entity-reuse rules in
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

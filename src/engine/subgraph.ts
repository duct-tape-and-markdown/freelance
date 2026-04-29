import { EC, EngineError } from "../errors.js";
import { evaluatePredicate } from "../evaluator.js";
import { resolveContextDefaults } from "../loader.js";
import type { NodeDefinition, SessionState, ValidatedGraph } from "../types.js";
import { buildAdvanceSuccessResult, keysSince, mergeDelta, requireGraph } from "./helpers.js";
import type { HookRunner, MetaCollector } from "./hooks.js";
import { evaluateTransitions } from "./transitions.js";

type SubgraphResult = ReturnType<typeof buildAdvanceSuccessResult>;

interface PushSubgraphArgs {
  stack: SessionState[];
  graphs: Map<string, ValidatedGraph>;
  previousNode: string;
  edge: string;
  newNodeDef: NodeDefinition;
  maxDepth: number;
  hookRunner: HookRunner;
  metaCollector?: MetaCollector;
  /** When true, caller wants the lean response shape. */
  minimal: boolean;
  /** Keys written this advance (caller updates ∪ hook writes in parent, before push). Only used on minimal shape. */
  contextDelta: readonly string[];
  /**
   * Optional save boundary invoked after the child session is pushed
   * onto the stack but BEFORE `onEnter` fires on the child's start
   * node. `TraversalStore.advance` threads its `saveEngine` through
   * here; a hook throw below then leaves disk with the child pushed
   * (next advance resumes from the child's start node, not the
   * parent's pre-push state). Direct engine callers omit the callback
   * and accept one-shot semantics.
   */
  persistBetween?: () => void;
}

export async function maybePushSubgraph(args: PushSubgraphArgs): Promise<SubgraphResult> {
  const {
    stack,
    graphs,
    previousNode,
    edge,
    newNodeDef,
    maxDepth,
    hookRunner,
    metaCollector,
    minimal,
    contextDelta,
    persistBetween,
  } = args;
  const parentSession = stack[stack.length - 1];
  const subgraph = newNodeDef.subgraph!;

  if (subgraph.condition) {
    if (!evaluatePredicate(subgraph.condition, parentSession.context)) {
      const parentGraph = requireGraph(graphs, parentSession.graphId);
      const parentDef = parentGraph.definition;
      const validTransitions = evaluateTransitions(newNodeDef, parentSession.context);
      return buildAdvanceSuccessResult(
        {
          status: "advanced",
          previousNode,
          edgeTaken: edge,
          currentNode: parentSession.currentNode,
          validTransitions,
        },
        minimal
          ? { contextDelta }
          : {
              node: newNodeDef,
              context: parentSession.context,
              graphSources: parentDef.sources,
            },
      );
    }
  }

  if (stack.length >= maxDepth) {
    throw new EngineError(
      `Maximum stack depth (${maxDepth}) exceeded. Cannot push subgraph '${subgraph.graphId}'. Simplify the workflow or increase maxDepth.`,
      EC.STACK_DEPTH_EXCEEDED,
    );
  }

  const childGraph = requireGraph(graphs, subgraph.graphId);
  const childDef = childGraph.definition;
  const childContext: Record<string, unknown> = {
    ...resolveContextDefaults(childDef.context ?? {}),
    ...(subgraph.initialContext ?? {}),
  };

  if (subgraph.contextMap) {
    for (const [parentKey, childKey] of Object.entries(subgraph.contextMap)) {
      if (parentKey in parentSession.context) {
        childContext[childKey] = parentSession.context[parentKey];
      }
    }
  }

  stack.push({
    graphId: subgraph.graphId,
    currentNode: childDef.startNode,
    context: childContext,
    history: [],
    contextHistory: [],
    turnCount: 0,
    startedAt: new Date().toISOString(),
  });

  // Save boundary between child push and child-start onEnter. When
  // TraversalStore threads a callback here, a hook throw below leaves
  // disk reflecting the pushed child (next advance runs on the
  // child's start node). Direct engine callers omit the callback and
  // get one-shot semantics.
  persistBetween?.();

  const activeSession = stack[stack.length - 1];

  // Fire onEnter for the pushed child's start node before snapshotting
  // context into the response — mirrors how engine.start() runs hooks.
  // Snapshot childHistory length first so minimal-shape responses can
  // surface any hook-written keys as part of `contextDelta`.
  const childWritesBefore = minimal ? activeSession.contextHistory.length : 0;
  await hookRunner.runHooksFor(
    activeSession,
    childDef,
    childDef.startNode,
    childGraph.hookResolutions,
    metaCollector,
  );

  const childStartNode = childDef.nodes[childDef.startNode];
  const validTransitions = evaluateTransitions(childStartNode, activeSession.context);
  const subgraphPushed = {
    graphId: subgraph.graphId,
    startNode: childDef.startNode,
    stackDepth: stack.length,
  };

  return buildAdvanceSuccessResult(
    {
      status: "advanced",
      previousNode,
      edgeTaken: edge,
      currentNode: childDef.startNode,
      subgraphPushed,
      validTransitions,
    },
    minimal
      ? {
          contextDelta: mergeDelta(
            contextDelta,
            keysSince(activeSession.contextHistory, childWritesBefore),
          ),
        }
      : {
          node: childStartNode,
          context: activeSession.context,
          graphSources: childDef.sources,
        },
  );
}

interface PopSubgraphArgs {
  stack: SessionState[];
  graphs: Map<string, ValidatedGraph>;
  previousNode: string;
  edge: string;
  minimal: boolean;
  contextDelta: readonly string[];
}

export function popSubgraph(args: PopSubgraphArgs): SubgraphResult {
  const { stack, graphs, previousNode, edge, minimal, contextDelta } = args;
  const childSession = stack[stack.length - 1];
  const completedGraphId = childSession.graphId;

  stack.pop();

  const parentSession = stack[stack.length - 1];
  const parentGraph = requireGraph(graphs, parentSession.graphId);
  const parentDef = parentGraph.definition;
  const parentNodeDef = parentDef.nodes[parentSession.currentNode];
  const subgraphDef = parentNodeDef.subgraph!;

  const returnedContext: Record<string, unknown> = {};
  if (subgraphDef.returnMap) {
    for (const [childKey, parentKey] of Object.entries(subgraphDef.returnMap)) {
      if (childKey in childSession.context) {
        const value = childSession.context[childKey];
        parentSession.context[parentKey] = value;
        returnedContext[parentKey] = value;
        parentSession.contextHistory.push({
          key: parentKey,
          value,
          setAt: parentSession.currentNode,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  const validTransitions = evaluateTransitions(parentNodeDef, parentSession.context);

  return buildAdvanceSuccessResult(
    {
      status: "subgraph_complete",
      previousNode,
      edgeTaken: edge,
      currentNode: parentSession.currentNode,
      completedGraph: completedGraphId,
      returnedContext,
      stackDepth: stack.length,
      resumedNode: parentSession.currentNode,
      validTransitions,
    },
    minimal
      ? {
          contextDelta: mergeDelta(contextDelta, Object.keys(returnedContext)),
        }
      : {
          node: parentNodeDef,
          context: parentSession.context,
          graphSources: parentDef.sources,
        },
  );
}

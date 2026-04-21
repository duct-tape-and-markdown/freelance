import { EC, EngineError } from "../errors.js";
import { evaluate } from "../evaluator.js";
import { resolveContextDefaults } from "../loader.js";
import type {
  AdvanceSuccessMinimalResult,
  AdvanceSuccessResult,
  NodeDefinition,
  SessionState,
  ValidatedGraph,
} from "../types.js";
import { cloneContext, keysSince, mergeDelta, toNodeInfo } from "./helpers.js";
import type { HookRunner, MetaCollector } from "./hooks.js";
import { evaluateTransitions } from "./transitions.js";

type SubgraphResult = AdvanceSuccessResult | AdvanceSuccessMinimalResult;

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
  } = args;
  const parentSession = stack[stack.length - 1];
  const subgraph = newNodeDef.subgraph!;

  if (subgraph.condition) {
    let condMet: boolean;
    try {
      condMet = evaluate(subgraph.condition, parentSession.context);
    } catch {
      condMet = false;
    }
    if (!condMet) {
      const parentGraph = graphs.get(parentSession.graphId);
      if (!parentGraph) {
        throw new EngineError(`Graph "${parentSession.graphId}" not found`, EC.GRAPH_NOT_FOUND);
      }
      const parentDef = parentGraph.definition;
      const validTransitions = evaluateTransitions(newNodeDef, parentSession.context);
      if (minimal) {
        return {
          status: "advanced",
          isError: false,
          previousNode,
          edgeTaken: edge,
          currentNode: parentSession.currentNode,
          validTransitions,
          contextDelta,
        } satisfies AdvanceSuccessMinimalResult;
      }
      return {
        status: "advanced",
        isError: false,
        previousNode,
        edgeTaken: edge,
        currentNode: parentSession.currentNode,
        node: toNodeInfo(newNodeDef),
        validTransitions,
        context: cloneContext(parentSession.context),
        ...(parentDef.sources?.length ? { graphSources: parentDef.sources } : {}),
      };
    }
  }

  if (stack.length >= maxDepth) {
    throw new EngineError(
      `Maximum stack depth (${maxDepth}) exceeded. Cannot push subgraph '${subgraph.graphId}'. Simplify the workflow or increase maxDepth.`,
      EC.STACK_DEPTH_EXCEEDED,
    );
  }

  const childGraph = graphs.get(subgraph.graphId);
  if (!childGraph) {
    throw new EngineError(
      `Subgraph '${subgraph.graphId}' not found in loaded graphs.`,
      EC.GRAPH_NOT_FOUND,
    );
  }

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

  if (minimal) {
    return {
      status: "advanced",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: childDef.startNode,
      subgraphPushed,
      validTransitions,
      contextDelta: mergeDelta(
        contextDelta,
        keysSince(activeSession.contextHistory, childWritesBefore),
      ),
    } satisfies AdvanceSuccessMinimalResult;
  }

  return {
    status: "advanced",
    isError: false,
    previousNode,
    edgeTaken: edge,
    currentNode: childDef.startNode,
    subgraphPushed,
    node: toNodeInfo(childStartNode),
    validTransitions,
    context: cloneContext(activeSession.context),
    ...(childDef.sources?.length ? { graphSources: childDef.sources } : {}),
  };
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
  const parentGraph = graphs.get(parentSession.graphId);
  if (!parentGraph) {
    throw new EngineError(`Graph "${parentSession.graphId}" not found`, EC.GRAPH_NOT_FOUND);
  }
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

  if (minimal) {
    return {
      status: "subgraph_complete",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: parentSession.currentNode,
      completedGraph: completedGraphId,
      returnedContext,
      stackDepth: stack.length,
      resumedNode: parentSession.currentNode,
      validTransitions,
      contextDelta: mergeDelta(contextDelta, Object.keys(returnedContext)),
    } satisfies AdvanceSuccessMinimalResult;
  }

  return {
    status: "subgraph_complete",
    isError: false,
    previousNode,
    edgeTaken: edge,
    currentNode: parentSession.currentNode,
    completedGraph: completedGraphId,
    returnedContext,
    stackDepth: stack.length,
    resumedNode: parentSession.currentNode,
    node: toNodeInfo(parentNodeDef),
    validTransitions,
    context: cloneContext(parentSession.context),
    ...(parentDef.sources?.length ? { graphSources: parentDef.sources } : {}),
  };
}

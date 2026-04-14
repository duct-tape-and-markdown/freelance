import { EngineError } from "../errors.js";
import { evaluate } from "../evaluator.js";
import { resolveContextDefaults } from "../loader.js";
import type {
  AdvanceSuccessResult,
  NodeDefinition,
  SessionState,
  ValidatedGraph,
} from "../types.js";
import { cloneContext, toNodeInfo } from "./helpers.js";
import type { OpContext, OpsRegistry } from "./operations.js";
import { drainProgrammaticChain } from "./programmatic.js";
import { evaluateTransitions } from "./transitions.js";

interface PushSubgraphArgs {
  stack: SessionState[];
  graphs: Map<string, ValidatedGraph>;
  previousNode: string;
  edge: string;
  newNodeDef: NodeDefinition;
  maxDepth: number;
  opsRegistry?: OpsRegistry;
  opContext?: OpContext;
}

export function maybePushSubgraph(args: PushSubgraphArgs): AdvanceSuccessResult {
  const { stack, graphs, previousNode, edge, newNodeDef, maxDepth, opsRegistry, opContext } = args;
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
        throw new EngineError(`Graph "${parentSession.graphId}" not found`, "GRAPH_NOT_FOUND");
      }
      const parentDef = parentGraph.definition;
      return {
        status: "advanced",
        isError: false,
        previousNode,
        edgeTaken: edge,
        currentNode: parentSession.currentNode,
        node: toNodeInfo(newNodeDef),
        validTransitions: evaluateTransitions(newNodeDef, parentSession.context),
        context: cloneContext(parentSession.context),
        ...(parentDef.sources?.length ? { graphSources: parentDef.sources } : {}),
      };
    }
  }

  if (stack.length >= maxDepth) {
    throw new EngineError(
      `Maximum stack depth (${maxDepth}) exceeded. Cannot push subgraph '${subgraph.graphId}'. Simplify the workflow or increase maxDepth.`,
      "STACK_DEPTH_EXCEEDED",
    );
  }

  const childGraph = graphs.get(subgraph.graphId);
  if (!childGraph) {
    throw new EngineError(
      `Subgraph '${subgraph.graphId}' not found in loaded graphs.`,
      "GRAPH_NOT_FOUND",
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

  // Drain programmatic chain at the child's startNode — the agent never
  // sees a programmatic node as an arrival point, including when it's the
  // first node of a child subgraph. Without this, embedding a workflow
  // whose startNode is programmatic silently skips the drain.
  drainProgrammaticChain(activeSession, childDef, opsRegistry, opContext);

  const landedNode = childDef.nodes[activeSession.currentNode];
  if (landedNode.type === "wait" && landedNode.waitOn) {
    activeSession.waitArrivedAt = new Date().toISOString();
  }

  return {
    status: "advanced",
    isError: false,
    previousNode,
    edgeTaken: edge,
    currentNode: activeSession.currentNode,
    subgraphPushed: {
      graphId: subgraph.graphId,
      startNode: childDef.startNode,
      stackDepth: stack.length,
    },
    node: toNodeInfo(landedNode),
    validTransitions: evaluateTransitions(landedNode, activeSession.context),
    context: cloneContext(activeSession.context),
    ...(childDef.sources?.length ? { graphSources: childDef.sources } : {}),
  };
}

export function popSubgraph(
  stack: SessionState[],
  graphs: Map<string, ValidatedGraph>,
  previousNode: string,
  edge: string,
): AdvanceSuccessResult {
  const childSession = stack[stack.length - 1];
  const completedGraphId = childSession.graphId;

  stack.pop();

  const parentSession = stack[stack.length - 1];
  const parentGraph = graphs.get(parentSession.graphId);
  if (!parentGraph) {
    throw new EngineError(`Graph "${parentSession.graphId}" not found`, "GRAPH_NOT_FOUND");
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
    validTransitions: evaluateTransitions(parentNodeDef, parentSession.context),
    context: cloneContext(parentSession.context),
    ...(parentDef.sources?.length ? { graphSources: parentDef.sources } : {}),
  };
}

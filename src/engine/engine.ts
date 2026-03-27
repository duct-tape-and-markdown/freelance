import { EngineError } from "../errors.js";
import { cloneContext, toNodeInfo } from "./helpers.js";
import { evaluateTransitions } from "./transitions.js";
import { checkWaitBlocking, checkReturnSchema, checkValidations, checkEdgeCondition } from "./gates.js";
import { maybePushSubgraph, popSubgraph } from "./subgraph.js";
import { applyContextUpdates, enforceStrictContext, buildContextSetResult, buildInspectResult } from "./state.js";
import { evaluateWaitConditions, computeTimeoutAt } from "./wait.js";
import type {
  ValidatedGraph,
  GraphListResult,
  StartResult,
  AdvanceResult,
  AdvanceSuccessResult,
  ContextSetResult,
  InspectResult,
  ResetResult,
  SessionState,
} from "../types.js";

export class GraphEngine {
  private stack: SessionState[] = [];
  private maxDepth: number;

  constructor(
    private graphs: Map<string, ValidatedGraph>,
    options?: { maxDepth?: number }
  ) {
    this.maxDepth = options?.maxDepth ?? 5;
  }

  list(): GraphListResult {
    const graphs = [...this.graphs.values()].map((g) => ({
      id: g.definition.id,
      name: g.definition.name,
      version: g.definition.version,
      description: g.definition.description,
    }));
    return { graphs };
  }

  start(
    graphId: string,
    initialContext?: Record<string, unknown>
  ): StartResult {
    if (this.stack.length > 0) {
      throw new EngineError(
        "A traversal is already active. Call reset() first.",
        "TRAVERSAL_ACTIVE"
      );
    }

    const graph = this.graphs.get(graphId);
    if (!graph) {
      throw new EngineError(
        `Graph "${graphId}" not found`,
        "GRAPH_NOT_FOUND"
      );
    }

    const def = graph.definition;
    const context: Record<string, unknown> = {
      ...(def.context ?? {}),
      ...(initialContext ?? {}),
    };

    this.stack.push({
      graphId,
      currentNode: def.startNode,
      context,
      history: [],
      contextHistory: [],
      turnCount: 0,
      startedAt: new Date().toISOString(),
    });

    const node = def.nodes[def.startNode];
    return {
      status: "started",
      isError: false,
      graphId,
      currentNode: def.startNode,
      node: toNodeInfo(node),
      validTransitions: evaluateTransitions(node, context),
      context: cloneContext(context),
      ...(def.sources && def.sources.length > 0 ? { graphSources: def.sources } : {}),
    } satisfies StartResult;
  }

  advance(
    edge: string,
    contextUpdates?: Record<string, unknown>
  ): AdvanceResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();
    const currentNodeDef = def.nodes[session.currentNode];

    if (contextUpdates) {
      applyContextUpdates(session, contextUpdates);
      session.turnCount++;
    }

    // Pre-advance gate checks
    const waitBlock = checkWaitBlocking(session, currentNodeDef);
    if (waitBlock) return waitBlock;

    const returnBlock = checkReturnSchema(session, currentNodeDef);
    if (returnBlock) return returnBlock;

    const validationBlock = checkValidations(session, currentNodeDef);
    if (validationBlock) return validationBlock;

    // Find and validate edge
    if (!currentNodeDef.edges) {
      throw new EngineError(
        `Node "${session.currentNode}" is a terminal node with no outgoing edges`,
        "NO_EDGES"
      );
    }
    const edgeDef = currentNodeDef.edges.find((e) => e.label === edge);
    if (!edgeDef) {
      throw new EngineError(
        `Edge "${edge}" not found on node "${session.currentNode}". ` +
          `Available edges: ${currentNodeDef.edges.map((e: { label: string }) => e.label).join(", ")}`,
        "EDGE_NOT_FOUND"
      );
    }

    if (edgeDef.condition) {
      const condBlock = checkEdgeCondition(session, currentNodeDef, edgeDef.condition, edge);
      if (condBlock) return condBlock;
    }

    // Record history and advance
    const previousNode = session.currentNode;
    session.history.push({
      node: previousNode,
      edge,
      timestamp: new Date().toISOString(),
      contextSnapshot: cloneContext(session.context),
    });
    session.currentNode = edgeDef.target;
    session.turnCount = 0;

    const newNodeDef = def.nodes[session.currentNode];
    const isTerminal = newNodeDef.type === "terminal";
    const isWait = newNodeDef.type === "wait";

    // Subgraph transitions
    if (isTerminal && this.stack.length > 1) {
      return popSubgraph(this.stack, this.graphs, previousNode, edge);
    }
    if (!isTerminal && !isWait && newNodeDef.subgraph) {
      return maybePushSubgraph(this.stack, this.graphs, previousNode, edge, newNodeDef, this.maxDepth);
    }

    // Wait node arrival
    if (isWait && newNodeDef.waitOn) {
      session.waitArrivedAt = new Date().toISOString();
      const waitConditions = evaluateWaitConditions(newNodeDef.waitOn, session.context);
      const timeoutAt = computeTimeoutAt(session.waitArrivedAt, newNodeDef.timeout);

      return {
        status: "waiting",
        isError: false,
        previousNode,
        edgeTaken: edge,
        currentNode: session.currentNode,
        node: toNodeInfo(newNodeDef),
        validTransitions: evaluateTransitions(newNodeDef, session.context),
        context: cloneContext(session.context),
        waitingOn: waitConditions,
        ...(newNodeDef.timeout ? { timeout: newNodeDef.timeout } : {}),
        ...(timeoutAt ? { timeoutAt } : {}),
      } satisfies AdvanceSuccessResult;
    }

    // Standard advance or terminal
    return {
      status: isTerminal ? "complete" : "advanced",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: session.currentNode,
      node: toNodeInfo(newNodeDef),
      validTransitions: evaluateTransitions(newNodeDef, session.context),
      context: cloneContext(session.context),
      ...(isTerminal
        ? {
            traversalHistory: [
              ...session.history.map((h) => h.node),
              session.currentNode,
            ],
          }
        : {}),
    } satisfies AdvanceSuccessResult;
  }

  contextSet(updates: Record<string, unknown>): ContextSetResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();

    enforceStrictContext(def, updates);
    applyContextUpdates(session, updates);
    session.turnCount++;

    return buildContextSetResult(session, def.nodes[session.currentNode]);
  }

  inspect(detail: "position" | "full" | "history" = "position"): InspectResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();
    return buildInspectResult(detail, session, def, this.stack);
  }

  reset(): ResetResult {
    if (this.stack.length === 0) {
      return {
        status: "reset",
        previousGraph: null,
        previousNode: null,
        message: "No traversal was active.",
      } satisfies ResetResult;
    }

    const clearedStack = this.stack.map((s) => ({
      graphId: s.graphId,
      node: s.currentNode,
    }));

    const root = this.stack[0];
    const prev = {
      graphId: root.graphId,
      node: root.currentNode,
    };
    this.stack = [];

    if (clearedStack.length > 1) {
      return {
        status: "reset",
        previousGraph: prev.graphId,
        previousNode: prev.node,
        message: `Traversal stack cleared (${clearedStack.length} graphs). Call freelance_start to begin a new workflow.`,
        clearedStack,
      } satisfies ResetResult;
    }

    return {
      status: "reset",
      previousGraph: prev.graphId,
      previousNode: prev.node,
      message:
        "Traversal cleared. Call freelance_start to begin a new workflow.",
    } satisfies ResetResult;
  }

  // --- Serialization (for persistence) ---

  getStack(): SessionState[] {
    return structuredClone(this.stack);
  }

  restoreStack(stack: SessionState[]): void {
    this.stack = structuredClone(stack);
  }

  hasActiveTraversal(): boolean {
    return this.stack.length > 0;
  }

  // --- Private helpers ---

  private activeSession(): SessionState {
    return this.stack[this.stack.length - 1];
  }

  private requireSession(): SessionState {
    if (this.stack.length === 0) {
      throw new EngineError(
        "No traversal active. Call start() first.",
        "NO_TRAVERSAL"
      );
    }
    return this.activeSession();
  }

  private currentGraphDef() {
    const graph = this.graphs.get(this.activeSession().graphId);
    if (!graph) {
      throw new EngineError(
        `Graph "${this.activeSession().graphId}" not found`,
        "GRAPH_NOT_FOUND"
      );
    }
    return graph.definition;
  }
}

import { evaluate } from "../evaluator.js";
import { EngineError } from "../errors.js";
import { cloneContext, toNodeInfo } from "./helpers.js";
import { validateReturnSchema } from "./returns.js";
import { evaluateWaitConditions, checkWaitTimeout, computeTimeoutAt } from "./wait.js";
import type {
  ValidatedGraph,
  NodeDefinition,
  WaitCondition,
  TransitionInfo,
  GraphListResult,
  StartResult,
  AdvanceResult,
  AdvanceSuccessResult,
  AdvanceErrorResult,
  ContextSetResult,
  InspectResult,
  InspectPositionResult,
  InspectHistoryResult,
  InspectFullResult,
  ResetResult,
  SessionState,
  StackEntry,
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
      validTransitions: this.evaluateTransitions(node),
      context: cloneContext(this.activeSession().context),
    } satisfies StartResult;
  }

  advance(
    edge: string,
    contextUpdates?: Record<string, unknown>
  ): AdvanceResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();
    const currentNodeDef = def.nodes[session.currentNode];

    // Apply context updates first (persist regardless of outcome)
    if (contextUpdates) {
      this.applyContextUpdates(contextUpdates);
      session.turnCount++;
    }

    // Wait node blocking — check if conditions are satisfied
    if (currentNodeDef.type === "wait" && currentNodeDef.waitOn) {
      const timedOut = checkWaitTimeout(session, currentNodeDef);
      if (!timedOut) {
        const waitConditions = evaluateWaitConditions(currentNodeDef.waitOn, session.context);
        const allSatisfied = waitConditions.every((w) => w.satisfied);
        if (!allSatisfied) {
          const unsatisfied = waitConditions.filter((w) => !w.satisfied);
          return {
            status: "error",
            isError: true,
            currentNode: session.currentNode,
            reason: `Waiting for external signals: ${unsatisfied.map((w) => `${w.key} (${w.type})`).join(", ")}`,
            validTransitions: this.evaluateTransitions(currentNodeDef),
            context: cloneContext(session.context),
          } satisfies AdvanceErrorResult;
        }
      }
    }

    // Validate return schema (structural contract)
    if (currentNodeDef.returns) {
      const violation = validateReturnSchema(currentNodeDef.returns, session.context);
      if (violation) {
        return {
          status: "error",
          isError: true,
          currentNode: session.currentNode,
          reason: `Return schema violation: ${violation}`,
          validTransitions: this.evaluateTransitions(currentNodeDef),
          context: cloneContext(session.context),
        } satisfies AdvanceErrorResult;
      }
    }

    // Check validations on current node
    if (currentNodeDef.validations && currentNodeDef.validations.length > 0) {
      for (const v of currentNodeDef.validations) {
        let result: boolean;
        try {
          result = evaluate(v.expr, session.context);
        } catch {
          result = false;
        }
        if (!result) {
          return {
            status: "error",
            isError: true,
            currentNode: session.currentNode,
            reason: `Validation failed: ${v.message}`,
            validTransitions: this.evaluateTransitions(currentNodeDef),
            context: cloneContext(session.context),
          } satisfies AdvanceErrorResult;
        }
      }
    }

    // Find edge by label (terminal nodes have no edges)
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

    // Evaluate edge condition
    if (edgeDef.condition) {
      let condMet: boolean;
      try {
        condMet = evaluate(edgeDef.condition, session.context);
      } catch {
        condMet = false;
      }
      if (!condMet) {
        return {
          status: "error",
          isError: true,
          currentNode: session.currentNode,
          reason: `Edge "${edge}" condition not met: ${edgeDef.condition}`,
          validTransitions: this.evaluateTransitions(currentNodeDef),
          context: cloneContext(session.context),
        } satisfies AdvanceErrorResult;
      }
    }

    // Advance
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

    // Check if we've reached a terminal node in a child graph (pop)
    if (isTerminal && this.stack.length > 1) {
      return this.popSubgraph(previousNode, edge, newNodeDef);
    }

    // Check if the new node has a subgraph to push
    if (!isTerminal && !isWait && newNodeDef.subgraph) {
      return this.maybePushSubgraph(previousNode, edge, newNodeDef);
    }

    // Arriving at a wait node — record arrival time and return "waiting" status
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
        validTransitions: this.evaluateTransitions(newNodeDef),
        context: cloneContext(session.context),
        waitingOn: waitConditions,
        ...(newNodeDef.timeout ? { timeout: newNodeDef.timeout } : {}),
        ...(timeoutAt ? { timeoutAt } : {}),
      } satisfies AdvanceSuccessResult;
    }

    return {
      status: isTerminal ? "complete" : "advanced",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: session.currentNode,
      node: toNodeInfo(newNodeDef),
      validTransitions: this.evaluateTransitions(newNodeDef),
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

    if (def.strictContext) {
      const declaredKeys = new Set(Object.keys(def.context ?? {}));
      for (const key of Object.keys(updates)) {
        if (!declaredKeys.has(key)) {
          throw new EngineError(
            `Key "${key}" is not declared in the graph's context schema (strictContext is enabled)`,
            "STRICT_CONTEXT_VIOLATION"
          );
        }
      }
    }

    this.applyContextUpdates(updates);
    session.turnCount++;

    const currentNodeDef = def.nodes[session.currentNode];
    const turnWarning =
      currentNodeDef.maxTurns && session.turnCount >= currentNodeDef.maxTurns
        ? `Turn budget reached (${session.turnCount}/${currentNodeDef.maxTurns}). Consider wrapping up and advancing to the next node.`
        : null;

    return {
      status: "updated",
      isError: false,
      currentNode: session.currentNode,
      context: cloneContext(session.context),
      validTransitions: this.evaluateTransitions(currentNodeDef),
      turnCount: session.turnCount,
      turnWarning,
    } satisfies ContextSetResult;
  }

  inspect(detail: "position" | "full" | "history" = "position"): InspectResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();

    if (detail === "history") {
      return {
        graphId: session.graphId,
        currentNode: session.currentNode,
        traversalHistory: session.history,
        contextHistory: session.contextHistory,
      } satisfies InspectHistoryResult;
    }

    if (detail === "full") {
      return {
        graphId: session.graphId,
        currentNode: session.currentNode,
        definition: def,
        context: cloneContext(session.context),
      } satisfies InspectFullResult;
    }

    // position (default)
    const currentNodeDef = def.nodes[session.currentNode];
    const turnWarning =
      currentNodeDef.maxTurns && session.turnCount >= currentNodeDef.maxTurns
        ? `Turn budget reached (${session.turnCount}/${currentNodeDef.maxTurns}). Consider wrapping up and advancing to the next node.`
        : null;

    let waitInfo: {
      waitStatus?: "waiting" | "ready" | "timed_out";
      waitingOn?: WaitCondition[];
      timeout?: string;
      timeoutAt?: string;
    } = {};
    if (currentNodeDef.type === "wait" && currentNodeDef.waitOn) {
      const timedOut = checkWaitTimeout(session, currentNodeDef);
      const waitConditions = evaluateWaitConditions(currentNodeDef.waitOn, session.context);
      const allSatisfied = waitConditions.every((w) => w.satisfied);

      let waitStatus: "waiting" | "ready" | "timed_out";
      if (timedOut) {
        waitStatus = "timed_out";
      } else if (allSatisfied) {
        waitStatus = "ready";
      } else {
        waitStatus = "waiting";
      }

      const timeoutAt = session.waitArrivedAt
        ? computeTimeoutAt(session.waitArrivedAt, currentNodeDef.timeout)
        : undefined;

      waitInfo = {
        waitStatus,
        waitingOn: waitConditions,
        ...(currentNodeDef.timeout ? { timeout: currentNodeDef.timeout } : {}),
        ...(timeoutAt ? { timeoutAt } : {}),
      };
    }

    return {
      graphId: session.graphId,
      graphName: def.name,
      currentNode: session.currentNode,
      node: toNodeInfo(currentNodeDef),
      validTransitions: this.evaluateTransitions(currentNodeDef),
      context: cloneContext(session.context),
      turnCount: session.turnCount,
      turnWarning,
      stackDepth: this.stack.length,
      stack: this.buildStackView(),
      ...waitInfo,
    } satisfies InspectPositionResult;
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
        message: `Traversal stack cleared (${clearedStack.length} graphs). Call graph_start to begin a new workflow.`,
        clearedStack,
      } satisfies ResetResult;
    }

    return {
      status: "reset",
      previousGraph: prev.graphId,
      previousNode: prev.node,
      message:
        "Traversal cleared. Call graph_start to begin a new workflow.",
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
    return this.graphs.get(this.activeSession().graphId)!.definition;
  }

  private applyContextUpdates(updates: Record<string, unknown>) {
    const session = this.activeSession();
    const timestamp = new Date().toISOString();
    for (const [key, value] of Object.entries(updates)) {
      session.context[key] = value;
      session.contextHistory.push({
        key,
        value,
        setAt: session.currentNode,
        timestamp,
      });
    }
  }

  private evaluateTransitions(node: NodeDefinition): TransitionInfo[] {
    if (!node.edges) return [];
    const edges = node.edges;
    const session = this.activeSession();

    interface MutableTransition {
      label: string;
      target: string;
      condition?: string;
      description?: string;
      conditionMet: boolean;
      isDefault: boolean;
    }

    const results: MutableTransition[] = edges.map((e) => {
      let conditionMet: boolean;
      if (e.default) {
        conditionMet = false;
      } else if (e.condition) {
        try {
          conditionMet = evaluate(e.condition, session.context);
        } catch {
          conditionMet = false;
        }
      } else {
        conditionMet = true;
      }

      return {
        label: e.label,
        target: e.target,
        ...(e.condition ? { condition: e.condition } : {}),
        ...(e.description ? { description: e.description } : {}),
        conditionMet,
        isDefault: !!e.default,
      };
    });

    const anyConditionalMet = results.some(
      (r) => !r.isDefault && r.conditionMet && edges.find((e) => e.label === r.label)?.condition
    );

    for (const r of results) {
      if (r.isDefault) {
        r.conditionMet = !anyConditionalMet;
      }
    }

    return results.map(({ isDefault, ...rest }): TransitionInfo => rest);
  }

  private buildStackView(): StackEntry[] {
    return this.stack.map((s, i) => {
      if (i === this.stack.length - 1) {
        return { graphId: s.graphId, currentNode: s.currentNode };
      }
      return { graphId: s.graphId, suspendedAt: s.currentNode };
    });
  }

  private maybePushSubgraph(
    previousNode: string,
    edge: string,
    newNodeDef: NodeDefinition
  ): AdvanceSuccessResult {
    const parentSession = this.activeSession();
    const subgraph = newNodeDef.subgraph!;

    if (subgraph.condition) {
      let condMet: boolean;
      try {
        condMet = evaluate(subgraph.condition, parentSession.context);
      } catch {
        condMet = false;
      }
      if (!condMet) {
        return {
          status: "advanced",
          isError: false,
          previousNode,
          edgeTaken: edge,
          currentNode: parentSession.currentNode,
          node: toNodeInfo(newNodeDef),
          validTransitions: this.evaluateTransitions(newNodeDef),
          context: cloneContext(parentSession.context),
        };
      }
    }

    if (this.stack.length >= this.maxDepth) {
      throw new EngineError(
        `Maximum stack depth (${this.maxDepth}) exceeded. Cannot push subgraph '${subgraph.graphId}'. Simplify the workflow or increase maxDepth.`,
        "STACK_DEPTH_EXCEEDED"
      );
    }

    const childGraph = this.graphs.get(subgraph.graphId);
    if (!childGraph) {
      throw new EngineError(
        `Subgraph '${subgraph.graphId}' not found in loaded graphs.`,
        "GRAPH_NOT_FOUND"
      );
    }

    const childDef = childGraph.definition;
    const childContext: Record<string, unknown> = {
      ...(childDef.context ?? {}),
      ...(subgraph.initialContext ?? {}),
    };

    if (subgraph.contextMap) {
      for (const [parentKey, childKey] of Object.entries(subgraph.contextMap)) {
        if (parentKey in parentSession.context) {
          childContext[childKey] = parentSession.context[parentKey];
        }
      }
    }

    this.stack.push({
      graphId: subgraph.graphId,
      currentNode: childDef.startNode,
      context: childContext,
      history: [],
      contextHistory: [],
      turnCount: 0,
      startedAt: new Date().toISOString(),
    });

    const childStartNode = childDef.nodes[childDef.startNode];

    return {
      status: "advanced",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: childDef.startNode,
      subgraphPushed: {
        graphId: subgraph.graphId,
        startNode: childDef.startNode,
        stackDepth: this.stack.length,
      },
      node: toNodeInfo(childStartNode),
      validTransitions: this.evaluateTransitions(childStartNode),
      context: cloneContext(this.activeSession().context),
    } satisfies AdvanceSuccessResult;
  }

  private popSubgraph(
    previousNode: string,
    edge: string,
    terminalNodeDef: NodeDefinition
  ): AdvanceSuccessResult {
    const childSession = this.activeSession();
    const completedGraphId = childSession.graphId;

    this.stack.pop();

    const parentSession = this.activeSession();
    const parentDef = this.currentGraphDef();
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
      stackDepth: this.stack.length,
      resumedNode: parentSession.currentNode,
      node: toNodeInfo(parentNodeDef),
      validTransitions: this.evaluateTransitions(parentNodeDef),
      context: cloneContext(parentSession.context),
    } satisfies AdvanceSuccessResult;
  }
}

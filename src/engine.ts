import { evaluate } from "./evaluator.js";
import { EngineError } from "./errors.js";
import type {
  ValidatedGraph,
  NodeDefinition,
  ReturnField,
  WaitOnEntry,
  WaitCondition,
  TransitionInfo,
  NodeInfo,
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
} from "./types.js";

function cloneContext(ctx: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(ctx);
}

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

    // Step 2: Apply context updates first (persist regardless of outcome)
    if (contextUpdates) {
      this.applyContextUpdates(contextUpdates);
      session.turnCount++;
    }

    // Step 2.5: Wait node blocking — check if conditions are satisfied
    if (currentNodeDef.type === "wait" && currentNodeDef.waitOn) {
      // Check timeout first
      const timedOut = this.checkWaitTimeout(session, currentNodeDef);
      if (!timedOut) {
        const waitConditions = this.evaluateWaitConditions(currentNodeDef.waitOn, session.context);
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

    // Step 3a: Validate return schema (structural contract)
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

    // Step 3b: Check validations on current node
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

    // Step 4: Find edge by label (defensive: check for zero edges)
    const edges = currentNodeDef.edges ?? [];
    if (edges.length === 0) {
      throw new EngineError(
        `Node "${session.currentNode}" has no outgoing edges`,
        "NO_EDGES"
      );
    }
    const edgeDef = edges.find((e) => e.label === edge);
    if (!edgeDef) {
      throw new EngineError(
        `Edge "${edge}" not found on node "${session.currentNode}". ` +
          `Available edges: ${edges.map((e) => e.label).join(", ")}`,
        "EDGE_NOT_FOUND"
      );
    }

    // Step 5: Evaluate edge condition
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

    // Step 6: Advance
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
      const waitConditions = this.evaluateWaitConditions(newNodeDef.waitOn, session.context);
      const timeoutAt = this.computeTimeoutAt(session.waitArrivedAt, newNodeDef.timeout);

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

    // Strict context check
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

    // Wait node status
    let waitInfo: {
      waitStatus?: "waiting" | "ready" | "timed_out";
      waitingOn?: WaitCondition[];
      timeout?: string;
      timeoutAt?: string;
    } = {};
    if (currentNodeDef.type === "wait" && currentNodeDef.waitOn) {
      // Check timeout (may set _waitTimedOut in context)
      const timedOut = this.checkWaitTimeout(session, currentNodeDef);
      const waitConditions = this.evaluateWaitConditions(currentNodeDef.waitOn, session.context);
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
        ? this.computeTimeoutAt(session.waitArrivedAt, currentNodeDef.timeout)
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
    const edges = node.edges ?? [];
    const session = this.activeSession();

    // Mutable intermediate type for computation before freezing into readonly TransitionInfo
    interface MutableTransition {
      label: string;
      target: string;
      condition?: string;
      description?: string;
      conditionMet: boolean;
      isDefault: boolean;
    }

    // Evaluate conditions for all non-default edges first
    const results: MutableTransition[] = edges.map((e) => {
      let conditionMet: boolean;
      if (e.default) {
        conditionMet = false; // placeholder, resolved below
      } else if (e.condition) {
        try {
          conditionMet = evaluate(e.condition, session.context);
        } catch {
          conditionMet = false;
        }
      } else {
        conditionMet = true; // no condition = always available
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

    // Default edge is available when no explicitly conditional sibling edge is met.
    // Unconditional edges (no condition property) don't suppress the default —
    // they're always-available paths, not "matched" conditions.
    const anyConditionalMet = results.some(
      (r) => !r.isDefault && r.conditionMet && edges.find((e) => e.label === r.label)?.condition
    );

    for (const r of results) {
      if (r.isDefault) {
        r.conditionMet = !anyConditionalMet;
      }
    }

    // Strip isDefault from the output
    return results.map(({ isDefault, ...rest }): TransitionInfo => rest);
  }

  private evaluateWaitConditions(
    waitOn: WaitOnEntry[],
    context: Record<string, unknown>
  ): WaitCondition[] {
    return waitOn.map((entry) => {
      const value = context[entry.key];
      const exists = entry.key in context && value !== undefined && value !== null;
      let typeMatch = false;
      if (exists) {
        typeMatch = checkType(value, entry.type);
      }
      return {
        key: entry.key,
        type: entry.type,
        ...(entry.description ? { description: entry.description } : {}),
        satisfied: exists && typeMatch,
      };
    });
  }

  private checkWaitTimeout(session: SessionState, nodeDef: NodeDefinition): boolean {
    if (!nodeDef.timeout || !session.waitArrivedAt) return false;
    if (session.context._waitTimedOut === true) return true;

    const timeoutMs = parseDuration(nodeDef.timeout);
    if (timeoutMs === null) return false;

    const arrivedAt = new Date(session.waitArrivedAt).getTime();
    const now = Date.now();
    if (now >= arrivedAt + timeoutMs) {
      session.context._waitTimedOut = true;
      return true;
    }
    return false;
  }

  private computeTimeoutAt(arrivedAt: string, timeout?: string): string | undefined {
    if (!timeout) return undefined;
    const timeoutMs = parseDuration(timeout);
    if (timeoutMs === null) return undefined;
    return new Date(new Date(arrivedAt).getTime() + timeoutMs).toISOString();
  }

  private buildStackView(): StackEntry[] {
    return this.stack.map((s, i) => {
      if (i === this.stack.length - 1) {
        // Active session
        return { graphId: s.graphId, currentNode: s.currentNode };
      }
      // Suspended parent
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

    // Evaluate condition — if false, behave as a normal node (no push)
    if (subgraph.condition) {
      let condMet: boolean;
      try {
        condMet = evaluate(subgraph.condition, parentSession.context);
      } catch {
        condMet = false;
      }
      if (!condMet) {
        // No push — return normal advance result
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

    // Check stack depth
    if (this.stack.length >= this.maxDepth) {
      throw new EngineError(
        `Maximum stack depth (${this.maxDepth}) exceeded. Cannot push subgraph '${subgraph.graphId}'. Simplify the workflow or increase maxDepth.`,
        "STACK_DEPTH_EXCEEDED"
      );
    }

    // Resolve child graph
    const childGraph = this.graphs.get(subgraph.graphId);
    if (!childGraph) {
      throw new EngineError(
        `Subgraph '${subgraph.graphId}' not found in loaded graphs.`,
        "GRAPH_NOT_FOUND"
      );
    }

    // Build child initial context
    const childDef = childGraph.definition;
    const childContext: Record<string, unknown> = {
      ...(childDef.context ?? {}),
      ...(subgraph.initialContext ?? {}),
    };

    // Apply contextMap: copy parent context keys → child context keys
    if (subgraph.contextMap) {
      for (const [parentKey, childKey] of Object.entries(subgraph.contextMap)) {
        if (parentKey in parentSession.context) {
          childContext[childKey] = parentSession.context[parentKey];
        }
      }
    }

    // Push child session onto stack
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

    // Pop child session
    this.stack.pop();

    // Now the parent is the active session
    const parentSession = this.activeSession();
    const parentDef = this.currentGraphDef();
    const parentNodeDef = parentDef.nodes[parentSession.currentNode];
    const subgraphDef = parentNodeDef.subgraph!;

    // Apply returnMap: copy child context keys → parent context keys
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

function parseDuration(duration: string): number | null {
  const regex = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = duration.match(regex);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = parseInt(match[1] ?? "0", 10);
  const minutes = parseInt(match[2] ?? "0", 10);
  const seconds = parseInt(match[3] ?? "0", 10);
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function toNodeInfo(node: NodeDefinition): NodeInfo {
  return {
    type: node.type,
    description: node.description,
    ...(node.instructions ? { instructions: node.instructions } : {}),
    suggestedTools: node.suggestedTools ?? [],
    ...(node.returns ? { returns: node.returns } : {}),
  };
}

function checkType(value: unknown, expectedType: ReturnField["type"]): boolean {
  switch (expectedType) {
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && !Array.isArray(value) && value !== null;
  }
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateReturnSchema(
  returns: NonNullable<NodeDefinition["returns"]>,
  context: Record<string, unknown>
): string | null {
  // Check required keys
  if (returns.required) {
    for (const [key, field] of Object.entries(returns.required)) {
      if (!(key in context) || context[key] === undefined) {
        return `required key "${key}" (type: ${field.type}) is missing from context`;
      }
      const value = context[key];
      if (!checkType(value, field.type)) {
        return `key "${key}" expected type "${field.type}" but got "${actualType(value)}"`;
      }
      if (field.type === "array" && field.items && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!checkType(value[i], field.items)) {
            return `key "${key}" array item [${i}] expected type "${field.items}" but got "${actualType(value[i])}"`;
          }
        }
      }
    }
  }

  // Check optional keys (only if present)
  if (returns.optional) {
    for (const [key, field] of Object.entries(returns.optional)) {
      if (!(key in context) || context[key] === undefined) continue;
      const value = context[key];
      if (!checkType(value, field.type)) {
        return `key "${key}" expected type "${field.type}" but got "${actualType(value)}"`;
      }
      if (field.type === "array" && field.items && Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (!checkType(value[i], field.items)) {
            return `key "${key}" array item [${i}] expected type "${field.items}" but got "${actualType(value[i])}"`;
          }
        }
      }
    }
  }

  return null;
}

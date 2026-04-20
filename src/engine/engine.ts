import { EngineError } from "../errors.js";
import { resolveContextDefaults } from "../loader.js";
import type {
  AdvanceResult,
  AdvanceSuccessResult,
  ContextSetResult,
  GraphListResult,
  InspectField,
  InspectResult,
  ResetResult,
  SessionState,
  StartResult,
  ValidatedGraph,
} from "../types.js";
import {
  applyContextUpdates,
  buildContextSetResult,
  buildInspectResult,
  type ContextCaps,
  DEFAULT_CONTEXT_CAPS,
  enforceContextCaps,
  enforceStrictContext,
} from "./context.js";
import {
  checkEdgeCondition,
  checkReturnSchema,
  checkValidations,
  checkWaitBlocking,
} from "./gates.js";
import { cloneContext, toNodeInfo } from "./helpers.js";
import type { HookRunner, MetaCollector } from "./hooks.js";
import { maybePushSubgraph, popSubgraph } from "./subgraph.js";
import { evaluateTransitions } from "./transitions.js";
import { computeTimeoutAt, evaluateWaitConditions } from "./wait.js";

export interface GraphEngineOptions {
  maxDepth?: number;
  /**
   * Required. Hosts always know whether memory is wired; the engine
   * does not guess. Construct via `composeRuntime` (production) or
   * `new HookRunner()` for a no-memory runner (tests and direct
   * library use).
   */
  hookRunner: HookRunner;
  /**
   * Byte caps on context writes. Applied to `start`'s initialContext,
   * `advance`'s contextUpdates, and `contextSet`. Hook return values
   * are capped inside the HookRunner so the runner owns that path
   * end-to-end. Defaults to `DEFAULT_CONTEXT_CAPS` when omitted.
   */
  contextCaps?: ContextCaps;
}

export class GraphEngine {
  private stack: SessionState[] = [];
  private maxDepth: number;
  private hookRunner: HookRunner;
  private contextCaps: ContextCaps;

  constructor(
    private graphs: Map<string, ValidatedGraph>,
    options: GraphEngineOptions,
  ) {
    this.maxDepth = options.maxDepth ?? 5;
    this.hookRunner = options.hookRunner;
    this.contextCaps = options.contextCaps ?? DEFAULT_CONTEXT_CAPS;
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

  async start(
    graphId: string,
    initialContext?: Record<string, unknown>,
    options?: { metaCollector?: MetaCollector },
  ): Promise<StartResult> {
    if (this.stack.length > 0) {
      throw new EngineError(
        "A traversal is already active. Call reset() first.",
        "TRAVERSAL_ACTIVE",
      );
    }

    const graph = this.graphs.get(graphId);
    if (!graph) {
      throw new EngineError(`Graph "${graphId}" not found`, "GRAPH_NOT_FOUND");
    }

    const def = graph.definition;
    const defaults = resolveContextDefaults(def.context ?? {});
    if (initialContext) {
      enforceContextCaps(defaults, initialContext, this.contextCaps);
    }
    const context: Record<string, unknown> = {
      ...defaults,
      ...(initialContext ?? {}),
    };

    const session: SessionState = {
      graphId,
      currentNode: def.startNode,
      context,
      history: [],
      contextHistory: [],
      turnCount: 0,
      startedAt: new Date().toISOString(),
    };
    this.stack.push(session);

    // Fire onEnter for the start node. Hooks may mutate session.context,
    // so validTransitions and the response snapshot are built after.
    await this.runHooksOnArrival(session, graph, options?.metaCollector);

    const node = def.nodes[def.startNode];
    return {
      status: "started",
      isError: false,
      graphId,
      currentNode: def.startNode,
      node: toNodeInfo(node),
      validTransitions: evaluateTransitions(node, session.context),
      context: cloneContext(session.context),
      ...(def.sources && def.sources.length > 0 ? { graphSources: def.sources } : {}),
    } satisfies StartResult;
  }

  async advance(
    edge: string,
    contextUpdates?: Record<string, unknown>,
    options?: { metaCollector?: MetaCollector },
  ): Promise<AdvanceResult> {
    const session = this.requireSession();
    const graph = this.currentGraph();
    const def = graph.definition;
    const currentNodeDef = def.nodes[session.currentNode];

    if (contextUpdates) {
      enforceContextCaps(session.context, contextUpdates, this.contextCaps);
      applyContextUpdates(session, contextUpdates);
      session.turnCount++;
    }

    // Pre-advance gate checks
    const sources = def.sources;
    const waitBlock = checkWaitBlocking(session, currentNodeDef, sources);
    if (waitBlock) return waitBlock;

    const returnBlock = checkReturnSchema(session, currentNodeDef, sources);
    if (returnBlock) return returnBlock;

    const validationBlock = checkValidations(session, currentNodeDef, sources);
    if (validationBlock) return validationBlock;

    // Find and validate edge
    if (!currentNodeDef.edges) {
      throw new EngineError(
        `Node "${session.currentNode}" is a terminal node with no outgoing edges`,
        "NO_EDGES",
      );
    }
    const edgeDef = currentNodeDef.edges.find((e) => e.label === edge);
    if (!edgeDef) {
      throw new EngineError(
        `Edge "${edge}" not found on node "${session.currentNode}". ` +
          `Available edges: ${currentNodeDef.edges.map((e: { label: string }) => e.label).join(", ")}`,
        "EDGE_NOT_FOUND",
      );
    }

    if (edgeDef.condition) {
      const condBlock = checkEdgeCondition(
        session,
        currentNodeDef,
        edgeDef.condition,
        edge,
        sources,
      );
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

    // Subgraph transitions. Push runs hooks on the child's start node;
    // pop does not re-fire hooks on the resumed parent (already fired on
    // initial arrival).
    if (isTerminal && this.stack.length > 1) {
      return popSubgraph(this.stack, this.graphs, previousNode, edge);
    }
    if (!isTerminal && !isWait && newNodeDef.subgraph) {
      return maybePushSubgraph({
        stack: this.stack,
        graphs: this.graphs,
        previousNode,
        edge,
        newNodeDef,
        maxDepth: this.maxDepth,
        hookRunner: this.hookRunner,
        metaCollector: options?.metaCollector,
      });
    }

    // Standard arrival: fire onEnter for the new node before building
    // the response so hook writes land in validTransitions and context.
    await this.runHooksOnArrival(session, graph, options?.metaCollector);

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
        ...(def.sources?.length ? { graphSources: def.sources } : {}),
      } satisfies AdvanceSuccessResult;
    }

    // Standard advance or terminal
    const result: AdvanceSuccessResult = {
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
            traversalHistory: [...session.history.map((h) => h.node), session.currentNode],
          }
        : {}),
      ...(def.sources?.length ? { graphSources: def.sources } : {}),
    };

    // Root terminal GC: clear the stack so TraversalStore.saveEngine
    // deletes the persisted record. The response is already snapshotted
    // above — context, traversalHistory, and node info survive the pop.
    // Post-hoc inspect via freelance_inspect is lost, but a completed
    // traversalId is a dead handle anyway. Subgraph terminals are handled
    // earlier in this function via popSubgraph and don't reach here.
    if (isTerminal && this.stack.length === 1) {
      this.stack = [];
    }

    return result;
  }

  contextSet(updates: Record<string, unknown>): ContextSetResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();

    enforceStrictContext(def, updates);
    enforceContextCaps(session.context, updates, this.contextCaps);
    applyContextUpdates(session, updates);
    session.turnCount++;

    return buildContextSetResult(session, def.nodes[session.currentNode]);
  }

  inspect(
    detail: "position" | "history" = "position",
    fields: readonly InspectField[] = [],
  ): InspectResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();
    return buildInspectResult(detail, session, def, this.stack, fields);
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
      message: "Traversal cleared. Call freelance_start to begin a new workflow.",
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
      throw new EngineError("No traversal active. Call start() first.", "NO_TRAVERSAL");
    }
    return this.activeSession();
  }

  private currentGraph(): ValidatedGraph {
    const graph = this.graphs.get(this.activeSession().graphId);
    if (!graph) {
      throw new EngineError(`Graph "${this.activeSession().graphId}" not found`, "GRAPH_NOT_FOUND");
    }
    return graph;
  }

  private currentGraphDef() {
    return this.currentGraph().definition;
  }

  private async runHooksOnArrival(
    session: SessionState,
    graph: ValidatedGraph,
    metaCollector?: MetaCollector,
  ): Promise<void> {
    await this.hookRunner.runHooksFor(
      session,
      graph.definition,
      session.currentNode,
      graph.hookResolutions,
      metaCollector,
    );
  }
}

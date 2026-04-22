import { EC, EngineError } from "../errors.js";
import { resolveContextDefaults } from "../loader.js";
import type {
  AdvanceMinimalResult,
  AdvanceResult,
  AdvanceSuccessMinimalResult,
  AdvanceSuccessResult,
  ContextSetMinimalResult,
  ContextSetResult,
  GraphListResult,
  InspectField,
  InspectMinimalResult,
  InspectResult,
  NodeDefinition,
  ResetResult,
  SessionState,
  StartResult,
  ValidatedGraph,
} from "../types.js";
import {
  applyContextUpdates,
  buildContextSetMinimalResult,
  buildContextSetResult,
  buildInspectMinimalResult,
  buildInspectResult,
  type ContextCaps,
  DEFAULT_CONTEXT_CAPS,
  enforceContextCaps,
  enforceStrictContext,
  type InspectHistoryOptions,
  type ResponseMode,
} from "./context.js";
import {
  checkEdgeCondition,
  checkReturnSchema,
  checkValidations,
  checkWaitBlocking,
  type GateOptions,
} from "./gates.js";
import { cloneContext, keysSince, toNodeInfo } from "./helpers.js";
import type { HookRunner, MetaCollector } from "./hooks.js";
import { maybePushSubgraph, popSubgraph } from "./subgraph.js";
import { evaluateTransitions } from "./transitions.js";
import { computeTimeoutAt, evaluateWaitConditions } from "./wait.js";

export type { ResponseMode } from "./context.js";

/**
 * Internal — returned by `GraphEngine.advanceTransition` and consumed
 * by `GraphEngine.runArrivalHooks`. Not on the wire; callers outside
 * the engine should use the convenience `advance()` which wires the
 * two phases back-to-back.
 *
 * Three shapes:
 * - `early`: transition was short-circuited (gate block, subgraph pop,
 *   subgraph-condition-not-met). Session state is already in its final
 *   post-advance form; the wire response is already built. No hooks
 *   run. The caller should save once and return `result` directly.
 * - `subgraph-push`: a subgraph node was the edge target. The parent
 *   session's `currentNode` already moved to the subgraph node, but
 *   the child session hasn't been pushed yet. `runArrivalHooks` pushes
 *   the child + fires hooks on its start node + builds the response.
 *   `TraversalStore` sandwiches a persist between push and hook via
 *   the `persistBetween` callback so a hook throw leaves disk with
 *   the child pushed, not the parent pre-push.
 * - `standard`: normal node arrival. `currentNode` already moved on
 *   the active session. `runArrivalHooks` fires `onEnter` + builds
 *   the response. Caller saves BEFORE the hooks run (so a hook throw
 *   leaves disk on the new node, not the stale pre-advance one) and
 *   AFTER the hooks complete (to capture hook-written context + meta).
 */
export type TransitionCommit =
  | { kind: "early"; result: AdvanceResult | AdvanceMinimalResult }
  | {
      kind: "subgraph-push";
      previousNode: string;
      edge: string;
      writesBefore: number;
      minimal: boolean;
      newNodeDef: NodeDefinition;
    }
  | {
      kind: "standard";
      previousNode: string;
      edge: string;
      writesBefore: number;
      minimal: boolean;
      newNodeDef: NodeDefinition;
      isTerminal: boolean;
      isWait: boolean;
    };

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
        EC.TRAVERSAL_ACTIVE,
      );
    }

    const graph = this.graphs.get(graphId);
    if (!graph) {
      throw new EngineError(`Graph "${graphId}" not found`, EC.GRAPH_NOT_FOUND);
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

  /**
   * Transition phase of `advance`. Applies context updates, runs gate
   * checks, and — if everything passes — mutates session state
   * synchronously (pushes history, moves `currentNode`, pops a
   * terminating subgraph). Does NOT run `onEnter` hooks. Returns a
   * `TransitionCommit` carrying either an early-return wire result
   * (gate-block, pop, push-skipped) or the metadata needed by
   * `runArrivalHooks` to finish the advance.
   *
   * The split exists so `TraversalStore.advance` can persist the
   * post-transition session BEFORE firing hooks — if a hook throws,
   * disk matches the in-memory post-transition state and the next
   * advance runs gates on the new node, not the stale one.
   */
  advanceTransition(
    edge: string,
    contextUpdates?: Record<string, unknown>,
    options?: { responseMode?: ResponseMode },
  ): TransitionCommit {
    const session = this.requireSession();
    const graph = this.currentGraph();
    const def = graph.definition;
    const currentNodeDef = def.nodes[session.currentNode];
    const minimal = options?.responseMode === "minimal";

    const writesBefore = session.contextHistory.length;

    if (contextUpdates) {
      enforceContextCaps(session.context, contextUpdates, this.contextCaps);
      applyContextUpdates(session, contextUpdates);
      session.turnCount++;
    }

    const preHookDelta = minimal ? keysSince(session.contextHistory, writesBefore) : [];
    const gateOpts: GateOptions = {
      minimal,
      contextDelta: preHookDelta,
      graphSources: def.sources,
    };
    const waitBlock = checkWaitBlocking(session, currentNodeDef, gateOpts);
    if (waitBlock) return { kind: "early", result: waitBlock };

    const returnBlock = checkReturnSchema(session, currentNodeDef, gateOpts);
    if (returnBlock) return { kind: "early", result: returnBlock };

    const validationBlock = checkValidations(session, currentNodeDef, gateOpts);
    if (validationBlock) return { kind: "early", result: validationBlock };

    if (!currentNodeDef.edges) {
      throw new EngineError(
        `Node "${session.currentNode}" is a terminal node with no outgoing edges`,
        EC.NO_EDGES,
      );
    }
    const edgeDef = currentNodeDef.edges.find((e) => e.label === edge);
    if (!edgeDef) {
      throw new EngineError(
        `Edge "${edge}" not found on node "${session.currentNode}". ` +
          `Available edges: ${currentNodeDef.edges.map((e: { label: string }) => e.label).join(", ")}`,
        EC.EDGE_NOT_FOUND,
      );
    }

    if (edgeDef.condition) {
      const condBlock = checkEdgeCondition(
        session,
        currentNodeDef,
        edgeDef.condition,
        edge,
        gateOpts,
      );
      if (condBlock) return { kind: "early", result: condBlock };
    }

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

    // Subgraph pop: stack mutation + response build happen here. No
    // hooks fire on the resumed parent — return early with the built
    // wire result.
    if (isTerminal && this.stack.length > 1) {
      const result = popSubgraph({
        stack: this.stack,
        graphs: this.graphs,
        previousNode,
        edge,
        minimal,
        contextDelta: preHookDelta,
      });
      return { kind: "early", result };
    }
    // Subgraph push deferred to runArrivalHooks so push + onEnter
    // share a save boundary (persistBetween threads disk reflection
    // of the push before hooks run).
    if (!isTerminal && !isWait && newNodeDef.subgraph) {
      return {
        kind: "subgraph-push",
        previousNode,
        edge,
        writesBefore,
        minimal,
        newNodeDef,
      };
    }

    return {
      kind: "standard",
      previousNode,
      edge,
      writesBefore,
      minimal,
      newNodeDef,
      isTerminal,
      isWait,
    };
  }

  /**
   * Arrival-hook phase of `advance`. Runs `onEnter` for the
   * post-transition node and builds the wire response. Must be
   * called after `advanceTransition` returned. Gate-block +
   * subgraph-pop branches (`kind: "early"`) pass through their
   * pre-built response unchanged.
   *
   * `persistBetween` is only consumed by the subgraph-push branch:
   * `maybePushSubgraph` pushes the child, invokes `persistBetween`,
   * then fires hooks on the child's start node.
   */
  async runArrivalHooks(
    commit: TransitionCommit,
    options?: { metaCollector?: MetaCollector; persistBetween?: () => void },
  ): Promise<AdvanceResult | AdvanceMinimalResult> {
    if (commit.kind === "early") return commit.result;

    const session = this.requireSession();
    const graph = this.currentGraph();
    const def = graph.definition;

    if (commit.kind === "subgraph-push") {
      return maybePushSubgraph({
        stack: this.stack,
        graphs: this.graphs,
        previousNode: commit.previousNode,
        edge: commit.edge,
        newNodeDef: commit.newNodeDef,
        maxDepth: this.maxDepth,
        hookRunner: this.hookRunner,
        metaCollector: options?.metaCollector,
        minimal: commit.minimal,
        contextDelta: commit.minimal ? keysSince(session.contextHistory, commit.writesBefore) : [],
        ...(options?.persistBetween && { persistBetween: options.persistBetween }),
      });
    }

    // Standard arrival: fire onEnter for the new node before building
    // the response so hook writes land in validTransitions and context.
    await this.runHooksOnArrival(session, graph, options?.metaCollector);

    const { previousNode, edge, writesBefore, minimal, newNodeDef, isTerminal, isWait } = commit;
    const contextDelta = minimal ? keysSince(session.contextHistory, writesBefore) : [];
    const validTransitions = evaluateTransitions(newNodeDef, session.context);

    // Wait node arrival
    if (isWait && newNodeDef.waitOn) {
      session.waitArrivedAt = new Date().toISOString();
      const waitConditions = evaluateWaitConditions(newNodeDef.waitOn, session.context);
      const timeoutAt = computeTimeoutAt(session.waitArrivedAt, newNodeDef.timeout);

      if (minimal) {
        return {
          status: "waiting",
          isError: false,
          previousNode,
          edgeTaken: edge,
          currentNode: session.currentNode,
          validTransitions,
          contextDelta,
          waitingOn: waitConditions,
          ...(newNodeDef.timeout ? { timeout: newNodeDef.timeout } : {}),
          ...(timeoutAt ? { timeoutAt } : {}),
        } satisfies AdvanceSuccessMinimalResult;
      }
      return {
        status: "waiting",
        isError: false,
        previousNode,
        edgeTaken: edge,
        currentNode: session.currentNode,
        node: toNodeInfo(newNodeDef),
        validTransitions,
        context: cloneContext(session.context),
        waitingOn: waitConditions,
        ...(newNodeDef.timeout ? { timeout: newNodeDef.timeout } : {}),
        ...(timeoutAt ? { timeoutAt } : {}),
        ...(def.sources?.length ? { graphSources: def.sources } : {}),
      } satisfies AdvanceSuccessResult;
    }

    // Standard advance or terminal
    const terminalHistory: readonly string[] | undefined = isTerminal
      ? [...session.history.map((h) => h.node), session.currentNode]
      : undefined;

    const result: AdvanceSuccessResult | AdvanceSuccessMinimalResult = minimal
      ? ({
          status: isTerminal ? "complete" : "advanced",
          isError: false,
          previousNode,
          edgeTaken: edge,
          currentNode: session.currentNode,
          validTransitions,
          contextDelta,
          ...(terminalHistory ? { traversalHistory: terminalHistory } : {}),
        } satisfies AdvanceSuccessMinimalResult)
      : ({
          status: isTerminal ? "complete" : "advanced",
          isError: false,
          previousNode,
          edgeTaken: edge,
          currentNode: session.currentNode,
          node: toNodeInfo(newNodeDef),
          validTransitions,
          context: cloneContext(session.context),
          ...(terminalHistory ? { traversalHistory: terminalHistory } : {}),
          ...(def.sources?.length ? { graphSources: def.sources } : {}),
        } satisfies AdvanceSuccessResult);

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

  /**
   * Library convenience: run `advanceTransition` + `runArrivalHooks`
   * back-to-back without an intermediate persist. `TraversalStore.advance`
   * invokes the two phases separately so it can sandwich a save between
   * them; direct engine callers (tests, programmatic use) stay on this
   * shape.
   */
  async advance(
    edge: string,
    contextUpdates?: Record<string, unknown>,
    options?: { metaCollector?: MetaCollector; responseMode?: ResponseMode },
  ): Promise<AdvanceResult | AdvanceMinimalResult> {
    const commit = this.advanceTransition(edge, contextUpdates, options);
    return this.runArrivalHooks(commit, options);
  }

  contextSet(
    updates: Record<string, unknown>,
    options?: { responseMode?: ResponseMode },
  ): ContextSetResult | ContextSetMinimalResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();

    enforceStrictContext(def, updates);
    enforceContextCaps(session.context, updates, this.contextCaps);
    applyContextUpdates(session, updates);
    session.turnCount++;

    const nodeDef = def.nodes[session.currentNode];
    if (options?.responseMode === "minimal") {
      return buildContextSetMinimalResult(session, nodeDef, Object.keys(updates));
    }
    return buildContextSetResult(session, nodeDef);
  }

  inspect(
    detail: "position" | "history" = "position",
    fields: readonly InspectField[] = [],
    historyOpts: InspectHistoryOptions = {},
    options?: { responseMode?: ResponseMode },
  ): InspectResult | InspectMinimalResult {
    const session = this.requireSession();
    const def = this.currentGraphDef();
    if (options?.responseMode === "minimal") {
      return buildInspectMinimalResult(detail, session, def, this.stack, historyOpts);
    }
    return buildInspectResult(detail, session, def, this.stack, fields, historyOpts);
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
      throw new EngineError("No traversal active. Call start() first.", EC.NO_TRAVERSAL);
    }
    return this.activeSession();
  }

  private currentGraph(): ValidatedGraph {
    const graph = this.graphs.get(this.activeSession().graphId);
    if (!graph) {
      throw new EngineError(
        `Graph "${this.activeSession().graphId}" not found`,
        EC.GRAPH_NOT_FOUND,
      );
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

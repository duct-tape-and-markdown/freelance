# Graph Engine — Review Report

## Part 1: Architecture Overview

### File Tree

```
.
.gitignore
package.json
tsconfig.json
src/
  engine.ts
  errors.ts
  evaluator.ts
  index.ts
  loader.ts
  server.ts
  types.ts
  schema/
    graph-schema.ts
test/
  engine.test.ts
  evaluator.test.ts
  loader.test.ts
  server.test.ts
  fixtures/
    invalid-action-loop.graph.yaml
    invalid-gate-no-validations.graph.yaml
    invalid-missing-target.graph.yaml
    invalid-orphan.graph.yaml
    invalid-terminal-with-edges.graph.yaml
    valid-branching.graph.yaml
    valid-default-edge.graph.yaml
    valid-simple.graph.yaml
    valid-strict.graph.yaml
  fixtures-valid/
    valid-branching.graph.yaml
    valid-default-edge.graph.yaml
    valid-simple.graph.yaml
    valid-strict.graph.yaml
docs/
  SPEC.md
  step-1-scaffold-loader.md
  step-2.md
  step-3.md
  step-4.md
```

### Export Summary (`.d.ts`-style)

#### `src/types.ts`

```typescript
export interface EdgeDefinition { target: string; label: string; condition?: string; description?: string; default?: boolean; }
export interface ValidationRule { expr: string; message: string; }
export interface NodeDefinition { type: "action" | "decision" | "gate" | "terminal"; description: string; instructions?: string; suggestedTools?: string[]; maxTurns?: number; validations?: ValidationRule[]; edges?: EdgeDefinition[]; }
export interface GraphDefinition { id: string; version: string; name: string; description: string; startNode: string; context?: Record<string, unknown>; strictContext?: boolean; nodes: Record<string, NodeDefinition>; }
export interface ValidatedGraph { definition: GraphDefinition; graph: graphlib.Graph; }
export interface TransitionInfo { label: string; target: string; condition?: string; description?: string; conditionMet: boolean; }
export interface NodeInfo { type: NodeDefinition["type"]; description: string; instructions?: string; suggestedTools: string[]; }
export interface GraphListResult { graphs: Array<{ id: string; name: string; version: string; description: string }>; }
export interface StartResult { status: "started"; isError: false; graphId: string; currentNode: string; node: NodeInfo; validTransitions: TransitionInfo[]; context: Record<string, unknown>; }
export interface AdvanceSuccessResult { status: "advanced" | "complete"; isError: false; previousNode: string; edgeTaken: string; currentNode: string; node: NodeInfo; validTransitions: TransitionInfo[]; context: Record<string, unknown>; traversalHistory?: string[]; }
export interface AdvanceErrorResult { status: "error"; isError: true; currentNode: string; reason: string; validTransitions: TransitionInfo[]; context: Record<string, unknown>; }
export type AdvanceResult = AdvanceSuccessResult | AdvanceErrorResult;
export interface ContextSetResult { status: "updated"; isError: false; currentNode: string; context: Record<string, unknown>; validTransitions: TransitionInfo[]; turnCount: number; turnWarning: string | null; }
export interface InspectPositionResult { graphId: string; graphName: string; currentNode: string; node: NodeInfo; validTransitions: TransitionInfo[]; context: Record<string, unknown>; turnCount: number; turnWarning: string | null; }
export interface HistoryEntry { node: string; edge: string; timestamp: string; contextSnapshot: Record<string, unknown>; }
export interface ContextHistoryEntry { key: string; value: unknown; setAt: string; timestamp: string; }
export interface InspectHistoryResult { graphId: string; currentNode: string; traversalHistory: HistoryEntry[]; contextHistory: ContextHistoryEntry[]; }
export interface InspectFullResult { graphId: string; currentNode: string; definition: GraphDefinition; context: Record<string, unknown>; }
export type InspectResult = InspectPositionResult | InspectHistoryResult | InspectFullResult;
export interface ResetResult { status: "reset"; previousGraph: string | null; previousNode: string | null; message: string; }
export interface SessionState { graphId: string; currentNode: string; context: Record<string, unknown>; history: HistoryEntry[]; contextHistory: ContextHistoryEntry[]; turnCount: number; startedAt: string; }
```

#### `src/errors.ts`

```typescript
export class EngineError extends Error {
  constructor(message: string, public code: string);
}
```

#### `src/evaluator.ts`

```typescript
export class EvaluatorError extends Error {
  constructor(message: string, public expression: string, public position?: number);
}
export function evaluate(expr: string, context: Record<string, unknown>): boolean;
```

#### `src/schema/graph-schema.ts`

```typescript
export const graphSchema: JSONSchemaType<GraphDefinition>;
```

#### `src/loader.ts`

```typescript
export function loadGraphs(directory: string): Map<string, ValidatedGraph>;
```

#### `src/engine.ts`

```typescript
export class GraphEngine {
  constructor(graphs: Map<string, ValidatedGraph>);
  list(): GraphListResult;
  start(graphId: string, initialContext?: Record<string, unknown>): StartResult;
  advance(edge: string, contextUpdates?: Record<string, unknown>): AdvanceResult;
  contextSet(updates: Record<string, unknown>): ContextSetResult;
  inspect(detail?: "position" | "full" | "history"): InspectResult;
  reset(): ResetResult;
}
```

#### `src/server.ts`

```typescript
export function createServer(graphs: Map<string, ValidatedGraph>): McpServer;
export async function startServer(graphs: Map<string, ValidatedGraph>): Promise<void>;
```

#### `src/index.ts`

No exports. Entry point with `--graphs <dir>` and `--validate` CLI flags.

---

## Part 2: Critical Code Sections

### `src/engine.ts`

```typescript
import { evaluate } from "./evaluator.js";
import { EngineError } from "./errors.js";
import type {
  ValidatedGraph,
  NodeDefinition,
  EdgeDefinition,
  TransitionInfo,
  NodeInfo,
  GraphListResult,
  StartResult,
  AdvanceResult,
  ContextSetResult,
  InspectResult,
  InspectPositionResult,
  InspectHistoryResult,
  InspectFullResult,
  ResetResult,
  SessionState,
} from "./types.js";

export class GraphEngine {
  private session: SessionState | null = null;

  constructor(private graphs: Map<string, ValidatedGraph>) {}

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
    if (this.session) {
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

    this.session = {
      graphId,
      currentNode: def.startNode,
      context,
      history: [],
      contextHistory: [],
      turnCount: 0,
      startedAt: new Date().toISOString(),
    };

    const node = def.nodes[def.startNode];
    return {
      status: "started",
      isError: false,
      graphId,
      currentNode: def.startNode,
      node: toNodeInfo(node),
      validTransitions: this.evaluateTransitions(node),
      context: { ...this.session.context },
    };
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
    }

    // Step 3: Check validations on current node
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
            context: { ...session.context },
          };
        }
      }
    }

    // Step 4: Find edge by label
    const edges = currentNodeDef.edges ?? [];
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
          context: { ...session.context },
        };
      }
    }

    // Step 6: Advance
    const previousNode = session.currentNode;
    session.history.push({
      node: previousNode,
      edge,
      timestamp: new Date().toISOString(),
      contextSnapshot: { ...session.context },
    });
    session.currentNode = edgeDef.target;
    session.turnCount = 0;

    const newNodeDef = def.nodes[session.currentNode];
    const isTerminal = newNodeDef.type === "terminal";

    return {
      status: isTerminal ? "complete" : "advanced",
      isError: false,
      previousNode,
      edgeTaken: edge,
      currentNode: session.currentNode,
      node: toNodeInfo(newNodeDef),
      validTransitions: this.evaluateTransitions(newNodeDef),
      context: { ...session.context },
      ...(isTerminal
        ? {
            traversalHistory: [
              ...session.history.map((h) => h.node),
              session.currentNode,
            ],
          }
        : {}),
    };
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
      context: { ...session.context },
      validTransitions: this.evaluateTransitions(currentNodeDef),
      turnCount: session.turnCount,
      turnWarning,
    };
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
        context: { ...session.context },
      } satisfies InspectFullResult;
    }

    // position (default)
    const currentNodeDef = def.nodes[session.currentNode];
    const turnWarning =
      currentNodeDef.maxTurns && session.turnCount >= currentNodeDef.maxTurns
        ? `Turn budget reached (${session.turnCount}/${currentNodeDef.maxTurns}). Consider wrapping up and advancing to the next node.`
        : null;

    return {
      graphId: session.graphId,
      graphName: def.name,
      currentNode: session.currentNode,
      node: toNodeInfo(currentNodeDef),
      validTransitions: this.evaluateTransitions(currentNodeDef),
      context: { ...session.context },
      turnCount: session.turnCount,
      turnWarning,
    } satisfies InspectPositionResult;
  }

  reset(): ResetResult {
    if (!this.session) {
      return {
        status: "reset",
        previousGraph: null,
        previousNode: null,
        message: "No traversal was active.",
      };
    }

    const prev = {
      graphId: this.session.graphId,
      node: this.session.currentNode,
    };
    this.session = null;

    return {
      status: "reset",
      previousGraph: prev.graphId,
      previousNode: prev.node,
      message:
        "Traversal cleared. Call graph_start to begin a new workflow.",
    };
  }

  // --- Private helpers ---

  private requireSession(): SessionState {
    if (!this.session) {
      throw new EngineError(
        "No traversal active. Call start() first.",
        "NO_TRAVERSAL"
      );
    }
    return this.session;
  }

  private currentGraphDef() {
    return this.graphs.get(this.session!.graphId)!.definition;
  }

  private applyContextUpdates(updates: Record<string, unknown>) {
    const session = this.session!;
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
    const session = this.session!;

    // Evaluate conditions for all non-default edges first
    const results: Array<TransitionInfo & { isDefault: boolean }> = edges.map(
      (e) => {
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
      }
    );

    // Default edge: conditionMet = true only when no other conditional edge is met
    const anyConditionalMet = results.some(
      (r) => !r.isDefault && r.conditionMet && edges.find((e) => e.label === r.label)?.condition
    );

    for (const r of results) {
      if (r.isDefault) {
        r.conditionMet = !anyConditionalMet;
      }
    }

    // Strip isDefault from the output
    return results.map(({ isDefault, ...rest }) => rest);
  }
}

function toNodeInfo(node: NodeDefinition): NodeInfo {
  return {
    type: node.type,
    description: node.description,
    ...(node.instructions ? { instructions: node.instructions } : {}),
    suggestedTools: node.suggestedTools ?? [],
  };
}
```

### `src/server.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GraphEngine } from "./engine.js";
import { EngineError } from "./errors.js";
import type { ValidatedGraph } from "./types.js";

function jsonResponse(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function errorResponse(message: string, detail?: unknown) {
  const payload = detail ?? { error: message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true as const,
  };
}

export function createServer(graphs: Map<string, ValidatedGraph>): McpServer {
  const engine = new GraphEngine(graphs);

  const server = new McpServer(
    { name: "graph-engine", version: "0.1.0" },
  );

  // graph_list
  server.tool(
    "graph_list",
    "List all available workflow graphs. Call this to discover which graphs are loaded and can be started.",
    {},
    () => jsonResponse(engine.list())
  );

  // graph_start
  server.tool(
    "graph_start",
    "Begin traversing a workflow graph. Must be called before advance, context_set, or inspect. Call graph_list first to see available graphs.",
    {
      graphId: z.string(),
      initialContext: z.record(z.string(), z.unknown()).optional(),
    },
    ({ graphId, initialContext }) => {
      try {
        return jsonResponse(engine.start(graphId, initialContext));
      } catch (e) {
        if (e instanceof EngineError) {
          return errorResponse(e.message);
        }
        throw e;
      }
    }
  );

  // graph_advance
  server.tool(
    "graph_advance",
    "Move to the next node by taking a labeled edge. Optionally include context updates that are applied before edge evaluation. Context updates persist even if the advance fails.",
    {
      edge: z.string(),
      contextUpdates: z.record(z.string(), z.unknown()).optional(),
    },
    ({ edge, contextUpdates }) => {
      try {
        const result = engine.advance(edge, contextUpdates);
        if (result.isError) {
          return errorResponse(result.reason, result);
        }
        return jsonResponse(result);
      } catch (e) {
        if (e instanceof EngineError) {
          return errorResponse(e.message);
        }
        throw e;
      }
    }
  );

  // graph_context_set
  server.tool(
    "graph_context_set",
    "Update session context without advancing. Use this to record work results before choosing which edge to take. Returns updated valid transitions with conditionMet evaluated.",
    {
      updates: z.record(z.string(), z.unknown()),
    },
    ({ updates }) => {
      try {
        return jsonResponse(engine.contextSet(updates));
      } catch (e) {
        if (e instanceof EngineError) {
          return errorResponse(e.message);
        }
        throw e;
      }
    }
  );

  // graph_inspect
  server.tool(
    "graph_inspect",
    "Read-only introspection of current graph state. Use after context compaction to re-orient. Returns current position, valid transitions, and context.",
    {
      detail: z.enum(["position", "full", "history"]).default("position"),
    },
    ({ detail }) => {
      try {
        return jsonResponse(engine.inspect(detail));
      } catch (e) {
        if (e instanceof EngineError) {
          return errorResponse(e.message);
        }
        throw e;
      }
    }
  );

  // graph_reset
  server.tool(
    "graph_reset",
    "Clear the current traversal. Call this to start over or switch to a different graph. Requires confirm: true as a safety check.",
    {
      confirm: z.boolean(),
    },
    ({ confirm }) => {
      if (confirm !== true) {
        return errorResponse("Must pass confirm: true to reset.");
      }
      return jsonResponse(engine.reset());
    }
  );

  return server;
}

export async function startServer(
  graphs: Map<string, ValidatedGraph>
): Promise<void> {
  const server = createServer(graphs);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

---

## Part 3: Interface Contracts

### `src/types.ts`

```typescript
import type graphlib from "@dagrejs/graphlib";

export interface EdgeDefinition {
  target: string;
  label: string;
  condition?: string;
  description?: string;
  default?: boolean;
}

export interface ValidationRule {
  expr: string;
  message: string;
}

export interface NodeDefinition {
  type: "action" | "decision" | "gate" | "terminal";
  description: string;
  instructions?: string;
  suggestedTools?: string[];
  maxTurns?: number;
  validations?: ValidationRule[];
  edges?: EdgeDefinition[];
}

export interface GraphDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  startNode: string;
  context?: Record<string, unknown>;
  strictContext?: boolean;
  nodes: Record<string, NodeDefinition>;
}

export interface ValidatedGraph {
  definition: GraphDefinition;
  graph: graphlib.Graph;
}

// --- Result types (designed for direct MCP serialization) ---

export interface TransitionInfo {
  label: string;
  target: string;
  condition?: string;
  description?: string;
  conditionMet: boolean;
}

export interface NodeInfo {
  type: NodeDefinition["type"];
  description: string;
  instructions?: string;
  suggestedTools: string[];
}

export interface GraphListResult {
  graphs: Array<{ id: string; name: string; version: string; description: string }>;
}

export interface StartResult {
  status: "started";
  isError: false;
  graphId: string;
  currentNode: string;
  node: NodeInfo;
  validTransitions: TransitionInfo[];
  context: Record<string, unknown>;
}

export interface AdvanceSuccessResult {
  status: "advanced" | "complete";
  isError: false;
  previousNode: string;
  edgeTaken: string;
  currentNode: string;
  node: NodeInfo;
  validTransitions: TransitionInfo[];
  context: Record<string, unknown>;
  traversalHistory?: string[];
}

export interface AdvanceErrorResult {
  status: "error";
  isError: true;
  currentNode: string;
  reason: string;
  validTransitions: TransitionInfo[];
  context: Record<string, unknown>;
}

export type AdvanceResult = AdvanceSuccessResult | AdvanceErrorResult;

export interface ContextSetResult {
  status: "updated";
  isError: false;
  currentNode: string;
  context: Record<string, unknown>;
  validTransitions: TransitionInfo[];
  turnCount: number;
  turnWarning: string | null;
}

export interface InspectPositionResult {
  graphId: string;
  graphName: string;
  currentNode: string;
  node: NodeInfo;
  validTransitions: TransitionInfo[];
  context: Record<string, unknown>;
  turnCount: number;
  turnWarning: string | null;
}

export interface HistoryEntry {
  node: string;
  edge: string;
  timestamp: string;
  contextSnapshot: Record<string, unknown>;
}

export interface ContextHistoryEntry {
  key: string;
  value: unknown;
  setAt: string;
  timestamp: string;
}

export interface InspectHistoryResult {
  graphId: string;
  currentNode: string;
  traversalHistory: HistoryEntry[];
  contextHistory: ContextHistoryEntry[];
}

export interface InspectFullResult {
  graphId: string;
  currentNode: string;
  definition: GraphDefinition;
  context: Record<string, unknown>;
}

export type InspectResult = InspectPositionResult | InspectHistoryResult | InspectFullResult;

export interface ResetResult {
  status: "reset";
  previousGraph: string | null;
  previousNode: string | null;
  message: string;
}

export interface SessionState {
  graphId: string;
  currentNode: string;
  context: Record<string, unknown>;
  history: HistoryEntry[];
  contextHistory: ContextHistoryEntry[];
  turnCount: number;
  startedAt: string;
}
```

### `src/errors.ts`

```typescript
export class EngineError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "EngineError";
  }
}
```

---

## Part 4: Dependency Audit

### package.json dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "js-yaml": "^4.1.0",
    "ajv": "^8.17.0",
    "@dagrejs/graphlib": "^2.2.4"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "@types/js-yaml": "^4.0.9",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0"
  }
}
```

### npm ls --depth=0

```
graph-engine@0.1.0 C:\Users\JohnC\Repos\graph-engine
+-- @dagrejs/graphlib@2.2.4
+-- @modelcontextprotocol/sdk@1.27.1
+-- @types/js-yaml@4.0.9
+-- @types/node@22.19.15
+-- ajv@8.18.0
+-- js-yaml@4.1.1
+-- tsx@4.21.0
+-- typescript@5.9.3
`-- vitest@3.2.4
```

---

## Part 5: Test Health

```
> graph-engine@0.1.0 test
> vitest run

 RUN  v3.2.4 C:/Users/JohnC/Repos/graph-engine

 ✓ test/loader.test.ts (8 tests) 55ms
 ✓ test/engine.test.ts (33 tests) 109ms
 ✓ test/server.test.ts (9 tests) 184ms
 ✓ test/evaluator.test.ts (57 tests) 16ms

 Test Files  4 passed (4)
      Tests  107 passed (107)
   Start at  14:39:36
   Duration  1.64s (transform 532ms, setup 0ms, collect 1.58s, tests 365ms, environment 1ms, prepare 1.17s)
```

---

## Part 6: Build Check

```
> graph-engine@0.1.0 build
> tsc
```

Clean build. Zero errors, zero warnings.

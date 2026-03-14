import type graphlib from "@dagrejs/graphlib";

// Re-export schema types — single source of truth in schema/graph-schema.ts
export type {
  EdgeDefinition,
  ValidationRule,
  SubgraphDefinition,
  NodeDefinition,
  GraphDefinition,
} from "./schema/graph-schema.js";
import type { GraphDefinition, NodeDefinition } from "./schema/graph-schema.js";

export interface ValidatedGraph {
  readonly definition: GraphDefinition;
  readonly graph: graphlib.Graph;
}

// --- Result types (designed for direct MCP serialization) ---
// All result properties are readonly — results are snapshots, not live references.

export interface TransitionInfo {
  readonly label: string;
  readonly target: string;
  readonly condition?: string;
  readonly description?: string;
  readonly conditionMet: boolean;
}

export interface NodeInfo {
  readonly type: NodeDefinition["type"];
  readonly description: string;
  readonly instructions?: string;
  readonly suggestedTools: readonly string[];
}

export interface GraphListResult {
  readonly graphs: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description: string;
  }>;
}

export interface StartResult {
  readonly status: "started";
  readonly isError: false;
  readonly graphId: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
}

export interface SubgraphPushedInfo {
  readonly graphId: string;
  readonly startNode: string;
  readonly stackDepth: number;
}

export interface AdvanceSuccessResult {
  readonly status: "advanced" | "complete" | "subgraph_complete";
  readonly isError: false;
  readonly previousNode: string;
  readonly edgeTaken: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly traversalHistory?: readonly string[];
  readonly subgraphPushed?: SubgraphPushedInfo;
  readonly completedGraph?: string;
  readonly returnedContext?: Readonly<Record<string, unknown>>;
  readonly stackDepth?: number;
  readonly resumedNode?: string;
}

export interface AdvanceErrorResult {
  readonly status: "error";
  readonly isError: true;
  readonly currentNode: string;
  readonly reason: string;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
}

export type AdvanceResult = AdvanceSuccessResult | AdvanceErrorResult;

export interface ContextSetResult {
  readonly status: "updated";
  readonly isError: false;
  readonly currentNode: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly validTransitions: readonly TransitionInfo[];
  readonly turnCount: number;
  readonly turnWarning: string | null;
}

export interface StackEntry {
  readonly graphId: string;
  readonly suspendedAt?: string;
  readonly currentNode?: string;
}

export interface InspectPositionResult {
  readonly graphId: string;
  readonly graphName: string;
  readonly currentNode: string;
  readonly node: NodeInfo;
  readonly validTransitions: readonly TransitionInfo[];
  readonly context: Readonly<Record<string, unknown>>;
  readonly turnCount: number;
  readonly turnWarning: string | null;
  readonly stackDepth: number;
  readonly stack: readonly StackEntry[];
}

export interface HistoryEntry {
  readonly node: string;
  readonly edge: string;
  readonly timestamp: string;
  readonly contextSnapshot: Readonly<Record<string, unknown>>;
}

export interface ContextHistoryEntry {
  readonly key: string;
  readonly value: unknown;
  readonly setAt: string;
  readonly timestamp: string;
}

export interface InspectHistoryResult {
  readonly graphId: string;
  readonly currentNode: string;
  readonly traversalHistory: readonly HistoryEntry[];
  readonly contextHistory: readonly ContextHistoryEntry[];
}

export interface InspectFullResult {
  readonly graphId: string;
  readonly currentNode: string;
  readonly definition: GraphDefinition;
  readonly context: Readonly<Record<string, unknown>>;
}

export type InspectResult = InspectPositionResult | InspectHistoryResult | InspectFullResult;

export interface ClearedStackEntry {
  readonly graphId: string;
  readonly node: string;
}

export interface ResetResult {
  readonly status: "reset";
  readonly previousGraph: string | null;
  readonly previousNode: string | null;
  readonly message: string;
  readonly clearedStack?: readonly ClearedStackEntry[];
}

// SessionState is mutable internal state — no readonly
export interface SessionState {
  graphId: string;
  currentNode: string;
  context: Record<string, unknown>;
  history: HistoryEntry[];
  contextHistory: ContextHistoryEntry[];
  turnCount: number;
  startedAt: string;
}

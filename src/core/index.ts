/**
 * freelance/core — Pure graph definition, validation, and traversal.
 *
 * No SQLite. No MCP. No native dependencies.
 * Import from "freelance/core" to use GraphBuilder, GraphEngine,
 * and schema types without pulling in better-sqlite3.
 */

// Graph construction and loading
export { GraphBuilder } from "../builder.js";
export type { NodeInput } from "../builder.js";
export { loadSingleGraph, loadGraphs, validateAndBuild, resolveContextDefaults } from "../loader.js";

// Graph engine
export { GraphEngine } from "../engine/index.js";

// Schema
export {
  graphDefinitionSchema,
  nodeDefinitionSchema,
  edgeDefinitionSchema,
  validationRuleSchema,
  sourceBindingSchema,
} from "../schema/graph-schema.js";

// Expression evaluator
export { evaluate, validateExpression } from "../evaluator.js";

// Source hashing
export { hashContent, hashSource, hashSources, checkSourcesDetailed } from "../sources.js";

// Errors
export { EngineError } from "../errors.js";

// Types
export type {
  ValidatedGraph,
  GraphDefinition,
  NodeDefinition,
  EdgeDefinition,
  ValidationRule,
  SubgraphDefinition,
  ReturnSchema,
  SourceBinding,
  WaitOnEntry,
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
  TransitionInfo,
  NodeInfo,
  TraversalInfo,
  TraversalListResult,
} from "../types.js";

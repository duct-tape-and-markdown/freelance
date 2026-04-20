/**
 * freelance/core — Pure graph definition, validation, and traversal.
 *
 * No SQLite. No MCP. No native dependencies.
 * Import from "freelance/core" to use GraphBuilder, GraphEngine,
 * and schema types without pulling in better-sqlite3.
 */

export type { NodeInput } from "../builder.js";
// Graph construction and loading
export { GraphBuilder } from "../builder.js";
// Graph engine
export { GraphEngine } from "../engine/index.js";
// Errors
export { EngineError } from "../errors.js";
// Expression evaluator
export { evaluate, validateExpression } from "../evaluator.js";
export {
  loadGraphs,
  loadSingleGraph,
  resolveContextDefaults,
  validateAndBuild,
} from "../loader.js";
// Schema
export {
  edgeDefinitionSchema,
  graphDefinitionSchema,
  nodeDefinitionSchema,
  sourceBindingSchema,
  validationRuleSchema,
} from "../schema/graph-schema.js";
// Source hashing
export { checkSourcesDetailed, hashContent, hashSource, hashSources } from "../sources.js";

// Types
export type {
  AdvanceErrorResult,
  AdvanceResult,
  AdvanceSuccessResult,
  ContextSetResult,
  EdgeDefinition,
  GraphDefinition,
  InspectField,
  InspectFieldProjections,
  InspectHistoryResult,
  InspectPositionResult,
  InspectResult,
  NodeDefinition,
  NodeInfo,
  ResetResult,
  ReturnSchema,
  SessionState,
  SourceBinding,
  StartResult,
  SubgraphDefinition,
  TransitionInfo,
  TraversalInfo,
  TraversalListResult,
  ValidatedGraph,
  ValidationRule,
  WaitOnEntry,
} from "../types.js";

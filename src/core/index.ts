/**
 * freelance/core — Pure graph definition, validation, and traversal.
 *
 * No SQLite, no native dependencies. Import from "freelance/core" to
 * use GraphBuilder, GraphEngine, and schema types without pulling in
 * `node:sqlite`.
 */

export type { NodeInput } from "../builder.js";
// Graph construction and loading
export { GraphBuilder } from "../builder.js";
export type { ResponseMode } from "../engine/index.js";
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
  AdvanceErrorMinimalResult,
  AdvanceErrorResult,
  AdvanceMinimalResult,
  AdvanceResult,
  AdvanceSuccessMinimalResult,
  AdvanceSuccessResult,
  ContextSetMinimalResult,
  ContextSetResult,
  EdgeDefinition,
  GraphDefinition,
  InspectField,
  InspectFieldProjections,
  InspectHistoryResult,
  InspectMinimalResult,
  InspectPositionMinimalResult,
  InspectPositionResult,
  InspectResult,
  LoadError,
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

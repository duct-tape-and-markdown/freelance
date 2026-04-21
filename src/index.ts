/**
 * freelance-mcp — library entry point.
 *
 * Convenience re-exports for programmatic consumers. Importing this module
 * has no side effects — no CLI is launched.
 *
 * Public subpath exports (see package.json#exports):
 *
 *   freelance-mcp          → this file (engine + persistence)
 *   freelance-mcp/core     → engine + schema only, no persistence
 */

export type { NodeInput, ValidatedGraph } from "./core/index.js";
export { EngineError, GraphBuilder, GraphEngine } from "./core/index.js";
export { MemoryStore } from "./memory/index.js";
export { TraversalStore } from "./state/index.js";

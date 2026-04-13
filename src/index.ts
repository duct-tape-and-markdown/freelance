/**
 * freelance-mcp — library entry point.
 *
 * Convenience re-exports for programmatic consumers. Importing this module
 * has no side effects — no CLI is launched, no server is started.
 *
 * Public subpath exports (see package.json#exports):
 *
 *   freelance-mcp          → this file (engine + MCP factory + persistence)
 *   freelance-mcp/core     → engine + schema only, no persistence graph
 *
 * All other internals (state, memory, server) are reachable via the root
 * entry via re-export, but do not have dedicated subpath exports.
 */

export type { NodeInput, ValidatedGraph } from "./core/index.js";
// Core engine and schema
export { EngineError, GraphBuilder, GraphEngine } from "./core/index.js";
export { MemoryStore } from "./memory/index.js";
export type { ServerOptions } from "./server.js";
// MCP server
export { createServer, startServer } from "./server.js";
// Persistence
export { TraversalStore } from "./state/index.js";

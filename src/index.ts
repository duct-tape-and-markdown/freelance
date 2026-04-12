/**
 * freelance-mcp — library entry point.
 *
 * Convenience re-exports for programmatic consumers. Importing this module
 * has no side effects — no CLI is launched, no server is started.
 *
 * For a minimal surface without the persistence layer, import from
 * "freelance-mcp/core" instead. Subpath exports:
 *
 *   freelance-mcp          → this file (full API)
 *   freelance-mcp/core     → engine + schema only, no persistence
 *   freelance-mcp/state    → TraversalStore
 *   freelance-mcp/memory   → MemoryStore
 *   freelance-mcp/server   → createServer + startServer
 */

// Core engine and schema
export { GraphBuilder, GraphEngine, EngineError } from "./core/index.js";
export type { ValidatedGraph, NodeInput } from "./core/index.js";

// MCP server
export { createServer, startServer } from "./server.js";
export type { ServerOptions } from "./server.js";

// Persistence
export { TraversalStore } from "./state/index.js";
export { MemoryStore } from "./memory/index.js";

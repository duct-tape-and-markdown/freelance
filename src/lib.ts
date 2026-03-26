/**
 * Freelance library exports.
 *
 * Use these when consuming Freelance programmatically (e.g., integration layers).
 * The CLI entry point is index.ts — this file is for library consumers.
 */

export { startServer, createServer } from "./server.js";
export type { ServerOptions } from "./server.js";
export { resolveGraphsDirs, loadGraphsOrFatal } from "./graph-resolution.js";
export { hashSources, checkSourcesDetailed, validateGraphSources } from "./sources.js";
export type { SectionResolver, SourceRef, HashedSource, SourceCheckResult } from "./sources.js";

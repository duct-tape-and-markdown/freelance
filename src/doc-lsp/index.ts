/**
 * Document LSP public API.
 *
 * Re-exports everything needed to use the Doc LSP as a library or server.
 */

export { DocumentIndexStore } from "./index-builder.js";
export { DocLspTools } from "./tools.js";
export { loadConfig } from "./config.js";
export { parseDocument, extractSectionContent, compilePatterns } from "./parser.js";
export { normalizeContent, hashContent } from "./hash.js";
export { watchCorpora } from "./watcher.js";
export { createDocLspServer, startDocLspServer } from "./server.js";
export type {
  DocLspConfig,
  CorpusConfig,
  IdPattern,
  HeadingInfo,
  SectionRange,
  DocumentIndex,
  IdLocation,
  DocResolveResult,
  DocSectionResult,
  DocStructureResult,
  DocDependenciesResult,
  DocCoverageResult,
  DependencyRef,
  CoverageEntry,
} from "./types.js";

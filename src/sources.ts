/**
 * Source bindings for Freelance graphs.
 *
 * Provides content hashing and drift detection for graph nodes that
 * reference documentation sources. This module is self-contained —
 * it operates on file paths and section identifiers, using a pluggable
 * section resolver when available, or falling back to whole-file hashing.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GraphDefinition } from "./schema/graph-schema.js";

// --- Content hashing ---

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Hash content using SHA-256, returning the first 16 hex characters.
 * Content is normalized (CRLF→LF, trimEnd) before hashing. Used for
 * source file hashing; see `hashPropContent` in `memory/store.ts` for
 * the stricter normalization used on proposition content.
 */
export function hashContent(content: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeContent(content))
    .digest("hex")
    .substring(0, 16);
}

/**
 * Hash an on-disk source file by absolute path. Returns null when the
 * file is missing or unreadable — every memory-side caller (emit,
 * staleness, prune) treats "can't read the file" as "no live hash for
 * this path right now", not as an error. Read known-UTF-8 today; the
 * binary-safe switch is tracked in docs/debt.md.
 */
export function hashSourceFile(absPath: string): string | null {
  try {
    return hashContent(fs.readFileSync(absPath, "utf-8"));
  } catch {
    return null;
  }
}

// --- Types ---

interface SourceRef {
  path: string;
  section?: string;
}

interface HashedSource {
  path: string;
  section?: string;
  hash: string;
}

interface SourceHashResult {
  hash: string;
  sources: HashedSource[];
}

interface DriftedSource {
  path: string;
  section?: string;
  expected: string;
  actual: string;
}

interface SourceCheckResult {
  valid: boolean;
  drifted: DriftedSource[];
}

interface NodeSourceWarning {
  node: string;
  drifted: Array<{ path: string; section?: string }>;
}

interface SourceValidationResult {
  valid: boolean;
  warnings: NodeSourceWarning[];
}

export interface SourceOptions {
  /** Resolver for extracting section content (typically from Doc LSP). */
  resolver?: SectionResolver;
  /** Base directory for resolving relative source paths. Defaults to parent of graphsDir. [O-4] */
  basePath?: string;
}

/**
 * Resolve section content from a file.
 * If provided, the sectionResolver extracts section content (typically from the Doc LSP).
 * Falls back to whole-file content if no resolver or section not found.
 */
export type SectionResolver = (filePath: string, section: string) => string | null;

// --- Hashing ---

/**
 * Resolve a source path to an absolute path using basePath if provided. [O-4]
 */
function resolveSourcePath(sourcePath: string, basePath?: string): string {
  if (path.isAbsolute(sourcePath)) return sourcePath;
  if (basePath) return path.resolve(basePath, sourcePath);
  return path.resolve(sourcePath);
}

/**
 * Hash the content of a single source reference.
 */
export function hashSource(
  source: SourceRef,
  resolverOrOptions?: SectionResolver | SourceOptions,
): HashedSource {
  const opts = normalizeOptions(resolverOrOptions);
  const resolvedPath = resolveSourcePath(source.path, opts.basePath);
  const content = resolveContent(resolvedPath, source.section, opts.resolver);
  const hash = hashContent(content);
  return { path: source.path, section: source.section, hash };
}

/**
 * Hash multiple source references and produce a combined hash.
 * Sources are sorted by path+section before combining to ensure
 * deterministic hashes regardless of input order.
 */
export function hashSources(
  sources: SourceRef[],
  resolverOrOptions?: SectionResolver | SourceOptions,
): SourceHashResult {
  if (sources.length === 0) {
    return { hash: hashContent(""), sources: [] };
  }
  const opts = normalizeOptions(resolverOrOptions);
  const hashed = sources.map((s) => hashSource(s, opts));
  // Sort by path+section for deterministic combined hash
  const sorted = [...hashed].sort((a, b) => {
    const keyA = `${a.path}#${a.section ?? ""}`;
    const keyB = `${b.path}#${b.section ?? ""}`;
    return keyA.localeCompare(keyB);
  });
  const combinedHash = hashContent(sorted.map((h) => h.hash).join(":"));
  return { hash: combinedHash, sources: hashed };
}

/**
 * Check sources with per-source expected hashes for precise drift detection.
 * Handles missing files gracefully (reports as drifted with actual: "FILE_NOT_FOUND").
 */
export function checkSourcesDetailed(
  expectedSources: HashedSource[],
  resolverOrOptions?: SectionResolver | SourceOptions,
): SourceCheckResult {
  if (expectedSources.length === 0) {
    return { valid: true, drifted: [] };
  }
  const opts = normalizeOptions(resolverOrOptions);
  const drifted: DriftedSource[] = [];

  for (const expected of expectedSources) {
    try {
      const current = hashSource({ path: expected.path, section: expected.section }, opts);
      if (current.hash !== expected.hash) {
        drifted.push({
          path: expected.path,
          section: expected.section,
          expected: expected.hash,
          actual: current.hash,
        });
      }
    } catch {
      // File not found or unreadable — report as drifted
      drifted.push({
        path: expected.path,
        section: expected.section,
        expected: expected.hash,
        actual: "FILE_NOT_FOUND",
      });
    }
  }

  return { valid: drifted.length === 0, drifted };
}

/**
 * Validate all source bindings across a graph definition.
 * Returns warnings for any nodes with drifted sources.
 * Source paths resolve relative to basePath (typically parent of graphsDir), otherwise CWD. [O-4]
 */
export function validateGraphSources(
  definition: GraphDefinition,
  resolverOrOptions?: SectionResolver | SourceOptions,
): SourceValidationResult {
  const opts = normalizeOptions(resolverOrOptions);
  const warnings: NodeSourceWarning[] = [];

  // Check graph-level sources
  if (definition.sources && definition.sources.length > 0) {
    const result = checkSourcesDetailed(definition.sources, opts);
    if (!result.valid) {
      warnings.push({
        node: "(graph)",
        drifted: result.drifted.map((d) => ({
          path: d.path,
          section: d.section,
        })),
      });
    }
  }

  // Check node-level sources
  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (!node.sources || node.sources.length === 0) continue;

    const result = checkSourcesDetailed(node.sources, opts);
    if (!result.valid) {
      warnings.push({
        node: nodeId,
        drifted: result.drifted.map((d) => ({
          path: d.path,
          section: d.section,
        })),
      });
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Get detailed drift info (expected + actual hashes) for a specific node's sources.
 * Returns only sources that have actually drifted (hash mismatch or file not found).
 */
export function getDetailedDrift(
  definition: GraphDefinition,
  nodeId: string,
  opts?: SectionResolver | SourceOptions,
): DriftedSource[] {
  const normalizedOpts = normalizeOptions(opts);
  const sources =
    nodeId === "(graph)" ? (definition.sources ?? []) : (definition.nodes[nodeId]?.sources ?? []);

  const results: DriftedSource[] = [];

  for (const source of sources) {
    try {
      const current = hashSource({ path: source.path, section: source.section }, normalizedOpts);

      if (current.hash !== source.hash) {
        results.push({
          path: source.path,
          section: source.section,
          expected: source.hash,
          actual: current.hash,
        });
      }
    } catch {
      results.push({
        path: source.path,
        section: source.section,
        expected: source.hash,
        actual: "FILE_NOT_FOUND",
      });
    }
  }

  return results;
}

// --- Private ---

function normalizeOptions(resolverOrOptions?: SectionResolver | SourceOptions): SourceOptions {
  if (!resolverOrOptions) return {};
  if (typeof resolverOrOptions === "function") return { resolver: resolverOrOptions };
  return resolverOrOptions;
}

function resolveContent(
  absolutePath: string,
  section: string | undefined,
  resolver?: SectionResolver,
): string {
  if (section && resolver) {
    const sectionContent = resolver(absolutePath, section);
    if (sectionContent !== null) return sectionContent;
  }

  // Fall back to whole file
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Source file not found: ${absolutePath}`);
  }
  return fs.readFileSync(absolutePath, "utf-8");
}

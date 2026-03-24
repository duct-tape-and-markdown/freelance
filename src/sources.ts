/**
 * Source bindings for Freelance graphs.
 *
 * Provides content hashing and drift detection for graph nodes that
 * reference documentation sources. This module is self-contained —
 * it operates on file paths and section identifiers, using the Doc LSP
 * for section extraction when available, or falling back to whole-file
 * hashing.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { GraphDefinition } from "./schema/graph-schema.js";

// --- Types ---

export interface SourceRef {
  path: string;
  section?: string;
}

export interface HashedSource {
  path: string;
  section?: string;
  hash: string;
}

export interface SourceHashResult {
  hash: string;
  sources: HashedSource[];
}

export interface DriftedSource {
  path: string;
  section?: string;
  expected: string;
  actual: string;
}

export interface SourceCheckResult {
  valid: boolean;
  drifted: DriftedSource[];
}

export interface NodeSourceWarning {
  node: string;
  drifted: Array<{ path: string; section?: string }>;
}

export interface SourceValidationResult {
  valid: boolean;
  warnings: NodeSourceWarning[];
}

/**
 * Resolve section content from a file.
 * If provided, the sectionResolver extracts section content (typically from the Doc LSP).
 * Falls back to whole-file content if no resolver or section not found.
 */
export type SectionResolver = (
  filePath: string,
  section: string
) => string | null;

// --- Hashing ---

/**
 * Hash the content of a single source reference.
 */
export function hashSource(
  source: SourceRef,
  resolver?: SectionResolver
): HashedSource {
  const content = resolveContent(source, resolver);
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
  resolver?: SectionResolver
): SourceHashResult {
  const hashed = sources.map((s) => hashSource(s, resolver));
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
 * Check whether a previously stamped hash still matches current source state.
 */
export function checkSources(
  expectedHash: string,
  sources: SourceRef[],
  resolver?: SectionResolver
): SourceCheckResult {
  const current = hashSources(sources, resolver);
  if (current.hash === expectedHash) {
    return { valid: true, drifted: [] };
  }

  // Find which individual sources drifted
  const drifted: DriftedSource[] = [];

  // Re-hash each source individually to find drift
  // We need the original per-source hashes to compare.
  // If the caller stored per-source hashes, they can use checkSourcesDetailed.
  // For the combined hash check, we just report all sources as potentially drifted.
  // This is conservative but correct.
  return { valid: false, drifted: current.sources.map((s) => ({
    path: s.path,
    section: s.section,
    expected: "unknown",
    actual: s.hash,
  })) };
}

/**
 * Check sources with per-source expected hashes for precise drift detection.
 * Handles missing files gracefully (reports as drifted with actual: "FILE_NOT_FOUND").
 */
export function checkSourcesDetailed(
  expectedSources: HashedSource[],
  resolver?: SectionResolver
): SourceCheckResult {
  const drifted: DriftedSource[] = [];

  for (const expected of expectedSources) {
    try {
      const current = hashSource(
        { path: expected.path, section: expected.section },
        resolver
      );
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
 */
export function validateGraphSources(
  definition: GraphDefinition,
  resolver?: SectionResolver
): SourceValidationResult {
  const warnings: NodeSourceWarning[] = [];

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    const sources = (node as Record<string, unknown>).sources as
      | Array<{ path: string; section?: string; hash: string }>
      | undefined;
    if (!sources || sources.length === 0) continue;

    const result = checkSourcesDetailed(sources, resolver);
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

// --- Private ---

function resolveContent(source: SourceRef, resolver?: SectionResolver): string {
  if (source.section && resolver) {
    const sectionContent = resolver(source.path, source.section);
    if (sectionContent !== null) return sectionContent;
  }

  // Fall back to whole file
  if (!fs.existsSync(source.path)) {
    throw new Error(`Source file not found: ${source.path}`);
  }
  return fs.readFileSync(source.path, "utf-8");
}

/**
 * Normalize content before hashing: convert CRLF to LF, trim trailing whitespace.
 * This ensures stable hashes across platforms and minor whitespace edits.
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

function hashContent(content: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeContent(content))
    .digest("hex")
    .substring(0, 16);
}

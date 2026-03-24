/**
 * Shared content hashing utility.
 *
 * Normalizes content (CRLF→LF, trimEnd) before hashing to ensure
 * stable hashes across platforms and minor whitespace differences.
 *
 * Used by both the Doc LSP (doc_section) and source bindings
 * (graph_sources_hash / graph_sources_check) so hashes always agree.
 */

import crypto from "node:crypto";

/**
 * Normalize content before hashing: convert CRLF to LF, trim trailing whitespace.
 */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Hash content using SHA-256, returning the first 16 hex characters.
 * Content is normalized (CRLF→LF, trimEnd) before hashing.
 */
export function hashContent(content: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeContent(content))
    .digest("hex")
    .substring(0, 16);
}

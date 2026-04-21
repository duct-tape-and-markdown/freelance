/**
 * Per-proposition provenance staleness checking.
 *
 * A proposition is stale when any of its source files has drifted since
 * emit time. Drift is detected by re-hashing current content and
 * comparing against the hash recorded at emit time.
 *
 * Hash is the only authoritative signal — no mtime fast-path. mtime can
 * be preserved across edits (`git checkout`, `rsync -t`, `touch -r`,
 * archive extraction, coarse-resolution filesystems), so a stat-based
 * shortcut silently misses real drift. The per-call `StalenessCache`
 * below amortizes re-reads across source files shared by multiple
 * propositions in one query, so the honest hash check is cheap in
 * practice. Every public read on MemoryStore creates a fresh cache and
 * lets it garbage-collect when the call returns.
 */

import path from "node:path";
import { hashSourceFile } from "../sources.js";
import type { Db } from "./db.js";

export interface StalenessCache {
  hashes: Map<string, string | null>;
}

export function createStalenessCache(): StalenessCache {
  return { hashes: new Map() };
}

function getCurrentFileHash(
  sourceRoot: string,
  cache: StalenessCache,
  filePath: string,
): string | null {
  const cached = cache.hashes.get(filePath);
  if (cache.hashes.has(filePath)) return cached ?? null;
  const resolvedPath = path.resolve(sourceRoot, filePath);
  const hash = hashSourceFile(resolvedPath);
  cache.hashes.set(filePath, hash);
  return hash;
}

/**
 * True if the file's current content hash doesn't match what was stored
 * at emit time. A missing file (unreadable) is treated as changed — the
 * proposition can't be valid if its source is gone.
 */
export function isFileChanged(
  sourceRoot: string,
  cache: StalenessCache,
  filePath: string,
  storedHash: string,
): boolean {
  const currentHash = getCurrentFileHash(sourceRoot, cache, filePath);
  return currentHash === null || currentHash !== storedHash;
}

/**
 * Scan proposition_sources and return the set of propositions that have
 * at least one drifted source file. Uses the cache to avoid re-stating
 * files that multiple propositions share.
 */
export function getStalePropositionIds(
  db: Db,
  sourceRoot: string,
  cache: StalenessCache,
): Set<string> {
  const rows = db
    .prepare("SELECT proposition_id, file_path, content_hash FROM proposition_sources")
    .all() as Array<{
    proposition_id: string;
    file_path: string;
    content_hash: string;
  }>;

  const stale = new Set<string>();
  for (const { proposition_id, file_path, content_hash } of rows) {
    if (stale.has(proposition_id)) continue;
    if (isFileChanged(sourceRoot, cache, file_path, content_hash)) {
      stale.add(proposition_id);
    }
  }
  return stale;
}

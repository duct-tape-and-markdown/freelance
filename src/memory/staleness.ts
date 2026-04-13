/**
 * Per-proposition provenance staleness checking.
 *
 * A proposition is stale when at least one of its source files has
 * drifted since emit time. Drift is detected by mtime-match first
 * (fast path, ~microseconds via fs.statSync) and falls back to a
 * full SHA256 re-hash (slow path) only when mtimes disagree.
 *
 * The `StalenessCache` is a per-call scratchpad: every public read
 * on MemoryStore creates a fresh cache, threads it through staleness
 * checks to avoid redundant stat()/read() calls within that one
 * operation, and lets it garbage-collect when the call returns.
 * That bounds cache growth to the working set of a single query —
 * no long-lived state, no explicit eviction needed.
 */

import fs from "node:fs";
import path from "node:path";
import { hashContent } from "../sources.js";
import type { Db } from "./db.js";

export interface StalenessCache {
  mtimes: Map<string, number | null>;
  hashes: Map<string, string | null>;
}

export function createStalenessCache(): StalenessCache {
  return { mtimes: new Map(), hashes: new Map() };
}

function mtimeOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function hashFile(filePath: string): string | null {
  try {
    return hashContent(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/** Fast path: stat() to get current mtime (~microseconds vs read+hash ~milliseconds). */
function getCurrentMtime(
  sourceRoot: string,
  cache: StalenessCache,
  filePath: string,
): number | null {
  const cached = cache.mtimes.get(filePath);
  if (cache.mtimes.has(filePath)) return cached ?? null;
  const resolvedPath = path.resolve(sourceRoot, filePath);
  const mtime = mtimeOf(resolvedPath);
  cache.mtimes.set(filePath, mtime);
  return mtime;
}

/** Slow path: read + SHA256. Fallback when mtimes disagree (or weren't recorded). */
function getCurrentFileHash(
  sourceRoot: string,
  cache: StalenessCache,
  filePath: string,
): string | null {
  const cached = cache.hashes.get(filePath);
  if (cache.hashes.has(filePath)) return cached ?? null;
  const resolvedPath = path.resolve(sourceRoot, filePath);
  const hash = hashFile(resolvedPath);
  cache.hashes.set(filePath, hash);
  return hash;
}

/** True if the file's current content hash doesn't match what was stored at emit time. */
export function isFileChanged(
  sourceRoot: string,
  cache: StalenessCache,
  filePath: string,
  storedHash: string,
  storedMtime: number | null,
): boolean {
  if (storedMtime != null) {
    const currentMtime = getCurrentMtime(sourceRoot, cache, filePath);
    if (currentMtime !== null && currentMtime === storedMtime) {
      return false;
    }
  }
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
    .prepare("SELECT proposition_id, file_path, content_hash, mtime_ms FROM proposition_sources")
    .all() as Array<{
    proposition_id: string;
    file_path: string;
    content_hash: string;
    mtime_ms: number | null;
  }>;

  const stale = new Set<string>();
  for (const { proposition_id, file_path, content_hash, mtime_ms } of rows) {
    if (stale.has(proposition_id)) continue;
    if (isFileChanged(sourceRoot, cache, file_path, content_hash, mtime_ms)) {
      stale.add(proposition_id);
    }
  }
  return stale;
}

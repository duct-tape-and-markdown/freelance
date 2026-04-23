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
 * Name of the TEMP TABLE populated by `materializeStalePropIds`. The
 * read-side queries in `enrichment.ts` + `store.ts` join against it
 * (`NOT EXISTS (SELECT 1 FROM _stale_prop_ids ...)`) instead of
 * spreading ids into a dynamically-sized `NOT IN (?, ?, ?, …)` clause,
 * which would hit SQLite's `SQLITE_MAX_VARIABLE_NUMBER` ceiling on
 * large stale sets and churn the prepared-statement cache across
 * differently-sized stale sets.
 *
 * An empty table means "no stale props" — `NOT EXISTS` returns TRUE
 * for every row, which correctly counts all propositions as valid.
 */
export const STALE_PROP_IDS_TABLE = "_stale_prop_ids";

// Bulk-insert batch size — well under SQLite's default variable limit
// (32766) so materialization never hits the very ceiling it's meant to
// sidestep, regardless of stale-set cardinality.
const STALE_PROP_BATCH_SIZE = 500;

/**
 * Scan proposition_sources and return the set of propositions that have
 * at least one drifted source file. Pure — no side effects on the db
 * handle. The cache amortizes hashSourceFile calls across propositions
 * sharing source files within one operation.
 *
 * Reads that join against `STALE_PROP_IDS_TABLE` must follow this with
 * `materializeStalePropIds(db, stalePropIds)` to populate the temp
 * table. Reads that consume the Set directly (notably `status()`) skip
 * the materialization — the temp-table population is non-trivial work
 * (DELETE plus batched INSERTs over the whole stale set) and pure
 * waste when no join consumes it.
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

/**
 * Build a `NOT EXISTS (… STALE_PROP_IDS_TABLE …)` SQL fragment keyed
 * off the supplied proposition-id expression (e.g. `"a.proposition_id"`,
 * `"p.id"`). Use everywhere a read needs to filter stale propositions
 * out, so the table name + filter shape live in one place and the
 * prepared-statement cache reuses one SQL string per call site.
 *
 * `propIdExpr` is interpolated raw into SQL — callers must pass a
 * trusted literal SQL identifier, never user input.
 */
export function notStaleExists(propIdExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM ${STALE_PROP_IDS_TABLE} _s WHERE _s.proposition_id = ${propIdExpr})`;
}

/**
 * Populate `STALE_PROP_IDS_TABLE` on `db` so subsequent read queries
 * can join against it. Must be called before any helper in
 * `enrichment.ts` runs (every helper there assumes the table reflects
 * the current stale set).
 */
export function materializeStalePropIds(db: Db, stalePropIds: Set<string>): void {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS ${STALE_PROP_IDS_TABLE} (proposition_id TEXT PRIMARY KEY) WITHOUT ROWID`,
  );
  db.exec(`DELETE FROM ${STALE_PROP_IDS_TABLE}`);
  if (stalePropIds.size === 0) return;

  const ids = [...stalePropIds];
  for (let i = 0; i < ids.length; i += STALE_PROP_BATCH_SIZE) {
    const batch = ids.slice(i, i + STALE_PROP_BATCH_SIZE);
    const placeholders = batch.map(() => "(?)").join(",");
    db.prepare(`INSERT INTO ${STALE_PROP_IDS_TABLE} (proposition_id) VALUES ${placeholders}`).run(
      ...batch,
    );
  }
}

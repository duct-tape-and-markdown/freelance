/**
 * Read-side helpers for MemoryStore: scalar/aggregate queries, bulk
 * fetches over a db handle, and pure projections from row + pre-fetched
 * joins to the wire shape. Stateless — every input flows through
 * parameters, including the staleness cache and source root that the
 * projection helpers need.
 */

import { countQuery, type Db, sqlPlaceholders } from "./db.js";
import { isFileChanged, notStaleExists, type StalenessCache } from "./staleness.js";
import type { NeighborEntity, PropositionInfo, PropositionRow, StatusResult } from "./types.js";

// Every query below joins against `STALE_PROP_IDS_TABLE` via
// `notStaleExists`. Callers MUST invoke `materializeStalePropIds(db,
// stalePropIds)` on the same db handle before any of these helpers
// runs — otherwise the table reflects the previous read's stale set
// (or is empty on a fresh connection) and the joins return wrong
// counts. The TEMP-TABLE shape (vs spreading ids inline as
// `NOT IN (?, ?, …)`) keeps us clear of SQLite's
// `SQLITE_MAX_VARIABLE_NUMBER` ceiling and lets the prepared-statement
// cache reuse one SQL string across calls.
const NOT_STALE_EXISTS_FILTER = notStaleExists("a1.proposition_id");

/**
 * Co-occurring entities for a given entity. Ranks by count of shared
 * propositions that are currently valid. Optionally attaches a sample
 * proposition string. `limit`/`offset` paginate the result set; omit
 * both to return every neighbor (used by `inspect` where neighbors are
 * an always-full sidecar of the entity summary).
 */
export function getNeighbors(
  db: Db,
  entityId: string,
  options?: { withSample?: boolean; limit?: number; offset?: number },
): Array<NeighborEntity & { sample?: string | null }> {
  const withSample = options?.withSample ?? false;

  const sampleCol = withSample
    ? `, (SELECT p2.content FROM propositions p2
             JOIN about s1 ON p2.id = s1.proposition_id
             JOIN about s2 ON p2.id = s2.proposition_id
             WHERE s1.entity_id = ? AND s2.entity_id = e2.id
             ORDER BY p2.rowid DESC LIMIT 1) as sample`
    : "";
  const sampleParams: unknown[] = withSample ? [entityId] : [];

  const paginated = options?.limit !== undefined;
  const pageClause = paginated ? "LIMIT ? OFFSET ?" : "";
  const pageParams: unknown[] = paginated ? [options.limit, options?.offset ?? 0] : [];

  return db
    .prepare(
      `SELECT e2.id, e2.name, e2.kind,
            COUNT(DISTINCT a1.proposition_id) as shared_propositions,
            COUNT(DISTINCT CASE WHEN ${NOT_STALE_EXISTS_FILTER} THEN a1.proposition_id END) as valid_shared_propositions${sampleCol}
     FROM about a1
     JOIN about a2 ON a1.proposition_id = a2.proposition_id
     JOIN entities e2 ON a2.entity_id = e2.id
     WHERE a1.entity_id = ? AND a2.entity_id != a1.entity_id
     GROUP BY e2.id
     ORDER BY valid_shared_propositions DESC
     ${pageClause}`,
    )
    .all(...sampleParams, entityId, ...pageParams) as Array<
    NeighborEntity & { sample?: string | null }
  >;
}

/**
 * Count co-occurring entities for a given entity — the "total" sibling
 * of a paginated `getNeighbors` call. Uses `about` self-join without
 * staleness filtering since the pagination total is frame-independent:
 * we want to know how many neighbors exist so the caller knows whether
 * to page, not how many are currently valid.
 */
export function countNeighbors(db: Db, entityId: string): number {
  return countQuery(
    db,
    `SELECT COUNT(DISTINCT a2.entity_id)
     FROM about a1
     JOIN about a2 ON a1.proposition_id = a2.proposition_id
     WHERE a1.entity_id = ? AND a2.entity_id != a1.entity_id`,
    entityId,
  );
}

/** Count propositions about an entity that are currently valid. */
export function countValidForEntity(db: Db, entityId: string): number {
  return countQuery(
    db,
    `SELECT COUNT(*) FROM about a1
     WHERE a1.entity_id = ? AND ${NOT_STALE_EXISTS_FILTER}`,
    entityId,
  );
}

/** Aggregate status counts for memory_status. */
export function computeStatus(db: Db, stalePropIds: Set<string>): StatusResult {
  const totalProps = countQuery(db, "SELECT COUNT(*) FROM propositions");
  const totalEntities = countQuery(db, "SELECT COUNT(*) FROM entities");

  const validCount = stalePropIds.size === 0 ? totalProps : totalProps - stalePropIds.size;

  return {
    total_propositions: totalProps,
    valid_propositions: validCount,
    stale_propositions: totalProps - validCount,
    total_entities: totalEntities,
  };
}

/**
 * Bulk-fetch `proposition_sources` for a list of proposition ids and
 * group by id. Replaces the per-row SELECT pattern (one query per
 * returned proposition; up to MAX_PAGE_LIMIT round-trips per read).
 * Caller-supplied `propIds` is bounded by pagination well below
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` ceiling.
 */
export function fetchSourcesByProp(
  db: Db,
  propIds: readonly string[],
): Map<string, Array<{ file_path: string; content_hash: string }>> {
  if (propIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT proposition_id, file_path, content_hash
       FROM proposition_sources
       WHERE proposition_id IN (${sqlPlaceholders(propIds.length)})`,
    )
    .all(...propIds) as Array<{
    proposition_id: string;
    file_path: string;
    content_hash: string;
  }>;
  return groupByProp(rows, (r) => ({ file_path: r.file_path, content_hash: r.content_hash }));
}

/** Search-side companion to `fetchSourcesByProp`. */
export function fetchEntitiesByProp(
  db: Db,
  propIds: readonly string[],
): Map<string, Array<{ id: string; name: string; kind: string | null }>> {
  if (propIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT a.proposition_id, e.id, e.name, e.kind
       FROM entities e
       JOIN about a ON e.id = a.entity_id
       WHERE a.proposition_id IN (${sqlPlaceholders(propIds.length)})`,
    )
    .all(...propIds) as Array<{
    proposition_id: string;
    id: string;
    name: string;
    kind: string | null;
  }>;
  return groupByProp(rows, (r) => ({ id: r.id, name: r.name, kind: r.kind }));
}

/**
 * Project a proposition row + its pre-fetched sources into the
 * full-shape `PropositionInfo`. The staleness cache amortizes
 * source-file hashing across propositions sharing the same files in
 * one read.
 */
export function enrichProposition(
  sourceRoot: string,
  cache: StalenessCache,
  row: PropositionRow,
  propSources: ReadonlyArray<{ file_path: string; content_hash: string }>,
): PropositionInfo {
  const sourceFiles = propSources.map((sf) => ({
    path: sf.file_path,
    hash: sf.content_hash,
    current_match: !isFileChanged(sourceRoot, cache, sf.file_path, sf.content_hash),
  }));

  const valid = sourceFiles.length === 0 || sourceFiles.every((sf) => sf.current_match);

  return {
    id: row.id,
    content: row.content,
    created_at: row.created_at,
    valid,
    source_files: sourceFiles,
  };
}

/**
 * Group bulk-fetched rows by `proposition_id` into a `Map<id, T[]>`,
 * projecting each row to the value shape via `pick`. Local helper for
 * `fetchSourcesByProp` / `fetchEntitiesByProp` — both run a single
 * `IN (?, ?, …)` query and need the same per-prop bucketing.
 */
function groupByProp<R extends { proposition_id: string }, T>(
  rows: readonly R[],
  pick: (row: R) => T,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    let arr = out.get(r.proposition_id);
    if (!arr) {
      arr = [];
      out.set(r.proposition_id, arr);
    }
    arr.push(pick(r));
  }
  return out;
}

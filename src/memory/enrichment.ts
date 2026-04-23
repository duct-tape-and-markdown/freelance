/**
 * Query helpers for MemoryStore's read-side operations.
 *
 * Pure functions that take a database handle plus whatever pre-computed
 * staleness info the caller has, and return enriched query results.
 * Kept stateless so MemoryStore's public methods can orchestrate without
 * these helpers holding any state of their own.
 */

import { countQuery, type Db } from "./db.js";
import { notStaleExists } from "./staleness.js";
import type { NeighborEntity, StatusResult } from "./types.js";

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

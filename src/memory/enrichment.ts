/**
 * Query helpers for MemoryStore's read-side operations.
 *
 * Pure functions that take a database handle plus whatever pre-computed
 * staleness info the caller has, and return enriched query results.
 * Kept stateless so MemoryStore's public methods can orchestrate without
 * these helpers holding any state of their own.
 */

import type { Db } from "./db.js";
import type { NeighborEntity, StatusResult } from "./types.js";

/**
 * Co-occurring entities for a given entity. Ranks by count of shared
 * propositions that are currently valid. Optionally attaches a sample
 * proposition string.
 */
export function getNeighbors(
  db: Db,
  entityId: string,
  stalePropIds: Set<string>,
  options?: { withSample?: boolean },
): Array<NeighborEntity & { sample?: string | null }> {
  const withSample = options?.withSample ?? false;

  const staleParams = [...stalePropIds];
  const staleFilter =
    staleParams.length > 0
      ? `a1.proposition_id NOT IN (${staleParams.map(() => "?").join(",")})`
      : "1";

  const sampleCol = withSample
    ? `, (SELECT p2.content FROM propositions p2
             JOIN about s1 ON p2.id = s1.proposition_id
             JOIN about s2 ON p2.id = s2.proposition_id
             WHERE s1.entity_id = ? AND s2.entity_id = e2.id
             ORDER BY p2.rowid DESC LIMIT 1) as sample`
    : "";
  const sampleParams: unknown[] = withSample ? [entityId] : [];

  return db
    .prepare(
      `SELECT e2.id, e2.name, e2.kind,
            COUNT(DISTINCT a1.proposition_id) as shared_propositions,
            COUNT(DISTINCT CASE WHEN ${staleFilter} THEN a1.proposition_id END) as valid_shared_propositions${sampleCol}
     FROM about a1
     JOIN about a2 ON a1.proposition_id = a2.proposition_id
     JOIN entities e2 ON a2.entity_id = e2.id
     WHERE a1.entity_id = ? AND a2.entity_id != a1.entity_id
     GROUP BY e2.id
     ORDER BY valid_shared_propositions DESC`,
    )
    .all(...staleParams, ...sampleParams, entityId) as Array<
    NeighborEntity & { sample?: string | null }
  >;
}

/** Count propositions about an entity that are currently valid. */
export function countValidForEntity(db: Db, entityId: string, stalePropIds: Set<string>): number {
  // Fast path: no stale props — skip the exclusion filter
  if (stalePropIds.size === 0) {
    return (
      db.prepare("SELECT COUNT(*) as c FROM about WHERE entity_id = ?").get(entityId) as {
        c: number;
      }
    ).c;
  }

  const staleParams = [...stalePropIds];
  const placeholders = staleParams.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM about
     WHERE entity_id = ? AND proposition_id NOT IN (${placeholders})`,
      )
      .get(entityId, ...staleParams) as { c: number }
  ).c;
}

/** Aggregate status counts for memory_status. */
export function computeStatus(db: Db, stalePropIds: Set<string>): StatusResult {
  const totalProps = (db.prepare("SELECT COUNT(*) as c FROM propositions").get() as { c: number })
    .c;

  const totalEntities = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;

  const validCount = stalePropIds.size === 0 ? totalProps : totalProps - stalePropIds.size;

  return {
    total_propositions: totalProps,
    valid_propositions: validCount,
    stale_propositions: totalProps - validCount,
    total_entities: totalEntities,
  };
}

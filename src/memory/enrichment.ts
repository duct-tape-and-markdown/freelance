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

/** Build an optional collection filter clause + params for WHERE appendage. */
export function collectionFilter(collection: string | undefined): {
  clause: string;
  params: unknown[];
} {
  if (!collection) return { clause: "", params: [] };
  return { clause: " AND p.collection = ?", params: [collection] };
}

/**
 * Co-occurring entities for a given entity. Ranks by count of shared
 * propositions that are currently valid. Optionally filters by collection
 * and attaches a sample proposition string.
 */
export function getNeighbors(
  db: Db,
  entityId: string,
  stalePropIds: Set<string>,
  options?: { withSample?: boolean; collection?: string },
): Array<NeighborEntity & { sample?: string | null }> {
  const withSample = options?.withSample ?? false;
  const collection = options?.collection;

  const staleParams = [...stalePropIds];
  const staleFilter =
    staleParams.length > 0
      ? `a1.proposition_id NOT IN (${staleParams.map(() => "?").join(",")})`
      : "1";

  const collFilter = collection ? " AND p.collection = ?" : "";
  const collParams: unknown[] = collection ? [collection] : [];

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
     JOIN propositions p ON a1.proposition_id = p.id
     WHERE a1.entity_id = ? AND a2.entity_id != a1.entity_id${collFilter}
     GROUP BY e2.id
     ORDER BY valid_shared_propositions DESC`,
    )
    .all(...staleParams, ...sampleParams, entityId, ...collParams) as Array<
    NeighborEntity & { sample?: string | null }
  >;
}

/** Count propositions about an entity that are currently valid. */
export function countValidForEntity(
  db: Db,
  entityId: string,
  stalePropIds: Set<string>,
  collection?: string,
): number {
  // Fast path: no stale props and no collection filter — skip JOIN
  if (stalePropIds.size === 0 && !collection) {
    return (
      db.prepare("SELECT COUNT(*) as c FROM about WHERE entity_id = ?").get(entityId) as {
        c: number;
      }
    ).c;
  }

  const coll = collectionFilter(collection);

  if (stalePropIds.size === 0) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE a.entity_id = ?${coll.clause}`,
        )
        .get(entityId, ...coll.params) as { c: number }
    ).c;
  }
  const staleParams = [...stalePropIds];
  const placeholders = staleParams.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM about a
     JOIN propositions p ON a.proposition_id = p.id
     WHERE a.entity_id = ? AND a.proposition_id NOT IN (${placeholders})${coll.clause}`,
      )
      .get(entityId, ...staleParams, ...coll.params) as { c: number }
  ).c;
}

/** Aggregate status counts for memory_status. Optionally scoped to a collection. */
export function computeStatus(
  db: Db,
  stalePropIds: Set<string>,
  collection?: string,
): StatusResult {
  const collWhere = collection ? " WHERE collection = ?" : "";
  const collParams: unknown[] = collection ? [collection] : [];

  const totalProps = (
    db.prepare(`SELECT COUNT(*) as c FROM propositions${collWhere}`).get(...collParams) as {
      c: number;
    }
  ).c;

  const totalEntities = collection
    ? (
        db
          .prepare(
            "SELECT COUNT(DISTINCT a.entity_id) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE p.collection = ?",
          )
          .get(collection) as { c: number }
      ).c
    : (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;

  let validCount: number;
  if (stalePropIds.size === 0) {
    validCount = totalProps;
  } else if (!collection) {
    validCount = totalProps - stalePropIds.size;
  } else {
    // Count only stale props that are in this collection
    const staleParams = [...stalePropIds];
    const placeholders = staleParams.map(() => "?").join(",");
    const staleInCollection = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM propositions WHERE id IN (${placeholders}) AND collection = ?`,
        )
        .get(...staleParams, collection) as { c: number }
    ).c;
    validCount = totalProps - staleInCollection;
  }

  return {
    total_propositions: totalProps,
    valid_propositions: validCount,
    stale_propositions: totalProps - validCount,
    total_entities: totalEntities,
  };
}

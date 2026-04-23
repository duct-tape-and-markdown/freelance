/** Entity domain queries: lookup, resolution, kind reconciliation. */

import { EC, EngineError } from "../errors.js";
import type { Db } from "./db.js";
import { generateId, now } from "./ids.js";
import type { EmitWarning, EntityRow } from "./types.js";

/**
 * Look up an entity by id (PK), exact name (`idx_entity_name`), or
 * case-insensitive name (`idx_entity_name_lower`). All three OR arms
 * are indexable so SQLite's OR-decomposition unions indexed lookups
 * instead of scanning; the CASE in ORDER BY picks the winner when
 * more than one matches. Throws `ENTITY_NOT_FOUND` if no row matches.
 */
export function findEntity(db: Db, idOrName: string): EntityRow {
  const entity = db
    .prepare(
      `SELECT id, name, kind, created_at FROM entities
       WHERE id = ?1 OR name = ?1 OR LOWER(name) = LOWER(?1)
       ORDER BY CASE
         WHEN id = ?1 THEN 0
         WHEN name = ?1 THEN 1
         ELSE 2
       END
       LIMIT 1`,
    )
    .get(idOrName) as EntityRow | undefined;
  if (!entity) {
    throw new EngineError(`Entity not found: ${idOrName}`, EC.ENTITY_NOT_FOUND);
  }
  return entity;
}

/**
 * Resolve an entity by name with a provided kind, creating it if
 * missing.
 *
 * Kind semantics:
 * - If the entity doesn't exist: create it with the given kind.
 * - If the entity exists with a null kind and a kind is provided:
 *   backfill the kind.
 * - If the entity exists with a non-null kind that differs from the
 *   provided kind: keep the existing kind (first-wins) and push an
 *   `entity_kind_conflict` warning for the caller. The store does not
 *   reconcile — surfacing the conflict is the feature.
 */
export function resolveEntity(
  db: Db,
  name: string,
  kind: string | undefined,
  warnings: EmitWarning[],
): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
  // One OR-decomposed lookup: idx_entity_name covers the exact arm,
  // idx_entity_name_lower covers the normalized arm. CASE rank in
  // ORDER BY picks the winner when both match (exact wins). Same
  // pattern as findEntity.
  const match = db
    .prepare(
      `SELECT id, name, kind,
              CASE WHEN name = ?1 THEN 'exact' ELSE 'normalized' END AS resolution
       FROM entities
       WHERE name = ?1 OR LOWER(TRIM(name)) = LOWER(TRIM(?1))
       ORDER BY CASE WHEN name = ?1 THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(name) as (EntityRow & { resolution: "exact" | "normalized" }) | undefined;
  if (match) {
    reconcileKind(db, match, kind, warnings);
    return { id: match.id, name: match.name, resolution: match.resolution };
  }

  const id = generateId();
  db.prepare("INSERT INTO entities (id, name, kind, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    kind ?? null,
    now(),
  );

  return { id, name, resolution: "created" };
}

/**
 * First-wins kind policy: if the existing entity has a kind that
 * disagrees with the provided one, surface a warning but keep the
 * stored kind. If the existing entity has no kind and one is provided,
 * backfill. No-op when the caller didn't specify `kind`.
 */
function reconcileKind(
  db: Db,
  existing: EntityRow,
  kind: string | undefined,
  warnings: EmitWarning[],
): void {
  if (!kind) return;
  if (existing.kind && existing.kind !== kind) {
    warnings.push({
      type: "entity_kind_conflict",
      entity: existing.name,
      existingKind: existing.kind,
      providedKind: kind,
    });
    return;
  }
  if (!existing.kind) {
    db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, existing.id);
  }
}

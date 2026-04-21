/**
 * MemoryStore — stateless, persistent knowledge graph.
 *
 * Every write goes through the `node:sqlite` layer; there is no in-memory
 * session state. Sources are attached per-proposition at emit time, so
 * staleness is computed per-proposition against the current filesystem.
 *
 * Read-side query helpers live in ./enrichment.ts (pure functions over a
 * db handle), and provenance staleness checking lives in ./staleness.ts
 * (per-call cache threaded through each public read so cache growth is
 * bounded to a single operation).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashContent } from "../sources.js";
import type { Db } from "./db.js";
import { computeStatus, countNeighbors, countValidForEntity, getNeighbors } from "./enrichment.js";
import {
  createStalenessCache,
  getStalePropositionIds,
  isFileChanged,
  type StalenessCache,
} from "./staleness.js";
import type {
  BrowseResult,
  BySourceResult,
  EmitProposition,
  EmitResult,
  EmitWarning,
  EntityInfo,
  EntityRow,
  InspectResult,
  MinimalProposition,
  PropositionInfo,
  PropositionRow,
  PropositionShape,
  RelatedResult,
  SearchResult,
  StatusResult,
} from "./types.js";

/**
 * Default page size + upper bound for paginated reads. Aligned with
 * `memory_browse` (and the broader token-economics guidance in issue
 * #86) so every paginated verb shares the same ceiling. Kept as module
 * constants so CLI and hook callers can reason about the cap without
 * re-deriving it.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (requested < 1) return 1;
  if (requested > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return Math.trunc(requested);
}

function clampOffset(requested: number | undefined): number {
  if (requested === undefined || requested < 0) return 0;
  return Math.trunc(requested);
}

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function hashFile(filePath: string): string | null {
  try {
    return hashContent(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Hash proposition content for dedup. Normalizes superficial variance
 * that doesn't change the claim — case, whitespace runs, trailing
 * sentence punctuation — before hashing. Internal punctuation is
 * preserved (commas/colons can carry meaning). Each transform is binary:
 * two claims collide on hash only when their normalized forms are
 * byte-identical. No thresholds, no similarity scoring.
 *
 * Stricter than the `hashContent` used for source-file hashing — file
 * drift detection needs minimal normalization so a real edit isn't
 * masked.
 */
function hashPropContent(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+\s*$/u, "")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

export class MemoryStore {
  private db: Db;
  private sourceRoot: string;
  private closed = false;

  // Takes an already-opened Db handle. Opening the database (PRAGMA +
  // DDL + schema check) is a composition-root concern and lives in
  // src/compose.ts — keeps this constructor pure and makes the class
  // trivially testable with an in-process db handle.
  constructor(db: Db, sourceRoot: string) {
    this.db = db;
    this.sourceRoot = sourceRoot;
  }

  // `prune` lives outside this class (content-reachability needs git
  // subprocesses; MemoryStore stays SQLite-only). The getters below
  // are a deliberate narrow window for that caller — not a general
  // "expose internals" pattern.
  getDb(): Db {
    return this.db;
  }
  getSourceRoot(): string {
    return this.sourceRoot;
  }

  // Idempotent — CLI paths that `process.exit` mid-command want to
  // close before exit, and the caller's `finally` also closes. Without
  // this guard, the second close hits an already-closed node:sqlite
  // handle and throws.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  resetAll(): { deleted_propositions: number; deleted_entities: number } {
    const propCount = (
      this.db.prepare("SELECT COUNT(*) as c FROM propositions").get() as { c: number }
    ).c;
    const entCount = (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number })
      .c;
    // Atomically — partial reset (propositions gone but entities left
    // orphaned) is worse than no reset, since the user now has stranded
    // entity rows the normal flow can't reach. Mirrors the prune BEGIN/
    // COMMIT/ROLLBACK pattern. `about` and `proposition_sources` cascade
    // via FK on proposition delete; FTS via the `propositions_ad` trigger.
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM propositions");
      this.db.exec("DELETE FROM entities");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { deleted_propositions: propCount, deleted_entities: entCount };
  }

  // --- Source path resolution ---

  /**
   * Validate a source file path against the source root. Returns the stored
   * (relative) path and the resolved absolute path. Throws if the path
   * escapes the source root.
   */
  private prepareSourcePath(filePath: string): {
    storedPath: string;
    resolvedPath: string;
  } {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.sourceRoot, filePath);

    const normalizedRoot = path.resolve(this.sourceRoot) + path.sep;
    const normalizedPath = path.resolve(resolvedPath);
    if (
      !normalizedPath.startsWith(normalizedRoot) &&
      normalizedPath !== path.resolve(this.sourceRoot)
    ) {
      throw new Error(`Source file is outside the source root: ${filePath}`);
    }

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    return { storedPath, resolvedPath };
  }

  // --- Proposition emission ---

  emit(propositions: EmitProposition[]): EmitResult {
    const collection = "default";
    const result: EmitResult = {
      created: 0,
      deduplicated: 0,
      entities_resolved: 0,
      entities_created: 0,
      propositions: [],
    };
    const warnings: EmitWarning[] = [];

    // DO NOTHING (not DO UPDATE) — if an existing row matches on
    // (content_hash, collection) the insert becomes a no-op and returns
    // no row. We then SELECT the existing id separately. This keeps emit
    // idempotent under retry and keeps the FTS index untouched on dedup
    // hits (there's no AFTER UPDATE trigger to churn regardless).
    const upsertProp = this.db.prepare(
      `INSERT INTO propositions (id, content, content_hash, collection, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, collection) DO NOTHING
       RETURNING id`,
    );
    const selectExistingProp = this.db.prepare(
      "SELECT id FROM propositions WHERE content_hash = ? AND collection = ?",
    );
    const insertAbout = this.db.prepare(
      "INSERT OR IGNORE INTO about (proposition_id, entity_id) VALUES (?, ?)",
    );
    const insertPropSource = this.db.prepare(
      "INSERT OR IGNORE INTO proposition_sources (proposition_id, file_path, content_hash) VALUES (?, ?, ?)",
    );

    for (const prop of propositions) {
      const contentHash = hashPropContent(prop.content);
      const newId = generateId();
      const inserted = upsertProp.get(newId, prop.content, contentHash, collection, now()) as
        | { id: string }
        | undefined;

      const propResult: EmitResult["propositions"][number] = {
        id: "",
        content: prop.content,
        status: "created",
        entities: [],
      };

      let propId: string;
      if (inserted) {
        propId = newId;
        propResult.status = "created";
        result.created++;
      } else {
        const existing = selectExistingProp.get(contentHash, collection) as { id: string };
        propId = existing.id;
        propResult.status = "deduplicated";
        result.deduplicated++;
      }
      propResult.id = propId;

      // Per-proposition source attribution. Each source file is hashed fresh
      // at emit time; if the file can't be read, the emit fails for this prop.
      for (const sourcePath of prop.sources) {
        const { storedPath, resolvedPath } = this.prepareSourcePath(sourcePath);
        const hash = hashFile(resolvedPath);
        if (hash === null) {
          throw new Error(`Cannot read source file "${sourcePath}" during emit.`);
        }
        insertPropSource.run(propId, storedPath, hash);
      }

      for (const entityName of prop.entities) {
        const kind = prop.entityKinds?.[entityName];
        const resolved = this.resolveEntity(entityName, kind, warnings);
        propResult.entities.push(resolved);
        insertAbout.run(propId, resolved.id);
        if (resolved.resolution === "created") {
          result.entities_created++;
        } else {
          result.entities_resolved++;
        }
      }

      result.propositions.push(propResult);
    }

    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result;
  }

  // --- Entity resolution ---

  /**
   * Resolve an entity by name with a provided kind, creating it if missing.
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
  private resolveEntity(
    name: string,
    kind: string | undefined,
    warnings: EmitWarning[],
  ): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
    const exact = this.db.prepare("SELECT id, name, kind FROM entities WHERE name = ?").get(name) as
      | EntityRow
      | undefined;
    if (exact) {
      if (kind && exact.kind && exact.kind !== kind) {
        warnings.push({
          type: "entity_kind_conflict",
          entity: exact.name,
          existingKind: exact.kind,
          providedKind: kind,
        });
      } else if (kind && !exact.kind) {
        this.db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, exact.id);
      }
      return { id: exact.id, name: exact.name, resolution: "exact" };
    }

    const normalized = name.toLowerCase().trim();
    const normMatch = this.db
      .prepare("SELECT id, name, kind FROM entities WHERE LOWER(TRIM(name)) = ?")
      .get(normalized) as EntityRow | undefined;
    if (normMatch) {
      if (kind && normMatch.kind && normMatch.kind !== kind) {
        warnings.push({
          type: "entity_kind_conflict",
          entity: normMatch.name,
          existingKind: normMatch.kind,
          providedKind: kind,
        });
      } else if (kind && !normMatch.kind) {
        this.db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, normMatch.id);
      }
      return { id: normMatch.id, name: normMatch.name, resolution: "normalized" };
    }

    const id = generateId();
    this.db
      .prepare("INSERT INTO entities (id, name, kind, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, kind ?? null, now());

    return { id, name, resolution: "created" };
  }

  // --- Entity lookup ---

  private findEntity(idOrName: string): EntityRow {
    const entity =
      (this.db.prepare("SELECT * FROM entities WHERE id = ?").get(idOrName) as
        | EntityRow
        | undefined) ??
      (this.db.prepare("SELECT * FROM entities WHERE name = ?").get(idOrName) as
        | EntityRow
        | undefined) ??
      (this.db
        .prepare("SELECT * FROM entities WHERE LOWER(name) = ?")
        .get(idOrName.toLowerCase()) as EntityRow | undefined);
    if (!entity) {
      throw new Error(`Entity not found: ${idOrName}`);
    }
    return entity;
  }

  // --- Query operations ---

  browse(options?: {
    name?: string;
    kind?: string;
    limit?: number;
    offset?: number;
    includeOrphans?: boolean;
  }): BrowseResult {
    const cache = createStalenessCache();
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const includeOrphans = options?.includeOrphans ?? false;

    let where = "1=1";
    const whereParams: unknown[] = [];

    if (options?.name) {
      where += " AND LOWER(e.name) LIKE ?";
      whereParams.push(`%${options.name.toLowerCase()}%`);
    }
    if (options?.kind) {
      where += " AND e.kind = ?";
      whereParams.push(options.kind);
    }

    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    const staleParams = [...stalePropIds];
    const notStale =
      staleParams.length > 0
        ? `a.proposition_id NOT IN (${staleParams.map(() => "?").join(",")})`
        : "1";
    const having = includeOrphans ? "" : "HAVING valid_count > 0";

    const selectExpr = `
      SELECT e.*,
        COUNT(a.proposition_id) as proposition_count,
        COUNT(CASE WHEN a.proposition_id IS NOT NULL AND ${notStale} THEN 1 END) as valid_count
      FROM entities e
      LEFT JOIN about a ON e.id = a.entity_id
      WHERE ${where}
      GROUP BY e.id
      ${having}`;

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) as total FROM (${selectExpr})`)
        .get(...staleParams, ...whereParams) as { total: number }
    ).total;

    const rows = this.db
      .prepare(`${selectExpr} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`)
      .all(...staleParams, ...whereParams, limit, offset) as Array<
      EntityRow & { proposition_count: number; valid_count: number }
    >;

    const entities: EntityInfo[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      proposition_count: row.proposition_count,
      valid_proposition_count: row.valid_count,
    }));

    return { entities, total };
  }

  inspect(
    entityIdOrName: string,
    options?: { limit?: number; offset?: number; shape?: PropositionShape },
  ): InspectResult {
    const cache = createStalenessCache();
    const entity = this.findEntity(entityIdOrName);
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const shape: PropositionShape = options?.shape ?? "full";

    // Total is computed over the full matching set — independent of
    // limit/offset — so the caller can decide whether to page further.
    const total = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM propositions p JOIN about a ON p.id = a.proposition_id WHERE a.entity_id = ?",
        )
        .get(entity.id) as { c: number }
    ).c;

    const propRows = this.db
      .prepare(
        `SELECT p.* FROM propositions p
         JOIN about a ON p.id = a.proposition_id
         WHERE a.entity_id = ?
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(entity.id, limit, offset) as PropositionRow[];

    // `valid_proposition_count` on the entity header reports the
    // entity-wide valid total (across the full, unpaginated set); the
    // paginated `propositions` list is just the current page.
    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    const validCount = countValidForEntity(this.db, entity.id, stalePropIds);
    const neighbors = getNeighbors(this.db, entity.id, stalePropIds);

    if (shape === "minimal") {
      return {
        entity: {
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
          proposition_count: total,
          valid_proposition_count: validCount,
        },
        propositions: propRows.map((p) => ({ id: p.id, content: p.content }) as MinimalProposition),
        total,
        neighbors,
      };
    }

    const propositions = propRows.map((p) => this.enrichProposition(p, cache));

    // Deduped source files across the entity's *full* proposition set
    // (not just the current page). Callers use this to size-check the
    // corpus footprint of the entity; restricting to the page would
    // make it a moving target per offset.
    const sourceRows = this.db
      .prepare(
        `SELECT DISTINCT ps.file_path
         FROM proposition_sources ps
         JOIN about a ON ps.proposition_id = a.proposition_id
         WHERE a.entity_id = ?
         ORDER BY ps.file_path`,
      )
      .all(entity.id) as Array<{ file_path: string }>;

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: total,
        valid_proposition_count: validCount,
      },
      propositions,
      total,
      neighbors,
      source_files: sourceRows.map((r) => r.file_path),
    };
  }

  bySource(
    filePath: string,
    options?: { limit?: number; offset?: number; shape?: PropositionShape },
  ): BySourceResult {
    const cache = createStalenessCache();
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const shape: PropositionShape = options?.shape ?? "full";

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT p.id) as c FROM propositions p
           JOIN proposition_sources ps ON p.id = ps.proposition_id
           WHERE ps.file_path = ?`,
        )
        .get(storedPath) as { c: number }
    ).c;

    const propRows = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM propositions p
         JOIN proposition_sources ps ON p.id = ps.proposition_id
         WHERE ps.file_path = ?
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(storedPath, limit, offset) as PropositionRow[];

    const propositions =
      shape === "minimal"
        ? (propRows.map((p) => ({ id: p.id, content: p.content })) as MinimalProposition[])
        : propRows.map((p) => this.enrichProposition(p, cache));

    return {
      file_path: storedPath,
      propositions,
      total,
    };
  }

  search(query: string, options?: { limit?: number }): SearchResult {
    const cache = createStalenessCache();
    const limit = options?.limit ?? 20;

    // Sanitize query: replace bare hyphens with spaces so FTS5 doesn't
    // interpret them as the NOT operator (e.g. "query-driven" → "query driven")
    // Preserve explicitly quoted phrases and prefix wildcards.
    const sanitized = query.replace(/(?<!["])\b(\w+)-(\w+)\b(?!["])/g, "$1 $2");

    const rows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN propositions_fts fts ON p.rowid = fts.rowid WHERE propositions_fts MATCH ? ORDER BY fts.rank LIMIT ?`,
      )
      .all(sanitized, limit) as PropositionRow[];

    const propositions = rows.map((p) => {
      const enriched = this.enrichProposition(p, cache);
      const entityRows = this.db
        .prepare(
          `SELECT e.id, e.name, e.kind FROM entities e
         JOIN about a ON e.id = a.entity_id
         WHERE a.proposition_id = ?`,
        )
        .all(p.id) as Array<{ id: string; name: string; kind: string | null }>;
      return { ...enriched, entities: entityRows };
    });

    return { query, propositions };
  }

  status(): StatusResult {
    const cache = createStalenessCache();
    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    return computeStatus(this.db, stalePropIds);
  }

  related(entityIdOrName: string, options?: { limit?: number; offset?: number }): RelatedResult {
    const cache = createStalenessCache();
    const entity = this.findEntity(entityIdOrName);
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);

    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    const validCount = countValidForEntity(this.db, entity.id, stalePropIds);
    const totalCount = (
      this.db.prepare("SELECT COUNT(*) as c FROM about WHERE entity_id = ?").get(entity.id) as {
        c: number;
      }
    ).c;

    const total = countNeighbors(this.db, entity.id);
    const rows = getNeighbors(this.db, entity.id, stalePropIds, {
      withSample: true,
      limit,
      offset,
    });
    const neighbors = rows.map((r) => ({ ...r, sample: r.sample ?? "" }));

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: totalCount,
        valid_proposition_count: validCount,
      },
      neighbors,
      total,
    };
  }

  // --- Proposition enrichment (stays on the class — called by every read) ---

  private enrichProposition(row: PropositionRow, cache: StalenessCache): PropositionInfo {
    const propSources = this.db
      .prepare("SELECT file_path, content_hash FROM proposition_sources WHERE proposition_id = ?")
      .all(row.id) as Array<{ file_path: string; content_hash: string }>;

    const sourceFiles = propSources.map((sf) => ({
      path: sf.file_path,
      hash: sf.content_hash,
      current_match: !isFileChanged(this.sourceRoot, cache, sf.file_path, sf.content_hash),
    }));

    const valid = sourceFiles.length === 0 || sourceFiles.every((sf) => sf.current_match);

    return {
      id: row.id,
      content: row.content,
      created_at: row.created_at,
      valid,
      collection: row.collection,
      source_files: sourceFiles,
    };
  }
}

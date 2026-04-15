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
import {
  collectionFilter,
  computeStatus,
  countValidForEntity,
  getNeighbors,
} from "./enrichment.js";
import {
  createStalenessCache,
  getStalePropositionIds,
  isFileChanged,
  type StalenessCache,
} from "./staleness.js";
import type {
  BrowseResult,
  BySourceResult,
  CollectionConfig,
  EmitProposition,
  EmitResult,
  EmitWarning,
  EntityInfo,
  EntityRow,
  InspectResult,
  PropositionInfo,
  PropositionRow,
  RelatedResult,
  SearchResult,
  StatusResult,
} from "./types.js";

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

function mtimeOf(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

const DEFAULT_COLLECTION: CollectionConfig = {
  name: "default",
  description: "General project knowledge",
  paths: [""],
};

export class MemoryStore {
  private db: Db;
  private sourceRoot: string;
  private collections: Map<string, CollectionConfig>;

  // Takes an already-opened Db handle. Opening the database (PRAGMA +
  // DDL + schema check) is a composition-root concern and lives in
  // src/compose.ts — keeps this constructor pure and makes the class
  // trivially testable with an in-process db handle.
  constructor(db: Db, sourceRoot: string, collections?: CollectionConfig[]) {
    this.db = db;
    this.sourceRoot = sourceRoot;
    this.collections = new Map(
      (collections && collections.length > 0 ? collections : [DEFAULT_COLLECTION]).map((c) => [
        c.name,
        c,
      ]),
    );
  }

  private resolveCollection(collection: string): void {
    if (!this.collections.has(collection)) {
      const available = [...this.collections.keys()].join(", ");
      throw new Error(`Unknown collection "${collection}". Available: ${available}`);
    }
  }

  updateConfig(collections?: CollectionConfig[]): void {
    if (collections !== undefined && collections.length > 0) {
      this.collections = new Map(collections.map((c) => [c.name, c]));
    }
  }

  close(): void {
    this.db.close();
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

  emit(propositions: EmitProposition[], collection: string): EmitResult {
    this.resolveCollection(collection);

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
      "INSERT OR IGNORE INTO proposition_sources (proposition_id, file_path, content_hash, mtime_ms) VALUES (?, ?, ?, ?)",
    );

    for (const prop of propositions) {
      const contentHash = hashContent(prop.content);
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
        const mtime = mtimeOf(resolvedPath);
        insertPropSource.run(propId, storedPath, hash, mtime);
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
    // Priority: id → exact name → normalized name
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
    collection?: string;
  }): BrowseResult {
    const cache = createStalenessCache();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const collection = options?.collection;

    if (collection) this.resolveCollection(collection);

    let where: string;
    const params: unknown[] = [];
    let joinClause: string;

    if (collection) {
      joinClause =
        "JOIN about a ON e.id = a.entity_id JOIN propositions p ON a.proposition_id = p.id";
      where = "p.collection = ?";
      params.push(collection);
    } else {
      joinClause = "LEFT JOIN about a ON e.id = a.entity_id";
      where = "1=1";
    }

    if (options?.name) {
      where += " AND LOWER(e.name) LIKE ?";
      params.push(`%${options.name.toLowerCase()}%`);
    }
    if (options?.kind) {
      where += " AND e.kind = ?";
      params.push(options.kind);
    }

    const countSql = collection
      ? `SELECT COUNT(DISTINCT e.id) as total FROM entities e JOIN about a ON e.id = a.entity_id JOIN propositions p ON a.proposition_id = p.id WHERE ${where}`
      : `SELECT COUNT(*) as total FROM entities e WHERE ${where}`;
    const total = (this.db.prepare(countSql).get(...params) as { total: number }).total;

    const rows = this.db
      .prepare(
        `SELECT e.*, COUNT(${collection ? "DISTINCT " : ""}a.proposition_id) as proposition_count
       FROM entities e
       ${joinClause}
       WHERE ${where}
       GROUP BY e.id
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<EntityRow & { proposition_count: number }>;

    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);

    const entities: EntityInfo[] = rows.map((row) => {
      const validCount = countValidForEntity(this.db, row.id, stalePropIds, collection);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        proposition_count: row.proposition_count,
        valid_proposition_count: validCount,
      };
    });

    return { entities, total };
  }

  inspect(entityIdOrName: string, collection?: string): InspectResult {
    if (collection) this.resolveCollection(collection);
    const cache = createStalenessCache();
    const entity = this.findEntity(entityIdOrName);

    const coll = collectionFilter(collection);
    const propRows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN about a ON p.id = a.proposition_id WHERE a.entity_id = ?${coll.clause} ORDER BY p.created_at DESC`,
      )
      .all(entity.id, ...coll.params) as PropositionRow[];

    const propositions = propRows.map((p) => this.enrichProposition(p, cache));

    // Deduped list of source files across all propositions for this entity
    const sourceFiles = new Set<string>();
    for (const p of propositions) {
      for (const sf of p.source_files) {
        sourceFiles.add(sf.path);
      }
    }

    const validCount = propositions.filter((p) => p.valid).length;
    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    const neighbors = getNeighbors(this.db, entity.id, stalePropIds, { collection });

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: propositions.length,
        valid_proposition_count: validCount,
      },
      propositions,
      neighbors,
      source_files: [...sourceFiles].sort(),
    };
  }

  bySource(filePath: string, collection?: string): BySourceResult {
    if (collection) this.resolveCollection(collection);
    const cache = createStalenessCache();

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const coll = collectionFilter(collection);
    const propRows = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM propositions p
       JOIN proposition_sources ps ON p.id = ps.proposition_id
       WHERE ps.file_path = ?${coll.clause}
       ORDER BY p.created_at DESC`,
      )
      .all(storedPath, ...coll.params) as PropositionRow[];

    return {
      file_path: storedPath,
      propositions: propRows.map((p) => this.enrichProposition(p, cache)),
    };
  }

  search(query: string, options?: { limit?: number; collection?: string }): SearchResult {
    const collection = options?.collection;
    if (collection) this.resolveCollection(collection);
    const cache = createStalenessCache();
    const limit = options?.limit ?? 20;

    // Sanitize query: replace bare hyphens with spaces so FTS5 doesn't
    // interpret them as the NOT operator (e.g. "query-driven" → "query driven")
    // Preserve explicitly quoted phrases and prefix wildcards.
    const sanitized = query.replace(/(?<!["])\b(\w+)-(\w+)\b(?!["])/g, "$1 $2");

    const coll = collectionFilter(collection);
    const rows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN propositions_fts fts ON p.rowid = fts.rowid WHERE propositions_fts MATCH ?${coll.clause} ORDER BY fts.rank LIMIT ?`,
      )
      .all(sanitized, ...coll.params, limit) as PropositionRow[];

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

  status(collection?: string): StatusResult {
    if (collection) this.resolveCollection(collection);
    const cache = createStalenessCache();
    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    return computeStatus(this.db, stalePropIds, collection);
  }

  related(entityIdOrName: string, collection?: string): RelatedResult {
    if (collection) this.resolveCollection(collection);
    const cache = createStalenessCache();
    const entity = this.findEntity(entityIdOrName);

    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    const validCount = countValidForEntity(this.db, entity.id, stalePropIds, collection);
    const totalCount = collection
      ? (
          this.db
            .prepare(
              "SELECT COUNT(*) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE a.entity_id = ? AND p.collection = ?",
            )
            .get(entity.id, collection) as { c: number }
        ).c
      : (
          this.db.prepare("SELECT COUNT(*) as c FROM about WHERE entity_id = ?").get(entity.id) as {
            c: number;
          }
        ).c;

    const rows = getNeighbors(this.db, entity.id, stalePropIds, { withSample: true, collection });
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
    };
  }

  // --- Proposition enrichment (stays on the class — called by every read) ---

  private enrichProposition(row: PropositionRow, cache: StalenessCache): PropositionInfo {
    const propSources = this.db
      .prepare(
        "SELECT file_path, content_hash, mtime_ms FROM proposition_sources WHERE proposition_id = ?",
      )
      .all(row.id) as Array<{ file_path: string; content_hash: string; mtime_ms: number | null }>;

    const sourceFiles = propSources.map((sf) => ({
      path: sf.file_path,
      hash: sf.content_hash,
      current_match: !isFileChanged(
        this.sourceRoot,
        cache,
        sf.file_path,
        sf.content_hash,
        sf.mtime_ms,
      ),
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

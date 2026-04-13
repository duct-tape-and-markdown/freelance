/**
 * MemoryStore — stateless, persistent knowledge graph.
 *
 * Every write goes through the `node:sqlite` layer; there is no in-memory
 * session state. Sources are attached per-proposition at emit time, so
 * staleness is computed per-proposition against the current filesystem.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { hashContent } from "../sources.js";
import { type Db, openDatabase } from "./db.js";
import type {
  BrowseResult,
  BySourceResult,
  CollectionConfig,
  EmitProposition,
  EmitResult,
  EntityInfo,
  EntityRow,
  InspectResult,
  NeighborEntity,
  PropositionInfo,
  PropositionRow,
  RegisterSourceResult,
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

function isIgnored(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const match = picomatch(patterns, { dot: true });
  return match(filePath.replace(/\\/g, "/"));
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
  private ignore: string[];
  private collections: Map<string, CollectionConfig>;
  private mtimeCache: Map<string, number | null> = new Map();
  private hashCache: Map<string, string | null> = new Map();

  constructor(
    dbPath: string,
    sourceRoot?: string,
    ignore?: string[],
    collections?: CollectionConfig[],
  ) {
    this.db = openDatabase(dbPath);
    this.sourceRoot = sourceRoot ?? process.cwd();
    this.ignore = ignore ?? [];
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

  updateConfig(ignore?: string[], collections?: CollectionConfig[]): void {
    if (ignore !== undefined) this.ignore = ignore;
    if (collections !== undefined && collections.length > 0) {
      this.collections = new Map(collections.map((c) => [c.name, c]));
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Source path resolution ---

  /**
   * Validate a source file path against the source root and ignore patterns.
   * Returns the stored (relative) path, resolved absolute path, and ignore
   * status. Throws if the path escapes the source root.
   */
  private prepareSourcePath(filePath: string): {
    storedPath: string;
    resolvedPath: string;
    ignored: boolean;
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

    return { storedPath, resolvedPath, ignored: isIgnored(storedPath, this.ignore) };
  }

  // --- Source registration (zero-state hash echo) ---

  /**
   * Hash a source file and return its content hash. No persistent state is
   * written — registration is a workflow-level ritual enforced by the
   * compile-knowledge sealed workflow, not a storage requirement.
   */
  registerSource(filePath: string): RegisterSourceResult {
    const { storedPath, resolvedPath, ignored } = this.prepareSourcePath(filePath);

    if (ignored) {
      return { file_path: storedPath, content_hash: "", status: "skipped" };
    }

    const hash = hashFile(resolvedPath);
    if (hash === null) {
      throw new Error(`Cannot read file: ${filePath}`);
    }

    return { file_path: storedPath, content_hash: hash, status: "registered" };
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

    // DO NOTHING (not DO UPDATE) so the propositions_au AFTER UPDATE trigger
    // doesn't fire on dedup hits and churn the FTS index.
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
        const resolved = this.resolveEntity(entityName, kind);
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

    return result;
  }

  // --- Entity resolution ---

  private resolveEntity(
    name: string,
    kind?: string,
  ): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
    const exact = this.db.prepare("SELECT id, name, kind FROM entities WHERE name = ?").get(name) as
      | EntityRow
      | undefined;
    if (exact) {
      if (kind && !exact.kind) {
        this.db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, exact.id);
      }
      return { id: exact.id, name: exact.name, resolution: "exact" };
    }

    const normalized = name.toLowerCase().trim();
    const normMatch = this.db
      .prepare("SELECT id, name, kind FROM entities WHERE LOWER(TRIM(name)) = ?")
      .get(normalized) as EntityRow | undefined;
    if (normMatch) {
      if (kind && !normMatch.kind) {
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

  // --- Neighbors ---

  private getNeighbors(
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

    return this.db
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

  // --- Query operations ---

  /** Build optional collection filter clause + params for WHERE appendage. */
  private collectionFilter(collection: string | undefined): { clause: string; params: unknown[] } {
    if (!collection) return { clause: "", params: [] };
    return { clause: " AND p.collection = ?", params: [collection] };
  }

  private clearProvenanceCache(): void {
    this.mtimeCache.clear();
    this.hashCache.clear();
  }

  browse(options?: {
    name?: string;
    kind?: string;
    limit?: number;
    offset?: number;
    collection?: string;
  }): BrowseResult {
    this.clearProvenanceCache();
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

    const stalePropIds = this.getStalePropositionIds();

    const entities: EntityInfo[] = rows.map((row) => {
      const validCount = this.countValidForEntity(row.id, stalePropIds, collection);
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
    this.clearProvenanceCache();
    const entity = this.findEntity(entityIdOrName);

    const coll = this.collectionFilter(collection);
    const propRows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN about a ON p.id = a.proposition_id WHERE a.entity_id = ?${coll.clause} ORDER BY p.created_at DESC`,
      )
      .all(entity.id, ...coll.params) as PropositionRow[];

    const propositions = propRows.map((p) => this.enrichProposition(p));

    // Deduped list of source files across all propositions for this entity
    const sourceFiles = new Set<string>();
    for (const p of propositions) {
      for (const sf of p.source_files) {
        sourceFiles.add(sf.path);
      }
    }

    const validCount = propositions.filter((p) => p.valid).length;
    const stalePropIds = this.getStalePropositionIds();
    const neighbors = this.getNeighbors(entity.id, stalePropIds, { collection });

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
    this.clearProvenanceCache();

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const coll = this.collectionFilter(collection);
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
      propositions: propRows.map((p) => this.enrichProposition(p)),
    };
  }

  search(query: string, options?: { limit?: number; collection?: string }): SearchResult {
    const collection = options?.collection;
    if (collection) this.resolveCollection(collection);
    this.clearProvenanceCache();
    const limit = options?.limit ?? 20;

    // Sanitize query: replace bare hyphens with spaces so FTS5 doesn't
    // interpret them as the NOT operator (e.g. "query-driven" → "query driven")
    // Preserve explicitly quoted phrases and prefix wildcards.
    const sanitized = query.replace(/(?<!["])\b(\w+)-(\w+)\b(?!["])/g, "$1 $2");

    const coll = this.collectionFilter(collection);
    const rows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN propositions_fts fts ON p.rowid = fts.rowid WHERE propositions_fts MATCH ?${coll.clause} ORDER BY fts.rank LIMIT ?`,
      )
      .all(sanitized, ...coll.params, limit) as PropositionRow[];

    const propositions = rows.map((p) => {
      const enriched = this.enrichProposition(p);
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
    this.clearProvenanceCache();
    return this.computeStatus(collection);
  }

  related(entityIdOrName: string, collection?: string): RelatedResult {
    if (collection) this.resolveCollection(collection);
    this.clearProvenanceCache();
    const entity = this.findEntity(entityIdOrName);

    const stalePropIds = this.getStalePropositionIds();
    const validCount = this.countValidForEntity(entity.id, stalePropIds, collection);
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

    const rows = this.getNeighbors(entity.id, stalePropIds, { withSample: true, collection });
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

  // --- Provenance validation ---

  /** Fast path: stat() to get current mtime (~microseconds vs read+hash ~milliseconds). */
  private getCurrentMtime(filePath: string): number | null {
    if (this.mtimeCache.has(filePath)) {
      return this.mtimeCache.get(filePath)!;
    }
    const resolvedPath = path.resolve(this.sourceRoot, filePath);
    const mtime = mtimeOf(resolvedPath);
    this.mtimeCache.set(filePath, mtime);
    return mtime;
  }

  /** Slow path: read + SHA256. Used only as fallback for pre-migration data without mtime. */
  private getCurrentFileHash(filePath: string): string | null {
    if (this.hashCache.has(filePath)) {
      return this.hashCache.get(filePath)!;
    }
    const resolvedPath = path.resolve(this.sourceRoot, filePath);
    const hash = hashFile(resolvedPath);
    this.hashCache.set(filePath, hash);
    return hash;
  }

  /** Check if a source file has changed since registration. */
  private isFileChanged(filePath: string, storedHash: string, storedMtime: number | null): boolean {
    if (storedMtime != null) {
      const currentMtime = this.getCurrentMtime(filePath);
      if (currentMtime !== null && currentMtime === storedMtime) {
        return false;
      }
    }
    const currentHash = this.getCurrentFileHash(filePath);
    return currentHash === null || currentHash !== storedHash;
  }

  /**
   * Scan proposition_sources and return the set of propositions that have
   * at least one drifted source file.
   */
  private getStalePropositionIds(): Set<string> {
    const rows = this.db
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
      if (this.isFileChanged(file_path, content_hash, mtime_ms)) {
        stale.add(proposition_id);
      }
    }
    return stale;
  }

  private computeStatus(collection?: string): StatusResult {
    const collWhere = collection ? " WHERE collection = ?" : "";
    const collParams: unknown[] = collection ? [collection] : [];

    const totalProps = (
      this.db.prepare(`SELECT COUNT(*) as c FROM propositions${collWhere}`).get(...collParams) as {
        c: number;
      }
    ).c;
    const totalEntities = collection
      ? (
          this.db
            .prepare(
              "SELECT COUNT(DISTINCT a.entity_id) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE p.collection = ?",
            )
            .get(collection) as { c: number }
        ).c
      : (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;

    const stale = this.getStalePropositionIds();
    let validCount: number;

    if (stale.size === 0) {
      validCount = totalProps;
    } else if (!collection) {
      validCount = totalProps - stale.size;
    } else {
      // Count only stale props in this collection
      const staleParams = [...stale];
      const placeholders = staleParams.map(() => "?").join(",");
      const staleInCollection = (
        this.db
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

  private countValidForEntity(
    entityId: string,
    stalePropIds: Set<string>,
    collection?: string,
  ): number {
    // Fast path: no stale props and no collection filter — skip JOIN
    if (stalePropIds.size === 0 && !collection) {
      return (
        this.db.prepare("SELECT COUNT(*) as c FROM about WHERE entity_id = ?").get(entityId) as {
          c: number;
        }
      ).c;
    }

    const coll = this.collectionFilter(collection);

    if (stalePropIds.size === 0) {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE a.entity_id = ?${coll.clause}`,
          )
          .get(entityId, ...coll.params) as { c: number }
      ).c;
    }
    const staleParams = [...stalePropIds];
    const placeholders = staleParams.map(() => "?").join(",");
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM about a
       JOIN propositions p ON a.proposition_id = p.id
       WHERE a.entity_id = ? AND a.proposition_id NOT IN (${placeholders})${coll.clause}`,
        )
        .get(entityId, ...staleParams, ...coll.params) as { c: number }
    ).c;
  }

  private enrichProposition(row: PropositionRow): PropositionInfo {
    const propSources = this.db
      .prepare(
        "SELECT file_path, content_hash, mtime_ms FROM proposition_sources WHERE proposition_id = ?",
      )
      .all(row.id) as Array<{ file_path: string; content_hash: string; mtime_ms: number | null }>;

    const sourceFiles = propSources.map((sf) => ({
      path: sf.file_path,
      hash: sf.content_hash,
      current_match: !this.isFileChanged(sf.file_path, sf.content_hash, sf.mtime_ms),
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

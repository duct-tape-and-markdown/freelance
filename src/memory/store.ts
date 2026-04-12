/**
 * MemoryStore — stateless, persistent knowledge graph.
 *
 * No in-memory state. Every operation reads from and writes to SQLite.
 * Multiple processes (MCP server, CLI, hooks) can access the same
 * database concurrently. WAL mode + busy_timeout handle contention.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashContent } from "../sources.js";
import { openDatabase, type Db } from "./db.js";
import type {
  EntityRow,
  PropositionRow,
  EmitProposition,
  EmitResult,
  EntityInfo,
  PropositionInfo,
  InspectResult,
  BrowseResult,
  BySourceResult,
  SearchResult,
  StatusResult,
  EndResult,
  RegisterSourceResult,
  SourceSession,
  CollectionConfig,
  NeighborEntity,
  RelatedResult,
} from "./types.js";

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

import picomatch from "picomatch";

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

const DEFAULT_COLLECTION: CollectionConfig = { name: "default", description: "General project knowledge", paths: [""] };

export class MemoryStore {
  private db: Db;
  private sourceRoot: string;
  private ignore: string[];
  private collections: Map<string, CollectionConfig>;
  private mtimeCache: Map<string, number | null> = new Map();
  private hashCache: Map<string, string | null> = new Map();

  constructor(dbPath: string, sourceRoot?: string, ignore?: string[], collections?: CollectionConfig[]) {
    this.db = openDatabase(dbPath);
    this.sourceRoot = sourceRoot ?? process.cwd();
    this.ignore = ignore ?? [];
    this.collections = new Map(
      (collections && collections.length > 0 ? collections : [DEFAULT_COLLECTION])
        .map((c) => [c.name, c])
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

  // --- Active session (read from DB, not in-memory) ---

  private getActiveSession(): { id: string; started_at: string } | null {
    return this.db.prepare(
      "SELECT id, started_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    ).get() as { id: string; started_at: string } | undefined ?? null;
  }

  /**
   * Get or create the active session. Sessions are created lazily
   * on first registerSource call and closed explicitly via end().
   */
  private ensureActiveSession(): string {
    const session = this.getActiveSession();
    if (session) return session.id;

    const sessionId = generateId();
    this.db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(sessionId, now());
    return sessionId;
  }

  private requireActiveSession(): string {
    const session = this.getActiveSession();
    if (!session) {
      throw new Error("No active session. Register a source file first.");
    }
    return session.id;
  }

  end(): EndResult {
    const sessionId = this.requireActiveSession();

    const startedAt = (this.db.prepare(
      "SELECT started_at FROM sessions WHERE id = ?"
    ).get(sessionId) as { started_at: string }).started_at;
    const duration = Date.now() - new Date(startedAt).getTime();

    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(now(), sessionId);

    const fileCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM session_files WHERE session_id = ?"
    ).get(sessionId) as { c: number }).c;

    const propCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM propositions WHERE session_id = ?"
    ).get(sessionId) as { c: number }).c;

    const entityCount = (this.db.prepare(
      `SELECT COUNT(DISTINCT a.entity_id) as c FROM about a
       JOIN propositions p ON a.proposition_id = p.id
       WHERE p.session_id = ?`
    ).get(sessionId) as { c: number }).c;

    return {
      session_id: sessionId,
      propositions_emitted: propCount,
      entities_referenced: entityCount,
      files_registered: fileCount,
      duration_ms: duration,
    };
  }

  // --- Source registration ---

  registerSource(filePath: string): RegisterSourceResult {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.sourceRoot, filePath);

    // Reject paths outside the source root
    const normalizedRoot = path.resolve(this.sourceRoot) + path.sep;
    const normalizedPath = path.resolve(resolvedPath);
    if (!normalizedPath.startsWith(normalizedRoot) && normalizedPath !== path.resolve(this.sourceRoot)) {
      throw new Error(`Source file is outside the source root: ${filePath}`);
    }

    // Check ignore patterns against the relative path
    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    if (isIgnored(storedPath, this.ignore)) {
      return { file_path: storedPath, content_hash: "", status: "skipped" };
    }

    const sessionId = this.ensureActiveSession();

    const hash = hashFile(resolvedPath);
    if (hash === null) {
      throw new Error(`Cannot read file: ${filePath}`);
    }
    const mtime = mtimeOf(resolvedPath);

    const existing = this.db.prepare(
      "SELECT content_hash FROM session_files WHERE session_id = ? AND file_path = ?"
    ).get(sessionId, storedPath) as { content_hash: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE session_files SET content_hash = ?, mtime_ms = ? WHERE session_id = ? AND file_path = ?"
      ).run(hash, mtime, sessionId, storedPath);
      return { file_path: storedPath, content_hash: hash, status: "updated" };
    }

    this.db.prepare(
      "INSERT INTO session_files (session_id, file_path, content_hash, mtime_ms) VALUES (?, ?, ?, ?)"
    ).run(sessionId, storedPath, hash, mtime);

    return { file_path: storedPath, content_hash: hash, status: "registered" };
  }

  // --- Proposition emission ---

  emit(propositions: EmitProposition[], collection: string): EmitResult {
    this.resolveCollection(collection);
    const sessionId = this.requireActiveSession();

    // Validate that at least one source file is registered
    const fileCount = (this.db.prepare(
      "SELECT COUNT(*) as c FROM session_files WHERE session_id = ?"
    ).get(sessionId) as { c: number }).c;

    if (fileCount === 0) {
      throw new Error("No source files registered in this session. Call memory_register_source before emitting propositions.");
    }

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
      `INSERT INTO propositions (id, content, content_hash, session_id, collection, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, collection) DO NOTHING
       RETURNING id`
    );
    const selectExistingProp = this.db.prepare(
      "SELECT id FROM propositions WHERE content_hash = ? AND collection = ?"
    );
    const insertAbout = this.db.prepare(
      "INSERT OR IGNORE INTO about (proposition_id, entity_id) VALUES (?, ?)"
    );
    const insertPropSource = this.db.prepare(
      "INSERT OR IGNORE INTO proposition_sources (proposition_id, file_path, content_hash, mtime_ms) VALUES (?, ?, ?, ?)"
    );

    // Build a lookup of registered files in this session for source attribution
    const sessionFiles = new Map<string, { hash: string; mtime: number | null }>();
    const sfRows = this.db.prepare(
      "SELECT file_path, content_hash, mtime_ms FROM session_files WHERE session_id = ?"
    ).all(sessionId) as Array<{ file_path: string; content_hash: string; mtime_ms: number | null }>;
    for (const sf of sfRows) {
      sessionFiles.set(sf.file_path, { hash: sf.content_hash, mtime: sf.mtime_ms });
    }

    for (const prop of propositions) {
      const contentHash = hashContent(prop.content);
      const newId = generateId();
      const inserted = upsertProp.get(
        newId, prop.content, contentHash, sessionId, collection, now(),
      ) as { id: string } | undefined;

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
        // Conflict: an existing row owns this (content_hash, collection).
        // Fetch its id so we can attach about/sources rows to it.
        const existing = selectExistingProp.get(contentHash, collection) as { id: string };
        propId = existing.id;
        propResult.status = "deduplicated";
        result.deduplicated++;
      }
      propResult.id = propId;

      // Per-proposition source attribution — every source must be registered
      for (const sourcePath of prop.sources) {
        const sf = sessionFiles.get(sourcePath);
        if (!sf) {
          throw new Error(
            `Source "${sourcePath}" is not registered in this session. ` +
            `Call memory_register_source for each file before referencing it in emit.`
          );
        }
        insertPropSource.run(propId, sourcePath, sf.hash, sf.mtime);
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

  private resolveEntity(name: string, kind?: string): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
    const exact = this.db.prepare(
      "SELECT id, name, kind FROM entities WHERE name = ?"
    ).get(name) as EntityRow | undefined;
    if (exact) {
      if (kind && !exact.kind) {
        this.db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, exact.id);
      }
      return { id: exact.id, name: exact.name, resolution: "exact" };
    }

    const normalized = name.toLowerCase().trim();
    const normMatch = this.db.prepare(
      "SELECT id, name, kind FROM entities WHERE LOWER(TRIM(name)) = ?"
    ).get(normalized) as EntityRow | undefined;
    if (normMatch) {
      if (kind && !normMatch.kind) {
        this.db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run(kind, normMatch.id);
      }
      return { id: normMatch.id, name: normMatch.name, resolution: "normalized" };
    }

    const id = generateId();
    this.db.prepare(
      "INSERT INTO entities (id, name, kind, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, name, kind ?? null, now());

    return { id, name, resolution: "created" };
  }

  // --- Entity lookup ---

  private findEntity(idOrName: string): EntityRow {
    // Priority: id → exact name → normalized name
    const entity =
      (this.db.prepare("SELECT * FROM entities WHERE id = ?").get(idOrName) as EntityRow | undefined) ??
      (this.db.prepare("SELECT * FROM entities WHERE name = ?").get(idOrName) as EntityRow | undefined) ??
      (this.db.prepare("SELECT * FROM entities WHERE LOWER(name) = ?").get(idOrName.toLowerCase()) as EntityRow | undefined);
    if (!entity) {
      throw new Error(`Entity not found: ${idOrName}`);
    }
    return entity;
  }

  // --- Neighbors ---

  private getNeighbors(entityId: string, staleSessionIds: Set<string>, options?: { withSample?: boolean; collection?: string }): Array<NeighborEntity & { sample?: string | null }> {
    const withSample = options?.withSample ?? false;
    const collection = options?.collection;

    const staleParams = [...staleSessionIds];
    const staleFilter = staleParams.length > 0
      ? `p.session_id NOT IN (${staleParams.map(() => "?").join(",")})`
      : "1"; // no stale sessions → all are valid

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

    return this.db.prepare(
      `SELECT e2.id, e2.name, e2.kind,
              COUNT(DISTINCT a1.proposition_id) as shared_propositions,
              COUNT(DISTINCT CASE WHEN ${staleFilter} THEN a1.proposition_id END) as valid_shared_propositions${sampleCol}
       FROM about a1
       JOIN about a2 ON a1.proposition_id = a2.proposition_id
       JOIN entities e2 ON a2.entity_id = e2.id
       JOIN propositions p ON a1.proposition_id = p.id
       WHERE a1.entity_id = ? AND a2.entity_id != a1.entity_id${collFilter}
       GROUP BY e2.id
       ORDER BY valid_shared_propositions DESC`
    ).all(...staleParams, ...sampleParams, entityId, ...collParams) as Array<NeighborEntity & { sample?: string | null }>;
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

  browse(options?: { name?: string; kind?: string; limit?: number; offset?: number; collection?: string }): BrowseResult {
    this.clearProvenanceCache();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const collection = options?.collection;

    if (collection) this.resolveCollection(collection);

    let where: string;
    const params: unknown[] = [];
    let joinClause: string;

    if (collection) {
      joinClause = "JOIN about a ON e.id = a.entity_id JOIN propositions p ON a.proposition_id = p.id";
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

    const rows = this.db.prepare(
      `SELECT e.*, COUNT(${collection ? "DISTINCT " : ""}a.proposition_id) as proposition_count
       FROM entities e
       ${joinClause}
       WHERE ${where}
       GROUP BY e.id
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<EntityRow & { proposition_count: number }>;

    const staleSessionIds = this.getStaleSessionIds();

    const entities: EntityInfo[] = rows.map((row) => {
      const validCount = this.countValidForEntity(row.id, staleSessionIds, collection);
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
    const propRows = this.db.prepare(
      `SELECT p.* FROM propositions p JOIN about a ON p.id = a.proposition_id WHERE a.entity_id = ?${coll.clause} ORDER BY p.created_at DESC`
    ).all(entity.id, ...coll.params) as PropositionRow[];

    const propositions = propRows.map((p) => this.enrichProposition(p));

    const sessionIds = [...new Set(propRows.map((p) => p.session_id))];
    const sourceSessions: SourceSession[] = sessionIds.map((sid) => {
      const files = this.db.prepare(
        "SELECT file_path FROM session_files WHERE session_id = ?"
      ).all(sid) as Array<{ file_path: string }>;
      return { id: sid, files: files.map((f) => f.file_path) };
    });

    const validCount = propositions.filter((p) => p.valid).length;
    const staleSessionIds = this.getStaleSessionIds();
    const neighbors = this.getNeighbors(entity.id, staleSessionIds, { collection });

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
      source_sessions: sourceSessions,
    };
  }

  bySource(filePath: string, collection?: string): BySourceResult {
    if (collection) this.resolveCollection(collection);
    this.clearProvenanceCache();

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const coll = this.collectionFilter(collection);
    const propRows = this.db.prepare(
      `SELECT DISTINCT p.* FROM propositions p JOIN session_files sf ON p.session_id = sf.session_id WHERE sf.file_path = ?${coll.clause} ORDER BY p.created_at DESC`
    ).all(storedPath, ...coll.params) as PropositionRow[];

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
    const rows = this.db.prepare(
      `SELECT p.* FROM propositions p JOIN propositions_fts fts ON p.rowid = fts.rowid WHERE propositions_fts MATCH ?${coll.clause} ORDER BY fts.rank LIMIT ?`
    ).all(sanitized, ...coll.params, limit) as PropositionRow[];

    const propositions = rows.map((p) => {
      const enriched = this.enrichProposition(p);
      const entityRows = this.db.prepare(
        `SELECT e.id, e.name, e.kind FROM entities e
         JOIN about a ON e.id = a.entity_id
         WHERE a.proposition_id = ?`
      ).all(p.id) as Array<{ id: string; name: string; kind: string | null }>;
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

    const staleSessionIds = this.getStaleSessionIds();
    const validCount = this.countValidForEntity(entity.id, staleSessionIds, collection);
    const totalCount = collection
      ? (this.db.prepare(
          "SELECT COUNT(*) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE a.entity_id = ? AND p.collection = ?"
        ).get(entity.id, collection) as { c: number }).c
      : (this.db.prepare(
          "SELECT COUNT(*) as c FROM about WHERE entity_id = ?"
        ).get(entity.id) as { c: number }).c;

    const rows = this.getNeighbors(entity.id, staleSessionIds, { withSample: true, collection });
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
        return false; // Fast path: mtime unchanged → skip hash
      }
      // mtime differs or file missing → verify with hash
    }
    const currentHash = this.getCurrentFileHash(filePath);
    return currentHash === null || currentHash !== storedHash;
  }

  private getStaleSessionIds(): Set<string> {
    const allFiles = this.db.prepare(
      "SELECT session_id, file_path, content_hash, mtime_ms FROM session_files"
    ).all() as Array<{ session_id: string; file_path: string; content_hash: string; mtime_ms: number | null }>;

    const stale = new Set<string>();
    for (const { session_id, file_path, content_hash, mtime_ms } of allFiles) {
      if (stale.has(session_id)) continue;
      if (this.isFileChanged(file_path, content_hash, mtime_ms)) {
        stale.add(session_id);
      }
    }
    return stale;
  }

  private computeStatus(collection?: string): StatusResult {
    const collWhere = collection ? " WHERE collection = ?" : "";
    const collAnd = collection ? " AND collection = ?" : "";
    const collParams: unknown[] = collection ? [collection] : [];

    const totalProps = (this.db.prepare(
      `SELECT COUNT(*) as c FROM propositions${collWhere}`
    ).get(...collParams) as { c: number }).c;
    const totalEntities = collection
      ? (this.db.prepare(
          "SELECT COUNT(DISTINCT a.entity_id) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE p.collection = ?"
        ).get(collection) as { c: number }).c
      : (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
    const totalSessions = (this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    const activeSession = this.getActiveSession();

    const stale = this.getStaleSessionIds();
    let validCount: number;

    if (stale.size === 0) {
      validCount = totalProps;
    } else {
      const staleParams = [...stale];
      const placeholders = staleParams.map(() => "?").join(",");
      const staleCount = (this.db.prepare(
        `SELECT COUNT(*) as c FROM propositions WHERE session_id IN (${placeholders})${collAnd}`
      ).get(...staleParams, ...collParams) as { c: number }).c;
      validCount = totalProps - staleCount;
    }

    return {
      total_propositions: totalProps,
      valid_propositions: validCount,
      stale_propositions: totalProps - validCount,
      total_entities: totalEntities,
      total_sessions: totalSessions,
      active_session: activeSession?.id ?? null,
    };
  }

  private countValidForEntity(entityId: string, staleSessionIds: Set<string>, collection?: string): number {
    // Fast path: no stale sessions and no collection filter — skip JOIN
    if (staleSessionIds.size === 0 && !collection) {
      return (this.db.prepare(
        "SELECT COUNT(*) as c FROM about WHERE entity_id = ?"
      ).get(entityId) as { c: number }).c;
    }

    const coll = this.collectionFilter(collection);

    if (staleSessionIds.size === 0) {
      return (this.db.prepare(
        `SELECT COUNT(*) as c FROM about a JOIN propositions p ON a.proposition_id = p.id WHERE a.entity_id = ?${coll.clause}`
      ).get(entityId, ...coll.params) as { c: number }).c;
    }
    const staleParams = [...staleSessionIds];
    const placeholders = staleParams.map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT COUNT(*) as c FROM about a
       JOIN propositions p ON a.proposition_id = p.id
       WHERE a.entity_id = ? AND p.session_id NOT IN (${placeholders})${coll.clause}`
    ).get(entityId, ...staleParams, ...coll.params) as { c: number }).c;
  }

  private enrichProposition(row: PropositionRow): PropositionInfo {
    // Prefer per-proposition sources when available, fall back to session-level
    const propSources = this.db.prepare(
      "SELECT file_path, content_hash, mtime_ms FROM proposition_sources WHERE proposition_id = ?"
    ).all(row.id) as Array<{ file_path: string; content_hash: string; mtime_ms: number | null }>;

    const filesToCheck = propSources.length > 0
      ? propSources
      : this.db.prepare(
          "SELECT file_path, content_hash, mtime_ms FROM session_files WHERE session_id = ?"
        ).all(row.session_id) as Array<{ file_path: string; content_hash: string; mtime_ms: number | null }>;

    const sourceFiles = filesToCheck.map((sf) => ({
      path: sf.file_path,
      hash: sf.content_hash,
      current_match: !this.isFileChanged(sf.file_path, sf.content_hash, sf.mtime_ms),
    }));

    const valid = sourceFiles.length === 0 || sourceFiles.every((sf) => sf.current_match);

    return {
      id: row.id,
      content: row.content,
      session_id: row.session_id,
      created_at: row.created_at,
      valid,
      collection: row.collection,
      source_files: sourceFiles,
    };
  }
}

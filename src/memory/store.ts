/**
 * MemoryStore — core operations for the Freelance Memory knowledge graph.
 *
 * Manages sessions, entities, propositions, and provenance validation.
 * All query-time reads validate provenance by checking file hashes on disk.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { hashContent } from "../sources.js";
import { openDatabase } from "./db.js";
import type {
  EntityRow,
  SessionFileRow,
  PropositionRow,
  EmitProposition,
  EmitResult,
  EntityInfo,
  PropositionInfo,
  InspectResult,
  BrowseResult,
  RelationshipsResult,
  BySourceResult,
  StatusResult,
  GapsResult,
  BeginResult,
  EndResult,
  RegisterSourceResult,
} from "./types.js";

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return hashContent(content);
  } catch {
    return null;
  }
}

export class MemoryStore {
  private db: Database.Database;
  private activeSessionId: string | null = null;
  private sessionStartTime: number | null = null;
  private sourceRoot: string;
  private fileHashCache: Map<string, string | null> = new Map();

  constructor(dbPath: string, sourceRoot?: string) {
    this.db = openDatabase(dbPath);
    this.sourceRoot = sourceRoot ?? process.cwd();
  }

  close(): void {
    this.db.close();
  }

  // --- Session management ---

  begin(): BeginResult {
    if (this.activeSessionId) {
      throw new Error(`Session already active: ${this.activeSessionId}. Call memory_end first.`);
    }

    const sessionId = generateId();
    const timestamp = now();
    this.activeSessionId = sessionId;
    this.sessionStartTime = Date.now();
    this.fileHashCache.clear();

    this.db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(sessionId, timestamp);

    // Cheap counts — no provenance validation on begin
    const totalEntities = (this.db.prepare("SELECT COUNT(*) as count FROM entities").get() as { count: number }).count;
    const totalProps = (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;

    return {
      session_id: sessionId,
      entities: totalEntities,
      total_propositions: totalProps,
    };
  }

  end(): EndResult {
    if (!this.activeSessionId) {
      throw new Error("No active session. Call memory_begin first.");
    }

    const sessionId = this.activeSessionId;
    const timestamp = now();
    const duration = Date.now() - (this.sessionStartTime ?? Date.now());

    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(timestamp, sessionId);

    const fileCount = (this.db.prepare(
      "SELECT COUNT(*) as count FROM session_files WHERE session_id = ?"
    ).get(sessionId) as { count: number }).count;

    // Count via proposition_sessions — includes both new and deduplicated
    const propCount = (this.db.prepare(
      "SELECT COUNT(*) as count FROM proposition_sessions WHERE session_id = ?"
    ).get(sessionId) as { count: number }).count;

    const entityCount = (this.db.prepare(
      `SELECT COUNT(DISTINCT a.entity_id) as count
       FROM about a
       JOIN proposition_sessions ps ON a.proposition_id = ps.proposition_id
       WHERE ps.session_id = ?`
    ).get(sessionId) as { count: number }).count;

    this.activeSessionId = null;
    this.sessionStartTime = null;
    this.fileHashCache.clear();

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
    if (!this.activeSessionId) {
      throw new Error("No active session. Call memory_begin first.");
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.sourceRoot, filePath);
    const hash = hashFile(resolvedPath);
    if (hash === null) {
      throw new Error(`Cannot read file: ${filePath}`);
    }

    // Store the path relative to sourceRoot for portability
    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const existing = this.db.prepare(
      "SELECT content_hash FROM session_files WHERE session_id = ? AND file_path = ?"
    ).get(this.activeSessionId, storedPath) as { content_hash: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE session_files SET content_hash = ? WHERE session_id = ? AND file_path = ?"
      ).run(hash, this.activeSessionId, storedPath);
      return { file_path: storedPath, content_hash: hash, status: "updated" };
    }

    this.db.prepare(
      "INSERT INTO session_files (session_id, file_path, content_hash) VALUES (?, ?, ?)"
    ).run(this.activeSessionId, storedPath, hash);

    return { file_path: storedPath, content_hash: hash, status: "registered" };
  }

  // --- Proposition emission ---

  emit(propositions: EmitProposition[]): EmitResult {
    if (!this.activeSessionId) {
      throw new Error("No active session. Call memory_begin first.");
    }

    const result: EmitResult = {
      created: 0,
      deduplicated: 0,
      entities_resolved: 0,
      entities_created: 0,
      propositions: [],
    };

    const insertProp = this.db.prepare(
      "INSERT INTO propositions (id, content, content_hash, kind, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertAbout = this.db.prepare(
      "INSERT OR IGNORE INTO about (proposition_id, entity_id, role) VALUES (?, ?, ?)"
    );
    const insertRelation = this.db.prepare(
      "INSERT OR IGNORE INTO relates_to (from_id, to_id, relationship_type) VALUES (?, ?, ?)"
    );
    const insertPropSession = this.db.prepare(
      "INSERT OR IGNORE INTO proposition_sessions (proposition_id, session_id) VALUES (?, ?)"
    );

    const emitAll = this.db.transaction(() => {
      for (const prop of propositions) {
        const contentHash = hashContent(prop.content);
        const kind = prop.kind ?? "observation";
        const existing = this.db.prepare(
          "SELECT id FROM propositions WHERE content_hash = ? AND kind = ?"
        ).get(contentHash, kind) as { id: string } | undefined;

        const propResult: EmitResult["propositions"][number] = {
          id: "",
          content: prop.content,
          status: "created",
          entities: [],
        };

        let propId: string;
        if (existing) {
          propId = existing.id;
          propResult.id = propId;
          propResult.status = "deduplicated";
          result.deduplicated++;
        } else {
          propId = generateId();
          const timestamp = now();
          insertProp.run(propId, prop.content, contentHash, kind, this.activeSessionId!, timestamp);
          propResult.id = propId;
          result.created++;
        }

        // Always link proposition to current session (even on dedup)
        insertPropSession.run(propId, this.activeSessionId!);

        // Resolve entities
        for (const entityName of prop.entities) {
          const resolved = this.resolveEntity(entityName);
          propResult.entities.push(resolved);
          insertAbout.run(propId, resolved.id, null);
          if (resolved.resolution === "created") {
            result.entities_created++;
          } else {
            result.entities_resolved++;
          }
        }

        // Handle relations
        if (prop.relatesTo) {
          for (const targetId of prop.relatesTo) {
            const targetExists = this.db.prepare(
              "SELECT id FROM propositions WHERE id = ?"
            ).get(targetId);
            if (targetExists) {
              insertRelation.run(propId, targetId, null);
            }
          }
        }

        result.propositions.push(propResult);
      }
    });

    emitAll();
    return result;
  }

  // --- Entity resolution ---

  private resolveEntity(name: string): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
    // 1. Exact match (name, null scope)
    const exact = this.db.prepare(
      "SELECT id, name FROM entities WHERE name = ? AND (scope IS NULL OR scope = '')"
    ).get(name) as EntityRow | undefined;
    if (exact) {
      return { id: exact.id, name: exact.name, resolution: "exact" };
    }

    // 2. Normalized match
    const normalized = name.toLowerCase().trim();
    const normMatch = this.db.prepare(
      "SELECT id, name FROM entities WHERE LOWER(TRIM(name)) = ? AND (scope IS NULL OR scope = '')"
    ).get(normalized) as EntityRow | undefined;
    if (normMatch) {
      return { id: normMatch.id, name: normMatch.name, resolution: "normalized" };
    }

    // 3. Create new
    const id = generateId();
    const timestamp = now();
    this.db.prepare(
      "INSERT INTO entities (id, name, kind, scope, summary, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, ?, ?)"
    ).run(id, name, timestamp, timestamp);

    return { id, name, resolution: "created" };
  }

  // --- Query operations ---

  browse(options?: { name?: string; kind?: string; limit?: number; offset?: number }): BrowseResult {
    this.fileHashCache.clear();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let where = "1=1";
    const params: unknown[] = [];

    if (options?.name) {
      where += " AND LOWER(e.name) LIKE ?";
      params.push(`%${options.name.toLowerCase()}%`);
    }
    if (options?.kind) {
      where += " AND e.kind = ?";
      params.push(options.kind);
    }

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as total FROM entities e WHERE ${where}`
    ).get(...params) as { total: number };

    const rows = this.db.prepare(
      `SELECT e.*, COUNT(a.proposition_id) as proposition_count
       FROM entities e
       LEFT JOIN about a ON e.id = a.entity_id
       WHERE ${where}
       GROUP BY e.id
       ORDER BY e.updated_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<EntityRow & { proposition_count: number }>;

    // Batch-validate: collect all unique (file_path, content_hash) pairs
    // across all propositions for all returned entities in one pass
    const validityMap = this.batchValidateForEntities(rows.map((r) => r.id));

    const entities: EntityInfo[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      scope: row.scope,
      summary: row.summary,
      proposition_count: row.proposition_count,
      valid_proposition_count: validityMap.get(row.id) ?? 0,
    }));

    return { entities, total: countRow.total };
  }

  inspect(entityId: string): InspectResult {
    this.fileHashCache.clear();

    const entity = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) as EntityRow | undefined;
    if (!entity) {
      // Try by name
      const byName = this.db.prepare("SELECT * FROM entities WHERE LOWER(name) = ?").get(entityId.toLowerCase()) as EntityRow | undefined;
      if (!byName) {
        throw new Error(`Entity not found: ${entityId}`);
      }
      return this.inspect(byName.id);
    }

    const propRows = this.db.prepare(
      `SELECT p.* FROM propositions p
       JOIN about a ON p.id = a.proposition_id
       WHERE a.entity_id = ?
       ORDER BY p.created_at DESC`
    ).all(entity.id) as PropositionRow[];

    const propositions = propRows.map((p) => this.enrichProposition(p));

    // Related entities: entities that share propositions
    const relatedRows = this.db.prepare(
      `SELECT e.id, e.name, COUNT(*) as shared_propositions
       FROM entities e
       JOIN about a1 ON e.id = a1.entity_id
       JOIN about a2 ON a1.proposition_id = a2.proposition_id
       WHERE a2.entity_id = ? AND e.id != ?
       GROUP BY e.id
       ORDER BY shared_propositions DESC`
    ).all(entity.id, entity.id) as Array<{ id: string; name: string; shared_propositions: number }>;

    const validCount = propositions.filter((p) => p.valid).length;

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        scope: entity.scope,
        summary: entity.summary,
        proposition_count: propositions.length,
        valid_proposition_count: validCount,
      },
      propositions,
      related_entities: relatedRows,
    };
  }

  relationships(entityA: string, entityB: string): RelationshipsResult {
    this.fileHashCache.clear();

    const a = this.resolveEntityForQuery(entityA);
    const b = this.resolveEntityForQuery(entityB);

    const propRows = this.db.prepare(
      `SELECT DISTINCT p.* FROM propositions p
       JOIN about a1 ON p.id = a1.proposition_id
       JOIN about a2 ON p.id = a2.proposition_id
       WHERE a1.entity_id = ? AND a2.entity_id = ?
       ORDER BY p.created_at DESC`
    ).all(a.id, b.id) as PropositionRow[];

    return {
      entity_a: { id: a.id, name: a.name },
      entity_b: { id: b.id, name: b.name },
      shared_propositions: propRows.map((p) => this.enrichProposition(p)),
    };
  }

  bySource(filePath: string): BySourceResult {
    this.fileHashCache.clear();

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    // Propositions from any session that included this file
    const propRows = this.db.prepare(
      `SELECT DISTINCT p.* FROM propositions p
       JOIN proposition_sessions ps ON p.id = ps.proposition_id
       JOIN session_files sf ON ps.session_id = sf.session_id
       WHERE sf.file_path = ?
       ORDER BY p.created_at DESC`
    ).all(storedPath) as PropositionRow[];

    return {
      file_path: storedPath,
      propositions: propRows.map((p) => this.enrichProposition(p)),
    };
  }

  status(): StatusResult {
    this.fileHashCache.clear();

    const totalProps = (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;
    const totalEntities = (this.db.prepare("SELECT COUNT(*) as count FROM entities").get() as { count: number }).count;
    const totalSessions = (this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count;

    // Batch validation: get all unique (file_path, content_hash) pairs,
    // hash each file once, then count valid propositions via SQL
    const validCount = this.batchCountValidPropositions();

    return {
      total_propositions: totalProps,
      valid_propositions: validCount,
      stale_propositions: totalProps - validCount,
      total_entities: totalEntities,
      total_sessions: totalSessions,
      active_session: this.activeSessionId,
    };
  }

  gaps(): GapsResult {
    // Intent propositions: what the code should do
    const intents = this.db.prepare(
      "SELECT id, content, content_hash FROM propositions WHERE kind = 'intent'"
    ).all() as Array<{ id: string; content: string; content_hash: string }>;

    // Observation propositions: what the code actually does
    const observations = this.db.prepare(
      "SELECT id, content, content_hash FROM propositions WHERE kind = 'observation'"
    ).all() as Array<{ id: string; content: string; content_hash: string }>;

    const intentHashes = new Map(intents.map((p) => [p.content_hash, p]));
    const observationHashes = new Map(observations.map((p) => [p.content_hash, p]));

    const result: GapsResult = { unimplemented: [], unplanned: [], matched: [] };

    for (const [hash, intent] of intentHashes) {
      const obs = observationHashes.get(hash);
      if (obs) {
        result.matched.push({
          content: intent.content,
          intent_id: intent.id,
          observation_id: obs.id,
        });
      } else {
        result.unimplemented.push({
          content: intent.content,
          proposition_id: intent.id,
        });
      }
    }

    for (const [hash, obs] of observationHashes) {
      if (!intentHashes.has(hash)) {
        result.unplanned.push({
          content: obs.content,
          proposition_id: obs.id,
        });
      }
    }

    return result;
  }

  // --- Provenance validation ---

  private getCurrentFileHash(filePath: string): string | null {
    if (this.fileHashCache.has(filePath)) {
      return this.fileHashCache.get(filePath)!;
    }
    const resolvedPath = path.resolve(this.sourceRoot, filePath);
    const hash = hashFile(resolvedPath);
    this.fileHashCache.set(filePath, hash);
    return hash;
  }

  /**
   * Batch-count valid propositions across the entire store.
   * Gets all unique (file_path, content_hash) pairs, hashes each file once,
   * then determines which sessions are fully valid, and counts their propositions.
   */
  private batchCountValidPropositions(): number {
    // Get all unique file paths referenced by any session
    const allFiles = this.db.prepare(
      "SELECT DISTINCT file_path, content_hash, session_id FROM session_files"
    ).all() as Array<{ file_path: string; content_hash: string; session_id: string }>;

    if (allFiles.length === 0) {
      // No provenance at all — all propositions are valid
      return (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;
    }

    // Hash each unique file once
    const staleSessionIds = new Set<string>();
    for (const { file_path, content_hash, session_id } of allFiles) {
      const currentHash = this.getCurrentFileHash(file_path);
      if (currentHash === null || currentHash !== content_hash) {
        staleSessionIds.add(session_id);
      }
    }

    if (staleSessionIds.size === 0) {
      // All sessions valid
      return (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;
    }

    // Count propositions whose session is NOT stale
    const placeholders = [...staleSessionIds].map(() => "?").join(",");
    const staleCount = (this.db.prepare(
      `SELECT COUNT(*) as count FROM propositions WHERE session_id IN (${placeholders})`
    ).get(...staleSessionIds) as { count: number }).count;

    const totalProps = (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;
    return totalProps - staleCount;
  }

  /**
   * Batch-validate propositions for a set of entities.
   * Returns a map of entity_id → valid_proposition_count.
   */
  private batchValidateForEntities(entityIds: string[]): Map<string, number> {
    const result = new Map<string, number>();
    if (entityIds.length === 0) return result;

    // Build the set of stale session IDs first
    const allFiles = this.db.prepare(
      "SELECT DISTINCT file_path, content_hash, session_id FROM session_files"
    ).all() as Array<{ file_path: string; content_hash: string; session_id: string }>;

    const staleSessionIds = new Set<string>();
    for (const { file_path, content_hash, session_id } of allFiles) {
      const currentHash = this.getCurrentFileHash(file_path);
      if (currentHash === null || currentHash !== content_hash) {
        staleSessionIds.add(session_id);
      }
    }

    // For each entity, count propositions that are NOT in stale sessions
    for (const entityId of entityIds) {
      if (staleSessionIds.size === 0) {
        // All valid — just count
        const count = (this.db.prepare(
          "SELECT COUNT(*) as count FROM about WHERE entity_id = ?"
        ).get(entityId) as { count: number }).count;
        result.set(entityId, count);
      } else {
        const placeholders = [...staleSessionIds].map(() => "?").join(",");
        const count = (this.db.prepare(
          `SELECT COUNT(*) as count FROM about a
           JOIN propositions p ON a.proposition_id = p.id
           WHERE a.entity_id = ? AND p.session_id NOT IN (${placeholders})`
        ).get(entityId, ...staleSessionIds) as { count: number }).count;
        result.set(entityId, count);
      }
    }

    return result;
  }

  private enrichProposition(row: PropositionRow): PropositionInfo {
    const sessionFiles = this.db.prepare(
      "SELECT file_path, content_hash FROM session_files WHERE session_id = ?"
    ).all(row.session_id) as SessionFileRow[];

    const sourceFiles = sessionFiles.map((sf) => {
      const currentHash = this.getCurrentFileHash(sf.file_path);
      return {
        path: sf.file_path,
        hash: sf.content_hash,
        current_match: currentHash !== null && currentHash === sf.content_hash,
      };
    });

    const valid = sourceFiles.length === 0 || sourceFiles.every((sf) => sf.current_match);

    return {
      id: row.id,
      content: row.content,
      kind: row.kind,
      session_id: row.session_id,
      created_at: row.created_at,
      valid,
      source_files: sourceFiles,
    };
  }

  private resolveEntityForQuery(nameOrId: string): { id: string; name: string } {
    // Try by ID
    const byId = this.db.prepare("SELECT id, name FROM entities WHERE id = ?").get(nameOrId) as EntityRow | undefined;
    if (byId) return { id: byId.id, name: byId.name };

    // Try by exact name
    const byName = this.db.prepare("SELECT id, name FROM entities WHERE name = ?").get(nameOrId) as EntityRow | undefined;
    if (byName) return { id: byName.id, name: byName.name };

    // Try normalized
    const normalized = nameOrId.toLowerCase().trim();
    const normMatch = this.db.prepare("SELECT id, name FROM entities WHERE LOWER(TRIM(name)) = ?").get(normalized) as EntityRow | undefined;
    if (normMatch) return { id: normMatch.id, name: normMatch.name };

    throw new Error(`Entity not found: ${nameOrId}`);
  }
}

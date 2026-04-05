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

function hashContent(content: string): string {
  return crypto
    .createHash("sha256")
    .update(content.replace(/\r\n/g, "\n").trimEnd())
    .digest("hex")
    .substring(0, 16);
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

    const status = this.getStatusInternal();
    return {
      session_id: sessionId,
      entities: status.total_entities,
      valid_propositions: status.valid_propositions,
      stale: status.stale_propositions,
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

    const propCount = (this.db.prepare(
      "SELECT COUNT(*) as count FROM propositions WHERE session_id = ?"
    ).get(sessionId) as { count: number }).count;

    const entityCount = (this.db.prepare(
      "SELECT COUNT(DISTINCT entity_id) as count FROM about WHERE proposition_id IN (SELECT id FROM propositions WHERE session_id = ?)"
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
      "INSERT INTO propositions (id, content, content_hash, session_id, created_at) VALUES (?, ?, ?, ?, ?)"
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
        const existing = this.db.prepare(
          "SELECT id FROM propositions WHERE content_hash = ?"
        ).get(contentHash) as { id: string } | undefined;

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
          insertProp.run(propId, prop.content, contentHash, this.activeSessionId!, timestamp);
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

    const entities: EntityInfo[] = rows.map((row) => {
      const validCount = this.countValidPropositionsForEntity(row.id);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        scope: row.scope,
        summary: row.summary,
        proposition_count: row.proposition_count,
        valid_proposition_count: validCount,
      };
    });

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

    const propRows = this.db.prepare(
      `SELECT DISTINCT p.* FROM propositions p
       JOIN session_files sf ON p.session_id = sf.session_id
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
    return this.getStatusInternal();
  }

  gaps(options?: { specPatterns?: string[]; implPatterns?: string[] }): GapsResult {
    this.fileHashCache.clear();

    const specPatterns = options?.specPatterns ?? ["%.md", "%.txt", "%spec%", "%plan%", "%req%", "%doc%"];
    const implPatterns = options?.implPatterns ?? ["%.ts", "%.js", "%.tsx", "%.jsx", "%.py", "%.go", "%.rs"];

    // Find spec-sourced propositions (from sessions that included spec-like files)
    const specProps = this.db.prepare(
      `SELECT DISTINCT p.id, p.content, p.content_hash, sf.file_path
       FROM propositions p
       JOIN proposition_sessions ps ON p.id = ps.proposition_id
       JOIN session_files sf ON ps.session_id = sf.session_id
       WHERE ${specPatterns.map(() => "sf.file_path LIKE ?").join(" OR ")}`
    ).all(...specPatterns) as Array<{ id: string; content: string; content_hash: string; file_path: string }>;

    // Find impl-sourced propositions
    const implProps = this.db.prepare(
      `SELECT DISTINCT p.id, p.content, p.content_hash, sf.file_path
       FROM propositions p
       JOIN proposition_sessions ps ON p.id = ps.proposition_id
       JOIN session_files sf ON ps.session_id = sf.session_id
       WHERE ${implPatterns.map(() => "sf.file_path LIKE ?").join(" OR ")}`
    ).all(...implPatterns) as Array<{ id: string; content: string; content_hash: string; file_path: string }>;

    const specHashes = new Map(specProps.map((p) => [p.content_hash, p]));
    const implHashes = new Map(implProps.map((p) => [p.content_hash, p]));

    const result: GapsResult = { unimplemented: [], unplanned: [], matched: [] };

    for (const [hash, spec] of specHashes) {
      const impl = implHashes.get(hash);
      if (impl) {
        result.matched.push({
          content: spec.content,
          plan_source: spec.file_path,
          impl_source: impl.file_path,
        });
      } else {
        result.unimplemented.push({
          content: spec.content,
          source: spec.file_path,
          proposition_id: spec.id,
        });
      }
    }

    for (const [hash, impl] of implHashes) {
      if (!specHashes.has(hash)) {
        result.unplanned.push({
          content: impl.content,
          source: impl.file_path,
          proposition_id: impl.id,
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

  private isPropositionValid(propositionId: string): boolean {
    const sessionFiles = this.db.prepare(
      `SELECT sf.file_path, sf.content_hash
       FROM session_files sf
       JOIN propositions p ON p.session_id = sf.session_id
       WHERE p.id = ?`
    ).all(propositionId) as SessionFileRow[];

    if (sessionFiles.length === 0) return true; // No provenance = always valid

    for (const sf of sessionFiles) {
      const currentHash = this.getCurrentFileHash(sf.file_path);
      if (currentHash === null || currentHash !== sf.content_hash) {
        return false;
      }
    }
    return true;
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
      session_id: row.session_id,
      created_at: row.created_at,
      valid,
      source_files: sourceFiles,
    };
  }

  private countValidPropositionsForEntity(entityId: string): number {
    const propIds = this.db.prepare(
      "SELECT proposition_id FROM about WHERE entity_id = ?"
    ).all(entityId) as Array<{ proposition_id: string }>;

    let count = 0;
    for (const { proposition_id } of propIds) {
      if (this.isPropositionValid(proposition_id)) {
        count++;
      }
    }
    return count;
  }

  private getStatusInternal(): StatusResult {
    const totalProps = (this.db.prepare("SELECT COUNT(*) as count FROM propositions").get() as { count: number }).count;
    const totalEntities = (this.db.prepare("SELECT COUNT(*) as count FROM entities").get() as { count: number }).count;
    const totalSessions = (this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count;

    let validCount = 0;
    if (totalProps > 0) {
      const allProps = this.db.prepare("SELECT id FROM propositions").all() as Array<{ id: string }>;
      for (const { id } of allProps) {
        if (this.isPropositionValid(id)) {
          validCount++;
        }
      }
    }

    return {
      total_propositions: totalProps,
      valid_propositions: validCount,
      stale_propositions: totalProps - validCount,
      total_entities: totalEntities,
      total_sessions: totalSessions,
      active_session: this.activeSessionId,
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

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
  BySourceResult,
  StatusResult,
  BeginResult,
  EndResult,
  RegisterSourceResult,
  SourceSession,
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

export class MemoryStore {
  private db: Database.Database;
  private sourceRoot: string;
  private fileHashCache: Map<string, string | null> = new Map();

  constructor(dbPath: string, sourceRoot?: string) {
    this.db = openDatabase(dbPath);
    this.sourceRoot = sourceRoot ?? process.cwd();
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

  private requireActiveSession(): string {
    const session = this.getActiveSession();
    if (!session) {
      throw new Error("No active session. Call memory_begin first.");
    }
    return session.id;
  }

  // --- Session lifecycle ---

  begin(): BeginResult {
    const existing = this.getActiveSession();
    if (existing) {
      throw new Error(`Session already active: ${existing.id}. Call memory_end first.`);
    }

    const sessionId = generateId();

    this.db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(sessionId, now());

    const status = this.computeStatus();
    return {
      session_id: sessionId,
      entities: status.total_entities,
      valid_propositions: status.valid_propositions,
      stale: status.stale_propositions,
    };
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
    const sessionId = this.requireActiveSession();

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.sourceRoot, filePath);

    // Reject paths outside the source root
    const normalizedRoot = path.resolve(this.sourceRoot) + path.sep;
    const normalizedPath = path.resolve(resolvedPath);
    if (!normalizedPath.startsWith(normalizedRoot) && normalizedPath !== path.resolve(this.sourceRoot)) {
      throw new Error(`Source file is outside the source root: ${filePath}`);
    }

    const hash = hashFile(resolvedPath);
    if (hash === null) {
      throw new Error(`Cannot read file: ${filePath}`);
    }

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    const existing = this.db.prepare(
      "SELECT content_hash FROM session_files WHERE session_id = ? AND file_path = ?"
    ).get(sessionId, storedPath) as { content_hash: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE session_files SET content_hash = ? WHERE session_id = ? AND file_path = ?"
      ).run(hash, sessionId, storedPath);
      return { file_path: storedPath, content_hash: hash, status: "updated" };
    }

    this.db.prepare(
      "INSERT INTO session_files (session_id, file_path, content_hash) VALUES (?, ?, ?)"
    ).run(sessionId, storedPath, hash);

    return { file_path: storedPath, content_hash: hash, status: "registered" };
  }

  // --- Proposition emission ---

  emit(propositions: EmitProposition[]): EmitResult {
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

    const insertProp = this.db.prepare(
      "INSERT INTO propositions (id, content, content_hash, session_id, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const insertAbout = this.db.prepare(
      "INSERT OR IGNORE INTO about (proposition_id, entity_id) VALUES (?, ?)"
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
          insertProp.run(propId, prop.content, contentHash, sessionId, now());
          propResult.id = propId;
          result.created++;
        }

        for (const entityName of prop.entities) {
          const resolved = this.resolveEntity(entityName);
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
    });

    emitAll();
    return result;
  }

  // --- Entity resolution ---

  private resolveEntity(name: string): { id: string; name: string; resolution: "exact" | "normalized" | "created" } {
    const exact = this.db.prepare(
      "SELECT id, name FROM entities WHERE name = ?"
    ).get(name) as EntityRow | undefined;
    if (exact) {
      return { id: exact.id, name: exact.name, resolution: "exact" };
    }

    const normalized = name.toLowerCase().trim();
    const normMatch = this.db.prepare(
      "SELECT id, name FROM entities WHERE LOWER(TRIM(name)) = ?"
    ).get(normalized) as EntityRow | undefined;
    if (normMatch) {
      return { id: normMatch.id, name: normMatch.name, resolution: "normalized" };
    }

    const id = generateId();
    this.db.prepare(
      "INSERT INTO entities (id, name, kind, created_at) VALUES (?, ?, NULL, ?)"
    ).run(id, name, now());

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
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Array<EntityRow & { proposition_count: number }>;

    const staleSessionIds = this.getStaleSessionIds();

    const entities: EntityInfo[] = rows.map((row) => {
      const validCount = this.countValidForEntity(row.id, staleSessionIds);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        proposition_count: row.proposition_count,
        valid_proposition_count: validCount,
      };
    });

    return { entities, total: countRow.total };
  }

  inspect(entityIdOrName: string): InspectResult {
    this.fileHashCache.clear();

    let entity = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(entityIdOrName) as EntityRow | undefined;
    if (!entity) {
      entity = this.db.prepare("SELECT * FROM entities WHERE name = ?").get(entityIdOrName) as EntityRow | undefined;
    }
    if (!entity) {
      entity = this.db.prepare("SELECT * FROM entities WHERE LOWER(name) = ?").get(entityIdOrName.toLowerCase()) as EntityRow | undefined;
    }
    if (!entity) {
      throw new Error(`Entity not found: ${entityIdOrName}`);
    }

    const propRows = this.db.prepare(
      `SELECT p.* FROM propositions p
       JOIN about a ON p.id = a.proposition_id
       WHERE a.entity_id = ?
       ORDER BY p.created_at DESC`
    ).all(entity.id) as PropositionRow[];

    const propositions = propRows.map((p) => this.enrichProposition(p));

    const sessionIds = [...new Set(propRows.map((p) => p.session_id))];
    const sourceSessions: SourceSession[] = sessionIds.map((sid) => {
      const files = this.db.prepare(
        "SELECT file_path FROM session_files WHERE session_id = ?"
      ).all(sid) as Array<{ file_path: string }>;
      return { id: sid, files: files.map((f) => f.file_path) };
    });

    const validCount = propositions.filter((p) => p.valid).length;

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: propositions.length,
        valid_proposition_count: validCount,
      },
      propositions,
      source_sessions: sourceSessions,
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
    return this.computeStatus();
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

  private getStaleSessionIds(): Set<string> {
    const allFiles = this.db.prepare(
      "SELECT session_id, file_path, content_hash FROM session_files"
    ).all() as Array<{ session_id: string; file_path: string; content_hash: string }>;

    const stale = new Set<string>();
    for (const { session_id, file_path, content_hash } of allFiles) {
      if (stale.has(session_id)) continue;
      const currentHash = this.getCurrentFileHash(file_path);
      if (currentHash === null || currentHash !== content_hash) {
        stale.add(session_id);
      }
    }
    return stale;
  }

  private computeStatus(): StatusResult {
    const totalProps = (this.db.prepare("SELECT COUNT(*) as c FROM propositions").get() as { c: number }).c;
    const totalEntities = (this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
    const totalSessions = (this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    const activeSession = this.getActiveSession();

    const stale = this.getStaleSessionIds();
    let validCount: number;

    if (stale.size === 0) {
      validCount = totalProps;
    } else {
      const placeholders = [...stale].map(() => "?").join(",");
      const staleCount = (this.db.prepare(
        `SELECT COUNT(*) as c FROM propositions WHERE session_id IN (${placeholders})`
      ).get(...stale) as { c: number }).c;
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

  private countValidForEntity(entityId: string, staleSessionIds: Set<string>): number {
    if (staleSessionIds.size === 0) {
      return (this.db.prepare(
        "SELECT COUNT(*) as c FROM about WHERE entity_id = ?"
      ).get(entityId) as { c: number }).c;
    }
    const placeholders = [...staleSessionIds].map(() => "?").join(",");
    return (this.db.prepare(
      `SELECT COUNT(*) as c FROM about a
       JOIN propositions p ON a.proposition_id = p.id
       WHERE a.entity_id = ? AND p.session_id NOT IN (${placeholders})`
    ).get(entityId, ...staleSessionIds) as { c: number }).c;
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
}

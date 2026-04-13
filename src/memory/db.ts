/**
 * Memory store database layer. Four tables plus an FTS5 virtual table
 * mirroring `propositions.content`.
 */

import "./suppress-warnings.js";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

// Loose-typed adapter over `node:sqlite`. Centralises the `unknown ↔
// SQLInputValue / SQLOutputValue` casts in one place so store.ts can
// keep its own row types without re-casting at every call site.
export interface Stmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): void;
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

function wrap(inner: DatabaseSync): Db {
  const wrapStmt = (stmt: StatementSync): Stmt => ({
    all: (...params: unknown[]) => stmt.all(...(params as SQLInputValue[])),
    get: (...params: unknown[]) => stmt.get(...(params as SQLInputValue[])),
    run: (...params: unknown[]) => {
      stmt.run(...(params as SQLInputValue[]));
    },
  });
  return {
    prepare: (sql: string) => wrapStmt(inner.prepare(sql)),
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entity_kind ON entities(kind);

CREATE TABLE IF NOT EXISTS propositions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_hash_coll ON propositions(content_hash, collection);
CREATE INDEX IF NOT EXISTS idx_prop_collection ON propositions(collection);

CREATE TABLE IF NOT EXISTS about (
  proposition_id TEXT NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (proposition_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_about_entity ON about(entity_id);

CREATE TABLE IF NOT EXISTS proposition_sources (
  proposition_id TEXT NOT NULL REFERENCES propositions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ms REAL,
  PRIMARY KEY (proposition_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_ps_file ON proposition_sources(file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts USING fts5(
  content,
  content='propositions',
  content_rowid='rowid'
);

-- Keep FTS in sync with propositions table. Only INSERT and DELETE
-- triggers fire in practice: memory_emit uses ON CONFLICT DO NOTHING on
-- the (content_hash, collection) unique index, so an UPDATE path on the
-- propositions row never executes. The AFTER UPDATE trigger was present
-- in earlier schemas and never fired; removing it keeps the schema
-- honest about the real write path.
CREATE TRIGGER IF NOT EXISTS propositions_ai AFTER INSERT ON propositions BEGIN
  INSERT INTO propositions_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS propositions_ad AFTER DELETE ON propositions BEGIN
  INSERT INTO propositions_fts(propositions_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
`;

function checkSchemaCompatibility(db: Db): void {
  // Pre-1.3 databases have `sessions` and `session_files` tables and a
  // `propositions.session_id NOT NULL` column. The schema is incompatible
  // enough that migration isn't worth the code — surface a clear error.
  const legacyTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions', 'session_files')",
    )
    .all() as Array<{ name: string }>;

  if (legacyTables.length > 0) {
    throw new Error(
      "Memory database uses a pre-1.3 schema (sessions/session_files tables present). " +
        "The storage layout is incompatible with this version — delete the memory.db file " +
        "and re-run. Freelance will re-compile knowledge on demand.",
    );
  }
}

export function openDatabase(dbPath: string): Db {
  const inner = new DatabaseSync(dbPath);
  inner.exec("PRAGMA journal_mode = WAL");
  inner.exec("PRAGMA foreign_keys = ON");
  inner.exec("PRAGMA busy_timeout = 5000");
  const db = wrap(inner);
  checkSchemaCompatibility(db);
  inner.exec(SCHEMA_SQL);

  // Converge older databases that were created with the propositions_au
  // AFTER UPDATE trigger. memory_emit's ON CONFLICT DO NOTHING means
  // UPDATE never happens on the propositions row, so the trigger was
  // dormant — this drop just makes the schema deterministic across
  // freshly-opened databases.
  inner.exec("DROP TRIGGER IF EXISTS propositions_au");

  // Rebuild FTS index on every open — external content tables don't persist
  // their index across connections, so we rebuild to ensure search works.
  db.exec("INSERT INTO propositions_fts(propositions_fts) VALUES ('rebuild')");

  return db;
}

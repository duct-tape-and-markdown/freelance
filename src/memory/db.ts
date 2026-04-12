/**
 * Memory store database layer. Five tables plus an FTS5 virtual table
 * mirroring `propositions.content`.
 */

import "./suppress-warnings.js";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";

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
    run: (...params: unknown[]) => { stmt.run(...(params as SQLInputValue[])); },
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

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_sf_path ON session_files(file_path);

CREATE TABLE IF NOT EXISTS propositions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
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
  PRIMARY KEY (proposition_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_ps_file ON proposition_sources(file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS propositions_fts USING fts5(
  content,
  content='propositions',
  content_rowid='rowid'
);

-- Keep FTS in sync with propositions table.
CREATE TRIGGER IF NOT EXISTS propositions_ai AFTER INSERT ON propositions BEGIN
  INSERT INTO propositions_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS propositions_ad AFTER DELETE ON propositions BEGIN
  INSERT INTO propositions_fts(propositions_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS propositions_au AFTER UPDATE ON propositions BEGIN
  INSERT INTO propositions_fts(propositions_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO propositions_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function migrate(db: Db): void {
  // Add mtime_ms columns for stat()-based staleness checks (replaces read+hash).
  for (const table of ["session_files", "proposition_sources"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "mtime_ms")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN mtime_ms REAL`);
    }
  }
}

export function openDatabase(dbPath: string): Db {
  const inner = new DatabaseSync(dbPath);
  inner.exec("PRAGMA journal_mode = WAL");
  inner.exec("PRAGMA foreign_keys = ON");
  inner.exec("PRAGMA busy_timeout = 5000");
  inner.exec(SCHEMA_SQL);
  const db = wrap(inner);
  migrate(db);

  // Rebuild FTS index on every open — external content tables don't persist
  // their index across connections, so we rebuild to ensure search works.
  db.exec("INSERT INTO propositions_fts(propositions_fts) VALUES ('rebuild')");

  return db;
}

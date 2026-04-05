/**
 * SQLite database layer for Freelance Memory.
 *
 * Handles schema creation and provides low-level database access.
 */

import Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT,
  scope TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_name_scope ON entities(name, scope);
CREATE INDEX IF NOT EXISTS idx_entity_kind ON entities(kind);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_session_files_path ON session_files(file_path);

CREATE TABLE IF NOT EXISTS propositions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'observation',
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_hash_kind ON propositions(content_hash, kind);
CREATE INDEX IF NOT EXISTS idx_prop_kind ON propositions(kind);
CREATE INDEX IF NOT EXISTS idx_prop_session ON propositions(session_id);

CREATE TABLE IF NOT EXISTS about (
  proposition_id TEXT NOT NULL REFERENCES propositions(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  role TEXT,
  PRIMARY KEY (proposition_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_about_entity ON about(entity_id);

CREATE TABLE IF NOT EXISTS relates_to (
  from_id TEXT NOT NULL REFERENCES propositions(id),
  to_id TEXT NOT NULL REFERENCES propositions(id),
  relationship_type TEXT,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS proposition_sessions (
  proposition_id TEXT NOT NULL REFERENCES propositions(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  PRIMARY KEY (proposition_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_ps_session ON proposition_sessions(session_id);
`;

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

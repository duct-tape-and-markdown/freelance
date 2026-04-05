/**
 * SQLite database layer for Freelance Memory.
 *
 * Five tables. No vector columns. No embedding indexes.
 */

import Database from "better-sqlite3";

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
  session_id TEXT NOT NULL REFERENCES sessions(id),
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_sf_path ON session_files(file_path);

CREATE TABLE IF NOT EXISTS propositions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_hash ON propositions(content_hash);

CREATE TABLE IF NOT EXISTS about (
  proposition_id TEXT NOT NULL REFERENCES propositions(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  PRIMARY KEY (proposition_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_about_entity ON about(entity_id);
`;

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

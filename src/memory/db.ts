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
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_hash ON propositions(content_hash);

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
`;

function migrate(db: Database.Database): void {
  // Add mtime_ms columns for stat()-based staleness checks (replaces read+hash).
  for (const table of ["session_files", "proposition_sources"]) {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "mtime_ms")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN mtime_ms REAL`);
    }
  }
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrate(db);

  // Rebuild FTS index on every open — external content tables don't persist
  // their index across connections, so we rebuild to ensure search works.
  db.exec("INSERT INTO propositions_fts(propositions_fts) VALUES ('rebuild')");

  return db;
}

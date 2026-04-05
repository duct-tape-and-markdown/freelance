/**
 * SQLite database for Freelance traversal state.
 *
 * Traversals are stored as JSON blobs. The graph engine is rebuilt
 * from the stack on every operation — no in-memory state.
 */

import Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS traversals (
  id TEXT PRIMARY KEY,
  stack TEXT NOT NULL,
  graph_id TEXT NOT NULL,
  current_node TEXT NOT NULL,
  stack_depth INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openStateDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * Memory store database layer. Four tables plus an FTS5 virtual table
 * mirroring `propositions.content`.
 */

import "./suppress-warnings.js";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { EC, EngineError } from "../errors.js";

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
    close: () => {
      // Truncate the WAL before closing so `memory.db-wal` / `memory.db-shm`
      // don't linger on disk. Without this, the sidecar files persist after
      // the process exits and can grow indefinitely between checkpoints.
      try {
        inner.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Checkpoint failure shouldn't block close — the WAL stays on disk
        // but SQLite will recover from it on next open.
      }
      inner.close();
    },
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

-- Keep FTS in sync with propositions table. Only INSERT and DELETE
-- triggers fire in practice: memory_emit uses ON CONFLICT DO NOTHING on
-- the content_hash unique index, so an UPDATE path on the propositions
-- row never executes. The AFTER UPDATE trigger was present in earlier
-- schemas and never fired; removing it keeps the schema honest about
-- the real write path.
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

/**
 * Transparent migration for the dead `collection` column on `propositions`.
 *
 * Memory's single-flat-namespace invariant (see `docs/memory-intent.md`)
 * rules out collections as a feature, but the schema carried a
 * `collection TEXT NOT NULL DEFAULT 'default'` column plus a compound
 * UNIQUE(content_hash, collection) index from an earlier iteration.
 * No write path ever set anything other than `'default'` and no read
 * path filtered on it, so the column + compound index can be dropped
 * in place: existing rows' `content_hash` is already unique on its
 * own because every row's `collection` was `'default'`.
 *
 * Runs after `SCHEMA_SQL` so the new `idx_prop_hash` exists before the
 * old compound index is removed — readers never see a window without a
 * content_hash index.
 */
function migrateDropCollectionColumn(db: Db): void {
  const cols = db.prepare("PRAGMA table_info(propositions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "collection")) return;

  db.exec("DROP INDEX IF EXISTS idx_prop_hash_coll");
  db.exec("DROP INDEX IF EXISTS idx_prop_collection");
  db.exec("ALTER TABLE propositions DROP COLUMN collection");
}

/**
 * Transparent migration for the dead `mtime_ms` column on
 * `proposition_sources`. Post-#74 the column was neither written nor
 * read — drift detection re-hashes content per-call via
 * `StalenessCache` amortization — but the column was retained for
 * existing databases. 1.4 drops it outright. Mirrors the
 * `propositions.collection` drop pattern above.
 *
 * mtime-based drift detection is fundamentally unsafe: `git checkout`,
 * `rsync -t`, and `touch -r` all preserve mtime across real edits. No
 * legitimate use absent the removed fast path. See `docs/decisions.md`
 * § "mtime_ms column removed from `proposition_sources`".
 */
function migrateDropMtimeColumn(db: Db): void {
  const cols = db
    .prepare("PRAGMA table_info(proposition_sources)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "mtime_ms")) return;

  db.exec("ALTER TABLE proposition_sources DROP COLUMN mtime_ms");
}

/**
 * SQLITE_BUSY detection across node:sqlite's error shape. Matches both
 * "database is locked" (short timeout / immediate) and "database is
 * busy" (long-held writer) variants.
 */
function isSqliteBusy(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  return code === "ERR_SQLITE_ERROR" && /database is (locked|busy)/i.test(e.message);
}

/**
 * Pause the event loop without pinning a core. Atomics.wait is the only
 * sync-sleep available to node that's neither a busy loop nor a shell
 * subprocess. The SharedArrayBuffer is allocated per call — allocation
 * cost is negligible next to the ms-scale sleep we're timing.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Retry profile for open-time contention. busy_timeout covers in-query
// waits (5s of internal retry), but a handful of code paths bypass it:
// last-connection WAL checkpoint, crash recovery, and deadlock-avoid.
// https://www.sqlite.org/wal.html §5, https://sqlite.org/forum/forumpost/4350638e78869137.
// Three 50 ms retries = 150 ms worst-case added latency; low enough to
// absorb into a CLI invocation, high enough to clear typical sibling-
// process contention.
const BUSY_RETRY_DELAYS_MS = [50, 50, 50];

/**
 * Run `fn`, retrying on SQLITE_BUSY up to BUSY_RETRY_DELAYS_MS.length
 * extra times. Non-busy errors propagate immediately (no retry). When
 * every attempt is busy, throws `EngineError(DATABASE_BUSY)` so the
 * CLI error envelope replaces the raw `ERR_SQLITE_ERROR` stack trace.
 */
export function retryOnSqliteBusy<T>(fn: () => T, context: string): T {
  let lastBusyError: Error | undefined;
  for (let attempt = 0; attempt <= BUSY_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isSqliteBusy(e)) throw e;
      lastBusyError = e as Error;
      if (attempt < BUSY_RETRY_DELAYS_MS.length) {
        sleepSync(BUSY_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw new EngineError(
    `Memory database is busy — another Freelance process has a conflicting lock on ` +
      `${context}. Re-run the command; contention usually clears in <1s. ` +
      `(Underlying: ${lastBusyError?.message ?? "SQLITE_BUSY"})`,
    EC.DATABASE_BUSY,
  );
}

export function openDatabase(dbPath: string): Db {
  return retryOnSqliteBusy(() => openDatabaseOnce(dbPath), dbPath);
}

function openDatabaseOnce(dbPath: string): Db {
  const inner = new DatabaseSync(dbPath);
  // busy_timeout must be set before journal_mode: switching to WAL takes
  // a write lock, and without busy_timeout the SQLite C layer returns
  // SQLITE_BUSY immediately on contention instead of retrying for 5s.
  // Default busy handling is 0 ms — per-connection, reset on every open.
  inner.exec("PRAGMA busy_timeout = 5000");
  inner.exec("PRAGMA journal_mode = WAL");
  inner.exec("PRAGMA foreign_keys = ON");
  // Default auto-checkpoint is 1000 pages (≈4 MB at 4 KB pages). We saw a
  // 385 KB database with a 4.25 MB WAL in the wild, which is exactly that
  // threshold. Tighten to 200 pages (≈800 KB) so the WAL is recycled more
  // aggressively during long-running sessions.
  inner.exec("PRAGMA wal_autocheckpoint = 200");
  const db = wrap(inner);
  checkSchemaCompatibility(db);
  inner.exec(SCHEMA_SQL);
  migrateDropCollectionColumn(db);
  migrateDropMtimeColumn(db);

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

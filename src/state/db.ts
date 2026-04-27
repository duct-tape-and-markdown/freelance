/**
 * Persistent traversal state — JSON files on disk, with an in-memory variant
 * for the `:memory:` sentinel and tests.
 */

import fs from "node:fs";
import path from "node:path";
import { EC, EngineError } from "../errors.js";
import type { SessionState } from "../types.js";

export interface TraversalRecord {
  id: string;
  stack: SessionState[];
  graphId: string;
  currentNode: string;
  stackDepth: number;
  createdAt: string;
  updatedAt: string;
  // Monotonic revision counter. Bumped on every successful put. Callers
  // that read-then-write use this for optimistic-concurrency conflict
  // detection via `putIfVersion`. Optional on the type for backward
  // compatibility with pre-1.4 records on disk; read paths synthesize
  // `version: 0` when absent.
  version?: number;
  // Caller-supplied opaque tags set at createTraversal time and mutable
  // thereafter via setMeta. Freelance never interprets the keys or values —
  // they exist purely so external systems can find a traversal by their own
  // business key (ticket id, PR url, branch, doc path, …).
  meta?: Record<string, string>;
}

export interface StateStore {
  /** Enumerate traversal ids without parsing records. Cheap — use this when all you need is count or presence. */
  listIds(): string[];
  /** Load all records. Each record requires a full read + parse, so prefer `listIds` for count/presence checks. */
  list(): TraversalRecord[];
  get(id: string): TraversalRecord | undefined;
  /** Unconditional write. Use for first-time creation; prefer `putIfVersion` for updates. */
  put(record: TraversalRecord): void;
  /**
   * Optimistic-concurrency update. Writes `record` iff a record with
   * the same id exists and its on-disk version still matches
   * `expectedVersion`. Two distinct failure shapes:
   *
   *   - missing record (deleted between read and write, e.g. via a
   *     racing `reset --confirm`) → `EngineError(TRAVERSAL_NOT_FOUND)`,
   *     `recoveryKind: "clear"`. The skill drops the dead handle.
   *   - version drift (another writer bumped the version) →
   *     `EngineError(TRAVERSAL_CONFLICT)` (TraversalConflictError),
   *     `recoveryKind: "retry"`. The skill re-reads and retries.
   *
   * Use `put` for first-time creation; this method assumes the caller
   * loaded a prior record and rejects the resurrection case (per #163)
   * — the missing-record throw still blocks the write, just under a
   * code whose recovery shape matches the actual situation.
   *
   * The supplied `record.version` is ignored on input — the store
   * always writes `expectedVersion + 1`. Returns the record actually
   * written (with the bumped version) so callers have an accurate
   * view of what's on disk without a follow-up read.
   */
  putIfVersion(record: TraversalRecord, expectedVersion: number): TraversalRecord;
  delete(id: string): void;
  close(): void;
}

class TraversalConflictError extends EngineError {
  constructor(id: string, expected: number, actual: number) {
    super(
      `Traversal "${id}" was modified concurrently (expected version ${expected}, found ${actual}). ` +
        `Re-read the traversal and retry.`,
      EC.TRAVERSAL_CONFLICT,
    );
  }
}

function sortByUpdatedDesc(records: TraversalRecord[]): TraversalRecord[] {
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

class InMemoryStateStore implements StateStore {
  private records = new Map<string, TraversalRecord>();

  listIds(): string[] {
    return [...this.records.keys()];
  }
  list(): TraversalRecord[] {
    return sortByUpdatedDesc([...this.records.values()]);
  }
  get(id: string): TraversalRecord | undefined {
    return this.records.get(id);
  }
  put(record: TraversalRecord): void {
    this.records.set(record.id, { ...record, version: (record.version ?? 0) + 1 });
  }
  putIfVersion(record: TraversalRecord, expectedVersion: number): TraversalRecord {
    const current = this.records.get(record.id);
    if (!current) {
      throw new EngineError(
        `Traversal "${record.id}" not found (deleted between read and write).`,
        EC.TRAVERSAL_NOT_FOUND,
      );
    }
    const currentVersion = current.version ?? 0;
    if (currentVersion !== expectedVersion) {
      throw new TraversalConflictError(record.id, expectedVersion, currentVersion);
    }
    const next = { ...record, version: expectedVersion + 1 };
    this.records.set(record.id, next);
    return next;
  }
  delete(id: string): void {
    this.records.delete(id);
  }
  close(): void {}
}

function assertSafeId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new Error(`Invalid traversal id: ${JSON.stringify(id)}`);
  }
}

class JsonDirectoryStateStore implements StateStore {
  // Constructor is pure — directory creation happens in openStateStore
  // so the class can be tested against an already-prepared directory.
  constructor(private dir: string) {}

  private fileFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /** Read directory entries that look like traversal files. Orphaned `<id>.json.tmp` files are skipped. */
  private traversalEntries(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((entry) => entry.endsWith(".json"));
    } catch {
      return [];
    }
  }

  listIds(): string[] {
    return this.traversalEntries().map((entry) => entry.slice(0, -".json".length));
  }

  list(): TraversalRecord[] {
    const records: TraversalRecord[] = [];
    for (const entry of this.traversalEntries()) {
      try {
        const raw = fs.readFileSync(path.join(this.dir, entry), "utf-8");
        records.push(JSON.parse(raw) as TraversalRecord);
      } catch {
        // Unreadable / malformed — silently skip; a future put() will overwrite.
      }
    }
    return sortByUpdatedDesc(records);
  }

  get(id: string): TraversalRecord | undefined {
    try {
      const raw = fs.readFileSync(this.fileFor(id), "utf-8");
      return JSON.parse(raw) as TraversalRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  put(record: TraversalRecord): void {
    const next = { ...record, version: (record.version ?? 0) + 1 };
    this.writeAtomic(next);
  }

  putIfVersion(record: TraversalRecord, expectedVersion: number): TraversalRecord {
    // Within a single Node process the read-check-write here is
    // effectively atomic — the event loop can't interleave synchronous
    // fs calls. Across processes it's still racy (classic TOCTOU on
    // the version field), but the per-file rename is atomic, so the
    // worst case is two writers both think they won. For Freelance's
    // workload (per-checkout tool, rare cross-process concurrency)
    // detection via TRAVERSAL_CONFLICT beats silent loss.
    const existing = this.get(record.id);
    if (!existing) {
      throw new EngineError(
        `Traversal "${record.id}" not found (deleted between read and write).`,
        EC.TRAVERSAL_NOT_FOUND,
      );
    }
    const current = existing.version ?? 0;
    if (current !== expectedVersion) {
      throw new TraversalConflictError(record.id, expectedVersion, current);
    }
    const next = { ...record, version: expectedVersion + 1 };
    this.writeAtomic(next);
    return next;
  }

  private writeAtomic(record: TraversalRecord): void {
    const final = this.fileFor(record.id);
    const tmp = `${final}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, final);
  }

  delete(id: string): void {
    try {
      fs.unlinkSync(this.fileFor(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  close(): void {}
}

/**
 * Open a traversal state store. Pass `":memory:"` for an ephemeral in-process
 * store, or a directory path for a persistent JSON-file store. Ensures the
 * target directory exists before returning — callers can treat the returned
 * store as ready-to-use.
 */
export function openStateStore(pathOrSentinel: string): StateStore {
  if (pathOrSentinel === ":memory:") {
    return new InMemoryStateStore();
  }
  fs.mkdirSync(pathOrSentinel, { recursive: true });
  return new JsonDirectoryStateStore(pathOrSentinel);
}

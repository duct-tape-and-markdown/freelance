/**
 * Persistent traversal state — JSON files on disk, with an in-memory variant
 * for the `:memory:` sentinel and tests.
 */

import fs from "node:fs";
import path from "node:path";
import type { SessionState } from "../types.js";

export interface TraversalRecord {
  id: string;
  stack: SessionState[];
  graphId: string;
  currentNode: string;
  stackDepth: number;
  createdAt: string;
  updatedAt: string;
}

export interface StateStore {
  /** Enumerate traversal ids without parsing records. Cheap — use this when all you need is count or presence. */
  listIds(): string[];
  /** Load all records. Each record requires a full read + parse, so prefer `listIds` for count/presence checks. */
  list(): TraversalRecord[];
  get(id: string): TraversalRecord | undefined;
  put(record: TraversalRecord): void;
  delete(id: string): void;
  close(): void;
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
    this.records.set(record.id, record);
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
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
 * store, or a directory path for a persistent JSON-file store.
 */
export function openStateStore(pathOrSentinel: string): StateStore {
  if (pathOrSentinel === ":memory:") {
    return new InMemoryStateStore();
  }
  return new JsonDirectoryStateStore(pathOrSentinel);
}

/**
 * CLI handlers for memory subcommands — JSON-only machine surface.
 *
 * Runtime verbs under `freelance memory ...` are the primary execution
 * path for the Claude Agent Skill per `docs/decisions.md` § "CLI is the
 * primary execution surface". There is no human audience — every
 * handler writes structured JSON to stdout and exits with a semantic
 * code (see `EXIT` in output.ts).
 */

import fs from "node:fs";
import type { MemoryStore } from "../memory/index.js";
import { prune } from "../memory/prune.js";
import { EXIT, outputError, outputJson } from "./output.js";

function handleError(e: unknown): never {
  const code = outputError(e);
  process.exit(code);
}

export function memoryStatus(store: MemoryStore): void {
  try {
    outputJson(store.status());
  } catch (e) {
    handleError(e);
  }
}

export function memoryBrowse(
  store: MemoryStore,
  opts?: {
    name?: string;
    kind?: string;
    limit?: string;
    offset?: string;
    includeOrphans?: boolean;
  },
): void {
  try {
    const result = store.browse({
      name: opts?.name,
      kind: opts?.kind,
      limit: opts?.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts?.offset ? parseInt(opts.offset, 10) : undefined,
      includeOrphans: opts?.includeOrphans,
    });
    outputJson(result);
  } catch (e) {
    handleError(e);
  }
}

export function memoryInspect(store: MemoryStore, entity: string): void {
  try {
    outputJson(store.inspect(entity));
  } catch (e) {
    handleError(e);
  }
}

export function memorySearch(store: MemoryStore, query: string, opts?: { limit?: string }): void {
  try {
    outputJson(
      store.search(query, {
        limit: opts?.limit ? parseInt(opts.limit, 10) : undefined,
      }),
    );
  } catch (e) {
    handleError(e);
  }
}

export function memoryRelated(store: MemoryStore, entity: string): void {
  try {
    outputJson(store.related(entity));
  } catch (e) {
    handleError(e);
  }
}

export function memoryBySource(store: MemoryStore, filePath: string): void {
  try {
    outputJson(store.bySource(filePath));
  } catch (e) {
    handleError(e);
  }
}

export function memoryEmit(store: MemoryStore, file: string): void {
  try {
    const raw = file === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(file, "utf-8");

    let propositions: Array<{
      content: string;
      entities: string[];
      sources: string[];
      entityKinds?: Record<string, string>;
    }>;
    try {
      propositions = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const source = file === "-" ? "stdin" : file;
      throw new Error(`${source} must contain valid JSON: ${msg}`);
    }

    outputJson(store.emit(propositions));
  } catch (e) {
    handleError(e);
  }
}

export function memoryPrune(
  store: MemoryStore,
  opts: { keep?: string[]; dryRun?: boolean; yes?: boolean },
): void {
  // `process.exit` bypasses the caller's `finally { store.close() }`,
  // which would leak the WAL + SHM sidecar files on disk. Close here
  // before every exit. MemoryStore.close is idempotent, so the
  // caller's finally is a harmless no-op after this.
  if (!opts.keep || opts.keep.length === 0) {
    outputJson({
      isError: true,
      error: {
        code: "MISSING_KEEP",
        message: "memory prune requires --keep <ref> (repeatable).",
      },
    });
    store.close();
    process.exit(EXIT.INVALID_INPUT);
  }

  try {
    // `--dry-run` is itself a no-op preview; otherwise require explicit
    // `--yes`. Return the plan + an explicit refusal when neither flag
    // is set, so the skill sees the blast radius before committing.
    const confirmed = opts.dryRun || opts.yes;
    const result = prune(store, { keep: opts.keep, dryRun: !confirmed });
    if (confirmed) {
      outputJson(result);
    } else {
      outputJson({
        ...result,
        isError: true,
        error: {
          code: "CONFIRM_REQUIRED",
          message: "Refusing to delete without --yes or --dry-run.",
        },
      });
      store.close();
      process.exit(EXIT.INVALID_INPUT);
    }
  } catch (e) {
    handleError(e);
  }
}

/**
 * Delete memory.db + WAL/SHM sidecars. Safe because memory is
 * content-addressable: the next run rebuilds everything on demand.
 * Requires `--confirm` as a deliberate guard against accidents. Does
 * not open the database, so it works even when checkSchemaCompatibility
 * would reject the current file (the canonical "I upgraded Freelance
 * and my old memory.db has the wrong schema" recovery path).
 */
export function memoryReset(dbPath: string, opts: { confirm?: boolean }): void {
  if (!opts.confirm) {
    outputJson({
      isError: true,
      error: {
        code: "CONFIRM_REQUIRED",
        message: "memory reset requires --confirm (destructive: deletes memory.db + sidecars).",
      },
    });
    process.exit(EXIT.INVALID_INPUT);
  }
  const targets = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
  const deleted: string[] = [];
  try {
    for (const f of targets) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        deleted.push(f);
      }
    }
  } catch (e) {
    handleError(e);
  }
  outputJson({ status: "reset", deleted, dbPath });
}

/** CLI handlers for memory subcommands. Operates directly on MemoryStore. */

import fs from "node:fs";
import path from "node:path";
import type { MemoryStore } from "../memory/index.js";
import { prune } from "../memory/prune.js";
import { cli, info, outputJson } from "./output.js";

function handleError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  if (cli.json) {
    outputJson({ error: message });
  } else {
    info(`Error: ${message}`);
  }
  process.exit(1);
}

export function memoryStatus(store: MemoryStore): void {
  try {
    const result = store.status();
    if (cli.json) {
      outputJson(result);
    } else {
      info(
        `Propositions: ${result.total_propositions} total, ${result.valid_propositions} valid, ${result.stale_propositions} stale`,
      );
      info(`Entities: ${result.total_entities}`);
    }
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
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.entities.length === 0) {
        info("No entities found.");
        return;
      }
      for (const e of result.entities) {
        info(
          `  ${e.name}${e.kind ? ` (${e.kind})` : ""}  ${e.valid_proposition_count} propositions`,
        );
      }
      info(`\n${result.entities.length} entities (total: ${result.total})`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryInspect(store: MemoryStore, entity: string): void {
  try {
    const result = store.inspect(entity);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Entity: ${result.entity.name}${result.entity.kind ? ` (${result.entity.kind})` : ""}`);
      if (result.propositions.length > 0) {
        info("\nPropositions:");
        for (const p of result.propositions) {
          const status = p.valid ? "" : " [stale]";
          info(`  - ${p.content}${status}`);
        }
      }
      if (result.neighbors && result.neighbors.length > 0) {
        info("\nNeighbors:");
        for (const n of result.neighbors) {
          info(`  ${n.name}${n.kind ? ` (${n.kind})` : ""}`);
        }
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function memorySearch(store: MemoryStore, query: string, opts?: { limit?: string }): void {
  try {
    const result = store.search(query, {
      limit: opts?.limit ? parseInt(opts.limit, 10) : undefined,
    });
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.propositions.length === 0) {
        info("No results found.");
        return;
      }
      for (const r of result.propositions) {
        const entities = r.entities.map((e: { name: string }) => e.name).join(", ");
        const status = r.valid ? "" : " [stale]";
        info(`  [${entities}] ${r.content}${status}`);
      }
      info(`\n${result.propositions.length} results`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryRelated(store: MemoryStore, entity: string): void {
  try {
    const result = store.related(entity);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.neighbors.length === 0) {
        info("No related entities found.");
        return;
      }
      for (const r of result.neighbors) {
        info(`  ${r.name}${r.kind ? ` (${r.kind})` : ""}  shared: ${r.shared_propositions}`);
        if ("sample" in r) info(`    "${(r as { sample: string }).sample}"`);
      }
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryBySource(store: MemoryStore, filePath: string): void {
  try {
    const result = store.bySource(filePath);
    if (cli.json) {
      outputJson(result);
    } else {
      if (result.propositions.length === 0) {
        info(`No propositions found for ${filePath}.`);
        return;
      }
      for (const p of result.propositions) {
        const status = p.valid ? "" : " [stale]";
        info(`  ${p.content}${status}`);
      }
      info(`\n${result.propositions.length} propositions`);
    }
  } catch (e) {
    handleError(e);
  }
}

export function memoryEmit(store: MemoryStore, file: string): void {
  try {
    let raw: string;
    if (file === "-") {
      raw = fs.readFileSync(0, "utf-8");
    } else {
      raw = fs.readFileSync(file, "utf-8");
    }

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

    const result = store.emit(propositions);
    if (cli.json) {
      outputJson(result);
    } else {
      info(`Emitted ${result.created} propositions (${result.deduplicated} deduplicated)`);
    }
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
    if (cli.json) {
      outputJson({ error: "memory prune requires --keep <ref> (repeatable)." });
    } else {
      info("memory prune requires --keep <ref> (repeatable). No default preserve set.");
    }
    store.close();
    process.exit(2);
  }

  try {
    // `--dry-run` is itself a no-op preview; otherwise require explicit
    // `--yes`. Print the plan on the refusal so the caller sees the
    // blast radius before committing.
    const confirmed = opts.dryRun || opts.yes;
    const result = prune(store, { keep: opts.keep, dryRun: !confirmed });
    if (cli.json) {
      outputJson(
        confirmed ? result : { ...result, error: "Refusing to delete without --yes or --dry-run." },
      );
    } else {
      const preview = result.dry_run ? "Would prune" : "Pruned";
      const preview2 = result.dry_run ? "Would hard-delete" : "Hard-deleted";
      info(`${preview} ${result.rows_pruned} source row(s).`);
      info(
        `${preview2} ${result.propositions_hard_deleted} proposition(s); ${result.entities_orphaned} entity/entities orphaned.`,
      );
      if (!confirmed) info("Re-run with --yes to execute.");
    }
    if (!confirmed) {
      store.close();
      process.exit(2);
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
    info("memory reset requires --confirm (destructive: deletes memory.db + sidecars).");
    process.exit(2);
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
  if (cli.json) {
    outputJson({ status: "reset", deleted, dbPath });
  } else {
    if (deleted.length === 0) {
      info(`No memory db files found at ${path.dirname(dbPath)}/ — nothing to reset.`);
    } else {
      info(`Deleted ${deleted.length} file(s) from ${path.dirname(dbPath)}/`);
      info("Next run will re-initialize memory.db on first use.");
    }
  }
}

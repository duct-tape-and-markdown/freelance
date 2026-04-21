/**
 * Content-reachability prune for `proposition_sources`.
 *
 * A row is preserved iff its `content_hash` matches the file's content
 * at any "live" location:
 *   - the current working tree on disk, OR
 *   - the tip of any `--keep` ref (read via `git cat-file`)
 *
 * Otherwise the row's bytes exist nowhere in the set of frames the
 * user has declared live, and it's a candidate for deletion.
 *
 * This answers the prune question directly rather than via a
 * commit-reachability proxy: rebase/squash/amend rewrite commit SHAs
 * but preserve tree content, so a rebased or squashed change keeps
 * its rows as long as the bytes end up somewhere in the preserve set.
 * The old alternative — stamping HEAD at emit and checking ancestry —
 * collapsed under any history-rewriting workflow.
 *
 * Failure modes:
 *   - Unresolvable `--keep` ref → hard error before touching the db.
 *     Silently dropping a ref from the preserve set would delete data
 *     the caller expected to keep.
 *   - `cat-file` can't read the path at a ref → treated as "not present
 *     at that ref". Path-doesn't-exist-at-ref is a normal miss, not an
 *     error.
 *   - File unreadable on disk → disk contributes no hash. Content may
 *     still live at a keep ref.
 *   - `sourceRoot` not inside a git checkout → refs can't resolve →
 *     hard error (prune is a git-scoped operation).
 */

import path from "node:path";
import { hashContent, hashSourceFile } from "../sources.js";
import { readBlobsAtRefs, resolveGitTopLevel, resolveRef } from "./git.js";
import type { MemoryStore } from "./store.js";

export interface PruneOptions {
  /** Preserve refs. Must be non-empty. Each must resolve via git rev-parse. */
  keep: string[];
  /** If true, compute the plan but don't execute. */
  dryRun?: boolean;
}

export interface PruneResult {
  dry_run: boolean;
  rows_pruned: number;
  propositions_hard_deleted: number;
  entities_orphaned: number;
  /** Distinct refs in the preserve set (SHAs they resolved to). */
  preserve_set: Array<{ ref: string; sha: string }>;
}

interface RowMeta {
  proposition_id: string;
  file_path: string;
  content_hash: string;
}

/** `"?, ?, ?"` for `n=3`. Used when binding variadic `IN (...)` clauses. */
function sqlPlaceholders(n: number): string {
  return Array(n).fill("?").join(",");
}

export function prune(store: MemoryStore, options: PruneOptions): PruneResult {
  const { keep, dryRun = false } = options;
  if (!keep || keep.length === 0) {
    throw new Error(
      "memory prune requires at least one --keep <ref>. There is no default preserve set.",
    );
  }

  const sourceRoot = store.getSourceRoot();
  const db = store.getDb();

  const gitRoot = resolveGitTopLevel(sourceRoot);
  if (!gitRoot) {
    throw new Error(
      `memory prune requires a git checkout at the source root (${sourceRoot}). ` +
        `Refs can't be resolved outside a git repository.`,
    );
  }

  // --- 1. Resolve every preserve ref up front. Any failure aborts. ---
  const resolved: Array<{ ref: string; sha: string }> = [];
  const failures: string[] = [];
  for (const ref of keep) {
    const res = resolveRef(sourceRoot, ref);
    if (res.ok) resolved.push({ ref: res.ref, sha: res.sha });
    else failures.push(`${res.ref}: ${res.error}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Unresolvable --keep ref(s); prune aborted without touching the db:\n  - ${failures.join("\n  - ")}`,
    );
  }

  // --- 2. Load rows and pick out distinct file_paths. ---
  const rows = db
    .prepare("SELECT proposition_id, file_path, content_hash FROM proposition_sources")
    .all() as RowMeta[];

  if (rows.length === 0) {
    return {
      dry_run: dryRun,
      rows_pruned: 0,
      propositions_hard_deleted: 0,
      entities_orphaned: 0,
      preserve_set: resolved,
    };
  }

  const distinctPaths = [...new Set(rows.map((r) => r.file_path))];

  // --- 3. Build the "live hashes" set per file_path. ---
  // Disk first, then every tip of every preserve ref via one batched
  // cat-file. Each file_path maps to the set of content_hashes that
  // currently exist somewhere live for that path.
  const liveHashes = new Map<string, Set<string>>();
  for (const fp of distinctPaths) {
    const set = new Set<string>();
    const diskHash = hashSourceFile(path.resolve(sourceRoot, fp));
    if (diskHash !== null) set.add(diskHash);
    liveHashes.set(fp, set);
  }

  // cat-file wants paths relative to the git toplevel. The Freelance
  // source root may be a subdirectory of the repo, so file_path as
  // stored is relative to sourceRoot — translate once.
  const specs: string[] = [];
  const specToPath = new Map<string, string>();
  for (const { sha } of resolved) {
    for (const fp of distinctPaths) {
      const absPath = path.resolve(sourceRoot, fp);
      const repoPath = path.relative(gitRoot, absPath);
      // A source outside the git repo can't be read via cat-file;
      // skip and let disk hashing stand alone for that file.
      if (repoPath.startsWith("..") || path.isAbsolute(repoPath)) continue;
      // cat-file speaks forward-slash paths; normalize Windows separators.
      const spec = `${sha}:${repoPath.replace(/\\/g, "/")}`;
      specs.push(spec);
      specToPath.set(spec, fp);
    }
  }

  const blobs = readBlobsAtRefs(sourceRoot, specs);
  for (const [spec, bytes] of blobs) {
    if (bytes === null) continue;
    const fp = specToPath.get(spec);
    if (!fp) continue;
    const hash = hashContent(bytes.toString("utf-8"));
    liveHashes.get(fp)?.add(hash);
  }

  // --- 4. Identify victims. ---
  const victims: RowMeta[] = [];
  for (const row of rows) {
    const set = liveHashes.get(row.file_path);
    if (!set || !set.has(row.content_hash)) victims.push(row);
  }

  // --- 5. Derived counts (propositions + entities that fall out). ---
  const affectedPropIds = new Set(victims.map((v) => v.proposition_id));

  let hardDeletedPropIds: string[] = [];
  if (affectedPropIds.size > 0) {
    const affectedList = [...affectedPropIds];
    const remaining = db
      .prepare(
        `SELECT proposition_id, COUNT(*) as remaining FROM proposition_sources
         WHERE proposition_id IN (${sqlPlaceholders(affectedList.length)})
         GROUP BY proposition_id`,
      )
      .all(...affectedList) as Array<{ proposition_id: string; remaining: number }>;

    const victimCountByProp = new Map<string, number>();
    for (const v of victims) {
      victimCountByProp.set(v.proposition_id, (victimCountByProp.get(v.proposition_id) ?? 0) + 1);
    }
    hardDeletedPropIds = remaining
      .filter((r) => (victimCountByProp.get(r.proposition_id) ?? 0) >= r.remaining)
      .map((r) => r.proposition_id);
  }

  let entitiesOrphaned = 0;
  if (hardDeletedPropIds.length > 0) {
    const placeholders = sqlPlaceholders(hardDeletedPropIds.length);
    entitiesOrphaned = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM entities e
           WHERE EXISTS (
             SELECT 1 FROM about a
             WHERE a.entity_id = e.id AND a.proposition_id IN (${placeholders})
           )
           AND NOT EXISTS (
             SELECT 1 FROM about a
             WHERE a.entity_id = e.id AND a.proposition_id NOT IN (${placeholders})
           )`,
        )
        .get(...hardDeletedPropIds, ...hardDeletedPropIds) as { c: number }
    ).c;
  }

  const result: PruneResult = {
    dry_run: dryRun,
    rows_pruned: victims.length,
    propositions_hard_deleted: hardDeletedPropIds.length,
    entities_orphaned: entitiesOrphaned,
    preserve_set: resolved,
  };

  if (dryRun || victims.length === 0) return result;

  // --- 6. Execute. Atomically — partial prune is worse than no prune. ---
  // Sources first, then orphaned propositions. `about` cascades via FK
  // on proposition delete; FTS via the `propositions_ad` trigger.
  db.exec("BEGIN");
  try {
    const delSource = db.prepare(
      "DELETE FROM proposition_sources WHERE proposition_id = ? AND file_path = ?",
    );
    for (const v of victims) {
      delSource.run(v.proposition_id, v.file_path);
    }
    if (hardDeletedPropIds.length > 0) {
      db.prepare(
        `DELETE FROM propositions WHERE id IN (${sqlPlaceholders(hardDeletedPropIds.length)})`,
      ).run(...hardDeletedPropIds);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return result;
}

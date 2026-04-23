/**
 * MemoryStore — stateless, persistent knowledge graph.
 *
 * Every write goes through the `node:sqlite` layer; there is no in-memory
 * session state. Sources are attached per-proposition at emit time, so
 * staleness is computed per-proposition against the current filesystem.
 *
 * Per-domain helpers are pure free functions over a db handle:
 *  - ./entities.ts — entity lookup, resolution, kind reconciliation
 *  - ./enrichment.ts — read-side query + projection helpers
 *  - ./staleness.ts — provenance staleness checking
 *
 * MemoryStore is the orchestrator: holds the (lazy) db handle + source
 * root, exposes the public API, and threads the helpers together.
 */

import crypto from "node:crypto";
import path from "node:path";
import { EC, EngineError } from "../errors.js";
import { hashSourceFile } from "../sources.js";
import { countQuery, type Db, withTransaction } from "./db.js";
import {
  computeStatus,
  countNeighbors,
  countValidForEntity,
  enrichProposition,
  fetchEntitiesByProp,
  fetchSourcesByProp,
  getNeighbors,
} from "./enrichment.js";
import { findEntity, resolveEntity } from "./entities.js";
import { generateId, now } from "./ids.js";
import { type PruneOptions, type PruneResult, prune as pruneExternal } from "./prune.js";
import {
  createStalenessCache,
  getStalePropositionIds,
  notStaleExists,
  primeStaleFilter,
} from "./staleness.js";
import type {
  BrowseResult,
  BySourceResult,
  EmitProposition,
  EmitResult,
  EmitWarning,
  EntityInfo,
  EntityRow,
  InspectResult,
  MinimalProposition,
  PropositionInfo,
  PropositionRow,
  PropositionShape,
  RelatedResult,
  SearchResult,
  StatusResult,
} from "./types.js";

/**
 * Default page size + upper bound for paginated reads. Aligned with
 * `memory_browse` (and the broader token-economics guidance in issue
 * #86) so every paginated verb shares the same ceiling. Kept as module
 * constants so CLI and hook callers can reason about the cap without
 * re-deriving it.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_LIMIT;
  if (requested < 1) return 1;
  if (requested > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return Math.trunc(requested);
}

function clampOffset(requested: number | undefined): number {
  if (requested === undefined || requested < 0) return 0;
  return Math.trunc(requested);
}

/**
 * Hash proposition content for dedup. Normalizes superficial variance
 * that doesn't change the claim — case, whitespace runs, trailing
 * sentence punctuation — before hashing. Internal punctuation is
 * preserved (commas/colons can carry meaning). Each transform is binary:
 * two claims collide on hash only when their normalized forms are
 * byte-identical. No thresholds, no similarity scoring.
 *
 * Stricter than the `hashContent` used for source-file hashing — file
 * drift detection needs minimal normalization so a real edit isn't
 * masked.
 */
function hashPropContent(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+\s*$/u, "")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

export class MemoryStore {
  private _db: Db | undefined;
  private readonly dbFactory: () => Db;
  private sourceRoot: string;
  private closed = false;

  // Thunk form opens lazily on first `db` access. See
  // `docs/decisions.md` § "Memory database opens lazily on first access".
  constructor(db: Db | (() => Db), sourceRoot: string) {
    if (typeof db === "function") {
      this.dbFactory = db;
    } else {
      this._db = db;
      this.dbFactory = () => db;
    }
    this.sourceRoot = sourceRoot;
  }

  private get db(): Db {
    if (!this._db) this._db = this.dbFactory();
    return this._db;
  }

  // Thin delegation to the standalone `prune` function. The prune
  // implementation lives outside this class because content-reachability
  // needs git subprocesses (MemoryStore stays SQLite-only), but the
  // wrapper lets callers invoke it through the public surface so we
  // don't have to expose `getDb` / `getSourceRoot` escape hatches on
  // the class. Kept as a one-line method to keep the subprocess logic
  // off the MemoryStore type.
  prune(options: PruneOptions): PruneResult {
    return pruneExternal(this.db, this.sourceRoot, options);
  }

  // Idempotent — CLI paths that `process.exit` mid-command want to
  // close before exit, and the caller's `finally` also closes. Without
  // this guard, the second close hits an already-closed node:sqlite
  // handle and throws.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Only close if we actually opened. Close on a never-used lazy store
    // must be a no-op — otherwise a harmless `status` invocation would
    // trigger the open it was designed to avoid.
    if (this._db) this._db.close();
  }

  resetAll(): { deleted_propositions: number; deleted_entities: number } {
    const propCount = countQuery(this.db, "SELECT COUNT(*) FROM propositions");
    const entCount = countQuery(this.db, "SELECT COUNT(*) FROM entities");
    // Order matters: propositions before entities so the FK cascade
    // on `about` and `proposition_sources` runs before entities are
    // gone. FTS clears via the `propositions_ad` trigger.
    withTransaction(this.db, () => {
      this.db.exec("DELETE FROM propositions");
      this.db.exec("DELETE FROM entities");
    });
    return { deleted_propositions: propCount, deleted_entities: entCount };
  }

  /**
   * Validate a source file path against the source root. Returns the stored
   * (relative) path and the resolved absolute path. Throws
   * `SOURCE_OUTSIDE_ROOT` if the path escapes the source root.
   *
   * Shared by write paths (`emit`) and reads (`bySource`) so the
   * "user-supplied file path → stored path" contract lives in one place
   * and a request for `../../etc/passwd` becomes a structured error on
   * reads too, not a silent empty match.
   */
  private prepareSourcePath(filePath: string): {
    storedPath: string;
    resolvedPath: string;
  } {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.sourceRoot, filePath);

    const normalizedRoot = path.resolve(this.sourceRoot) + path.sep;
    const normalizedPath = path.resolve(resolvedPath);
    if (
      !normalizedPath.startsWith(normalizedRoot) &&
      normalizedPath !== path.resolve(this.sourceRoot)
    ) {
      throw new EngineError(
        `Source file is outside the source root: ${filePath}`,
        EC.SOURCE_OUTSIDE_ROOT,
      );
    }

    const storedPath = path.isAbsolute(filePath)
      ? path.relative(this.sourceRoot, filePath)
      : filePath;

    return { storedPath, resolvedPath };
  }

  emit(propositions: EmitProposition[]): EmitResult {
    const result: EmitResult = {
      created: 0,
      deduplicated: 0,
      entities_resolved: 0,
      entities_created: 0,
      propositions: [],
    };
    const warnings: EmitWarning[] = [];

    // DO NOTHING (not DO UPDATE) — if an existing row matches on
    // content_hash the insert becomes a no-op and returns no row. We
    // then SELECT the existing id separately. This keeps emit idempotent
    // under retry and keeps the FTS index untouched on dedup hits
    // (there's no AFTER UPDATE trigger to churn regardless).
    const upsertProp = this.db.prepare(
      `INSERT INTO propositions (id, content, content_hash, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING id`,
    );
    const selectExistingProp = this.db.prepare(
      "SELECT id FROM propositions WHERE content_hash = ?",
    );
    const insertAbout = this.db.prepare(
      "INSERT OR IGNORE INTO about (proposition_id, entity_id) VALUES (?, ?)",
    );
    const insertPropSource = this.db.prepare(
      "INSERT OR IGNORE INTO proposition_sources (proposition_id, file_path, content_hash) VALUES (?, ?, ?)",
    );

    // Caller expects every prop in the batch to have its full source
    // set on success — a missing-source-file or constraint throw
    // mid-loop must roll back, not leave half-attributed rows.
    withTransaction(this.db, () => {
      for (const prop of propositions) {
        const contentHash = hashPropContent(prop.content);
        const newId = generateId();
        const inserted = upsertProp.get(newId, prop.content, contentHash, now()) as
          | { id: string }
          | undefined;

        const propResult: EmitResult["propositions"][number] = {
          id: "",
          content: prop.content,
          status: "created",
          entities: [],
        };

        let propId: string;
        if (inserted) {
          propId = newId;
          propResult.status = "created";
          result.created++;
        } else {
          const existing = selectExistingProp.get(contentHash) as { id: string };
          propId = existing.id;
          propResult.status = "deduplicated";
          result.deduplicated++;
        }
        propResult.id = propId;

        // Per-proposition source attribution. Each source file is hashed fresh
        // at emit time; if the file can't be read, the emit fails for this prop.
        for (const sourcePath of prop.sources) {
          const { storedPath, resolvedPath } = this.prepareSourcePath(sourcePath);
          const hash = hashSourceFile(resolvedPath);
          if (hash === null) {
            throw new EngineError(
              `Cannot read source file "${sourcePath}" during emit.`,
              EC.SOURCE_FILE_UNREADABLE,
            );
          }
          insertPropSource.run(propId, storedPath, hash);
        }

        for (const entityName of prop.entities) {
          const kind = prop.entityKinds?.[entityName];
          const resolved = resolveEntity(this.db, entityName, kind, warnings);
          propResult.entities.push(resolved);
          insertAbout.run(propId, resolved.id);
          if (resolved.resolution === "created") {
            result.entities_created++;
          } else {
            result.entities_resolved++;
          }
        }

        result.propositions.push(propResult);
      }
    });

    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result;
  }

  browse(options?: {
    name?: string;
    kind?: string;
    limit?: number;
    offset?: number;
    includeOrphans?: boolean;
  }): BrowseResult {
    const cache = createStalenessCache();
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const includeOrphans = options?.includeOrphans ?? false;

    let where = "1=1";
    const whereParams: unknown[] = [];

    if (options?.name) {
      where += " AND LOWER(e.name) LIKE ?";
      whereParams.push(`%${options.name.toLowerCase()}%`);
    }
    if (options?.kind) {
      where += " AND e.kind = ?";
      whereParams.push(options.kind);
    }

    primeStaleFilter(this.db, this.sourceRoot, cache);
    const having = includeOrphans ? "" : "HAVING valid_count > 0";

    const selectExpr = `
      SELECT e.*,
        COUNT(a.proposition_id) as proposition_count,
        COUNT(CASE WHEN a.proposition_id IS NOT NULL AND ${notStaleExists("a.proposition_id")} THEN 1 END) as valid_count
      FROM entities e
      LEFT JOIN about a ON e.id = a.entity_id
      WHERE ${where}
      GROUP BY e.id
      ${having}`;

    const total = countQuery(this.db, `SELECT COUNT(*) FROM (${selectExpr})`, ...whereParams);

    const rows = this.db
      .prepare(`${selectExpr} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`)
      .all(...whereParams, limit, offset) as Array<
      EntityRow & { proposition_count: number; valid_count: number }
    >;

    const entities: EntityInfo[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      proposition_count: row.proposition_count,
      valid_proposition_count: row.valid_count,
    }));

    return { entities, total };
  }

  inspect(
    entityIdOrName: string,
    options?: { limit?: number; offset?: number; shape?: PropositionShape },
  ): InspectResult {
    const cache = createStalenessCache();
    const entity = findEntity(this.db, entityIdOrName);
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const shape: PropositionShape = options?.shape ?? "full";

    // Total is computed over the full matching set — independent of
    // limit/offset — so the caller can decide whether to page further.
    const total = countQuery(
      this.db,
      "SELECT COUNT(*) FROM propositions p JOIN about a ON p.id = a.proposition_id WHERE a.entity_id = ?",
      entity.id,
    );

    const propRows = this.db
      .prepare(
        `SELECT p.* FROM propositions p
         JOIN about a ON p.id = a.proposition_id
         WHERE a.entity_id = ?
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(entity.id, limit, offset) as PropositionRow[];

    // `valid_proposition_count` on the entity header reports the
    // entity-wide valid total (across the full, unpaginated set); the
    // paginated `propositions` list is just the current page.
    primeStaleFilter(this.db, this.sourceRoot, cache);
    const validCount = countValidForEntity(this.db, entity.id);
    const neighbors = getNeighbors(this.db, entity.id);

    if (shape === "minimal") {
      return {
        entity: {
          id: entity.id,
          name: entity.name,
          kind: entity.kind,
          proposition_count: total,
          valid_proposition_count: validCount,
        },
        propositions: propRows.map((p) => ({ id: p.id, content: p.content }) as MinimalProposition),
        total,
        neighbors,
      };
    }

    const sourcesByProp = fetchSourcesByProp(
      this.db,
      propRows.map((p) => p.id),
    );
    const propositions = propRows.map((p) =>
      enrichProposition(this.sourceRoot, cache, p, sourcesByProp.get(p.id) ?? []),
    );

    // Deduped source files across the entity's *full* proposition set
    // (not just the current page). Callers use this to size-check the
    // corpus footprint of the entity; restricting to the page would
    // make it a moving target per offset.
    const sourceRows = this.db
      .prepare(
        `SELECT DISTINCT ps.file_path
         FROM proposition_sources ps
         JOIN about a ON ps.proposition_id = a.proposition_id
         WHERE a.entity_id = ?
         ORDER BY ps.file_path`,
      )
      .all(entity.id) as Array<{ file_path: string }>;

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: total,
        valid_proposition_count: validCount,
      },
      propositions,
      total,
      neighbors,
      source_files: sourceRows.map((r) => r.file_path),
    };
  }

  bySource(
    filePath: string,
    options?: {
      limit?: number;
      offset?: number;
      shape?: PropositionShape;
      includeOrphans?: boolean;
    },
  ): BySourceResult {
    const cache = createStalenessCache();
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);
    const shape: PropositionShape = options?.shape ?? "full";
    const includeOrphans = options?.includeOrphans ?? false;

    const { storedPath } = this.prepareSourcePath(filePath);

    // Mirror `browse`'s staleness filter: propositions whose declared
    // source bytes don't match disk/any live ref are hidden by default.
    // Caller opts in with includeOrphans to see orphans during audits.
    primeStaleFilter(this.db, this.sourceRoot, cache);
    const notStaleJoin = includeOrphans ? "" : ` AND ${notStaleExists("p.id")}`;

    const total = countQuery(
      this.db,
      `SELECT COUNT(DISTINCT p.id) FROM propositions p
       JOIN proposition_sources ps ON p.id = ps.proposition_id
       WHERE ps.file_path = ?${notStaleJoin}`,
      storedPath,
    );

    const propRows = this.db
      .prepare(
        `SELECT DISTINCT p.* FROM propositions p
         JOIN proposition_sources ps ON p.id = ps.proposition_id
         WHERE ps.file_path = ?${notStaleJoin}
         ORDER BY p.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(storedPath, limit, offset) as PropositionRow[];

    let propositions: MinimalProposition[] | PropositionInfo[];
    if (shape === "minimal") {
      propositions = propRows.map((p) => ({ id: p.id, content: p.content }) as MinimalProposition);
    } else {
      const sourcesByProp = fetchSourcesByProp(
        this.db,
        propRows.map((p) => p.id),
      );
      propositions = propRows.map((p) =>
        enrichProposition(this.sourceRoot, cache, p, sourcesByProp.get(p.id) ?? []),
      );
    }

    return {
      file_path: storedPath,
      propositions,
      total,
    };
  }

  search(query: string, options?: { limit?: number }): SearchResult {
    const cache = createStalenessCache();
    const limit = options?.limit ?? 20;

    // Sanitize query: replace bare hyphens with spaces so FTS5 doesn't
    // interpret them as the NOT operator (e.g. "query-driven" → "query driven")
    // Preserve explicitly quoted phrases and prefix wildcards.
    const sanitized = query.replace(/(?<!["])\b(\w+)-(\w+)\b(?!["])/g, "$1 $2");

    const rows = this.db
      .prepare(
        `SELECT p.* FROM propositions p JOIN propositions_fts fts ON p.rowid = fts.rowid WHERE propositions_fts MATCH ? ORDER BY fts.rank LIMIT ?`,
      )
      .all(sanitized, limit) as PropositionRow[];

    const propIds = rows.map((p) => p.id);
    const sourcesByProp = fetchSourcesByProp(this.db, propIds);
    const entitiesByProp = fetchEntitiesByProp(this.db, propIds);
    const propositions = rows.map((p) => ({
      ...enrichProposition(this.sourceRoot, cache, p, sourcesByProp.get(p.id) ?? []),
      entities: entitiesByProp.get(p.id) ?? [],
    }));

    return { query, propositions };
  }

  status(): StatusResult {
    // Skips `primeStaleFilter`: computeStatus reads the Set as a JS
    // value and never joins against STALE_PROP_IDS_TABLE.
    const cache = createStalenessCache();
    const stalePropIds = getStalePropositionIds(this.db, this.sourceRoot, cache);
    return computeStatus(this.db, stalePropIds);
  }

  related(entityIdOrName: string, options?: { limit?: number; offset?: number }): RelatedResult {
    const cache = createStalenessCache();
    const entity = findEntity(this.db, entityIdOrName);
    const limit = clampLimit(options?.limit);
    const offset = clampOffset(options?.offset);

    primeStaleFilter(this.db, this.sourceRoot, cache);
    const validCount = countValidForEntity(this.db, entity.id);
    const totalCount = countQuery(
      this.db,
      "SELECT COUNT(*) FROM about WHERE entity_id = ?",
      entity.id,
    );

    const total = countNeighbors(this.db, entity.id);
    const rows = getNeighbors(this.db, entity.id, {
      withSample: true,
      limit,
      offset,
    });
    const neighbors = rows.map((r) => ({ ...r, sample: r.sample ?? "" }));

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        proposition_count: totalCount,
        valid_proposition_count: validCount,
      },
      neighbors,
      total,
    };
  }
}

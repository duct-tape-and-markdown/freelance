/**
 * Types for the Freelance Memory system.
 */

// --- Database row types ---

export interface EntityRow {
  id: string;
  name: string;
  kind: string | null;
  created_at: string;
}

export interface PropositionRow {
  id: string;
  content: string;
  content_hash: string;
  collection: string;
  created_at: string;
}

// --- API types ---

export interface EmitProposition {
  content: string;
  entities: string[];
  sources: string[];
  entityKinds?: Record<string, string>;
}

export interface EmitResult {
  created: number;
  deduplicated: number;
  entities_resolved: number;
  entities_created: number;
  propositions: Array<{
    id: string;
    content: string;
    status: "created" | "deduplicated";
    entities: Array<{ id: string; name: string; resolution: "exact" | "normalized" | "created" }>;
  }>;
  /**
   * Non-fatal observations surfaced during the emit. Not reconciled by
   * the store — the caller decides what to do (re-emit with a correction,
   * mark the new proposition stale, ignore, escalate to a user).
   */
  warnings?: EmitWarning[];
}

/**
 * An `entity_kind_conflict` is emitted when a proposition cites an entity
 * with a `kind` that differs from the entity's existing stored kind.
 * Before this change the store silently kept the first-recorded kind; now
 * the second emit's kind is still discarded (first-wins), but the
 * conflict is reported so the caller can reconcile explicitly.
 */
export type EmitWarning = {
  type: "entity_kind_conflict";
  entity: string;
  existingKind: string;
  providedKind: string;
};

export interface EntityInfo {
  id: string;
  name: string;
  kind: string | null;
  proposition_count: number;
  valid_proposition_count: number;
}

export interface PropositionInfo {
  id: string;
  content: string;
  created_at: string;
  valid: boolean;
  collection: string;
  source_files: Array<{ path: string; hash: string; current_match: boolean }>;
}

/**
 * Trimmed proposition projection. Used on warm-path reads
 * (`memory_by_source` onEnter hook, opt-in from the CLI) where the caller
 * only needs the claim text — the richer `PropositionInfo` payload
 * (per-file hashes, mtimes, validity flags, source arrays, `created_at`)
 * is ~5× per-row cost for data typically unused in that context. See
 * issue #87 for the asymmetry this resolves.
 */
export interface MinimalProposition {
  id: string;
  content: string;
}

/**
 * Projection shape for reads returning propositions. "full" returns the
 * full `PropositionInfo` (default on CLI); "minimal" returns only
 * `{ id, content }` (default on onEnter hooks). The store picks the
 * cheaper SQL path when minimal is requested (no per-proposition source
 * join + staleness check).
 */
export type PropositionShape = "minimal" | "full";

export interface NeighborEntity {
  id: string;
  name: string;
  kind: string | null;
  shared_propositions: number;
  valid_shared_propositions: number;
}

export interface InspectResult {
  entity: EntityInfo;
  propositions: PropositionInfo[] | MinimalProposition[];
  /** Total matching propositions for this entity, independent of limit/offset. */
  total: number;
  neighbors: NeighborEntity[];
  /**
   * Deduped list of source file paths referenced by any of this entity's
   * propositions. Only present under `shape: "full"` — `shape: "minimal"`
   * skips the source join that would populate it.
   */
  source_files?: string[];
}

export interface RelatedResult {
  entity: EntityInfo;
  neighbors: Array<NeighborEntity & { sample: string }>;
  /** Total matching neighbors for this entity, independent of limit/offset. */
  total: number;
}

export interface BrowseResult {
  entities: EntityInfo[];
  total: number;
}

export interface BySourceResult {
  file_path: string;
  propositions: PropositionInfo[] | MinimalProposition[];
  /** Total propositions derived from this file, independent of limit/offset. */
  total: number;
}

export interface SearchResult {
  query: string;
  propositions: Array<
    PropositionInfo & {
      entities: Array<{ id: string; name: string; kind: string | null }>;
    }
  >;
}

export interface StatusResult {
  total_propositions: number;
  valid_propositions: number;
  stale_propositions: number;
  total_entities: number;
}

export interface MemoryConfig {
  enabled: boolean;
  db: string;
}

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
}

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

export interface NeighborEntity {
  id: string;
  name: string;
  kind: string | null;
  shared_propositions: number;
  valid_shared_propositions: number;
}

export interface InspectResult {
  entity: EntityInfo;
  propositions: PropositionInfo[];
  neighbors: NeighborEntity[];
  /** Deduped list of source file paths referenced by any of this entity's propositions. */
  source_files: string[];
}

export interface RelatedResult {
  entity: EntityInfo;
  neighbors: Array<NeighborEntity & { sample: string }>;
}

export interface BrowseResult {
  entities: EntityInfo[];
  total: number;
}

export interface BySourceResult {
  file_path: string;
  propositions: PropositionInfo[];
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

export interface RegisterSourceResult {
  file_path: string;
  content_hash: string;
  status: "registered" | "skipped";
}

export interface CollectionConfig {
  name: string;
  description: string;
  paths: string[];
}

export interface MemoryConfig {
  enabled: boolean;
  db: string;
  collections?: CollectionConfig[];
}

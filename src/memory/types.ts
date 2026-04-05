/**
 * Types for the Freelance Memory system.
 *
 * Persistent, provenance-aware knowledge graph backed by SQLite.
 */

// --- Database row types ---

export interface EntityRow {
  id: string;
  name: string;
  kind: string | null;
  scope: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
}

export interface SessionFileRow {
  session_id: string;
  file_path: string;
  content_hash: string;
}

export interface PropositionRow {
  id: string;
  content: string;
  content_hash: string;
  session_id: string;
  created_at: string;
}

export interface AboutRow {
  proposition_id: string;
  entity_id: string;
  role: string | null;
}

export interface RelatesToRow {
  from_id: string;
  to_id: string;
  relationship_type: string | null;
}

// --- API types (tool inputs/outputs) ---

export interface EmitProposition {
  content: string;
  entities: string[];
  relatesTo?: string[];
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
  scope: string | null;
  summary: string | null;
  proposition_count: number;
  valid_proposition_count: number;
}

export interface PropositionInfo {
  id: string;
  content: string;
  session_id: string;
  created_at: string;
  valid: boolean;
  source_files: Array<{ path: string; hash: string; current_match: boolean }>;
}

export interface InspectResult {
  entity: EntityInfo;
  propositions: PropositionInfo[];
  related_entities: Array<{ id: string; name: string; shared_propositions: number }>;
}

export interface BrowseResult {
  entities: EntityInfo[];
  total: number;
}

export interface RelationshipsResult {
  entity_a: { id: string; name: string };
  entity_b: { id: string; name: string };
  shared_propositions: PropositionInfo[];
}

export interface BySourceResult {
  file_path: string;
  propositions: PropositionInfo[];
}

export interface StatusResult {
  total_propositions: number;
  valid_propositions: number;
  stale_propositions: number;
  total_entities: number;
  total_sessions: number;
  active_session: string | null;
}

export interface GapEntry {
  content: string;
  source: string;
  proposition_id: string;
}

export interface MatchEntry {
  content: string;
  plan_source: string;
  impl_source: string;
}

export interface GapsResult {
  unimplemented: GapEntry[];
  unplanned: GapEntry[];
  matched: MatchEntry[];
}

export interface SessionInfo {
  id: string;
  started_at: string;
  ended_at: string | null;
  file_count: number;
  proposition_count: number;
}

export interface BeginResult {
  session_id: string;
  entities: number;
  valid_propositions: number;
  stale: number;
}

export interface EndResult {
  session_id: string;
  propositions_emitted: number;
  entities_referenced: number;
  files_registered: number;
  duration_ms: number;
}

export interface RegisterSourceResult {
  file_path: string;
  content_hash: string;
  status: "registered" | "updated";
}

export interface MemoryConfig {
  enabled: boolean;
  db: string;
  source?: {
    roots?: string[];
    patterns?: string[];
    ignore?: string[];
  };
}

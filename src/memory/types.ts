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

// --- API types ---

export interface EmitProposition {
  content: string;
  entities: string[];
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

export interface SourceSession {
  id: string;
  files: string[];
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
  source_sessions: SourceSession[];
}

export interface BrowseResult {
  entities: EntityInfo[];
  total: number;
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

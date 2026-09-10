import type { SearchResult } from '../types.js';

export type RetrievalMode = 'hybrid' | 'live';
export type ExperimentStatus = 'running' | 'success' | 'failed' | 'inconclusive';
export type AssertionValue = string | number | boolean | null;
export type CatalogAssetKind = 'project' | 'plan' | 'task' | 'method' | 'experiment'
  | 'attempt' | 'arm' | 'measurement' | 'byte_ledger' | 'artifact' | 'document'
  | 'decision' | 'session';
export type CatalogWriteOperation = 'create' | 'patch' | 'append_evidence' | 'relocate' | 'correct';
export type CatalogAccessTier = 'hot' | 'warm' | 'cold';
export type ProjectDocumentRole = 'experiment_record' | 'result' | 'method' | 'log'
  | 'paper' | 'plan' | 'config' | 'source' | 'report' | 'other';

export interface ProjectRecord {
  project_id: string;
  name: string;
  status?: 'active' | 'forgotten';
  forgot_at?: string;
  created_at: string;
  updated_at: string;
  active_plan_revision_id?: string;
  current_plan_asset_id?: string;
  current_plan_revision_id?: string;
  active_source_snapshot_id?: string;
  active_code_snapshot_id?: string;
  active_graph_projection_id?: string;
  graph_dirty_at?: string;
  active_graph_dirty_at?: string;
  catalog_generation?: number;
  purpose?: string;
  user_constraints?: string[];
  protected_parent_ids?: string[];
}

export interface ProjectForgetPreview {
  project_id: string;
  name: string;
  documents: number;
  source_entries: number;
  records: number;
  sessions: number;
  confirm_token: string;
}

export interface RecordForgetPreview {
  project_id: string;
  target_id: string;
  kind: 'assertion';
  evidence: number;
  confirm_token: string;
}

export interface MemorySessionRecord {
  memory_handle: string;
  project_id: string;
  host_session_id?: string;
  continuity: 'request' | 'host';
  current_intent_revision_id?: string;
  created_at: string;
  updated_at: string;
}

export interface IntentRevisionRecord {
  intent_revision_id: string;
  memory_handle: string;
  project_id: string;
  revision: number;
  intent: string;
  source: 'query' | 'explicit' | 'host';
  status: 'provisional' | 'confirmed';
  created_at: string;
}

export interface PlanRevisionRecord {
  plan_revision_id: string;
  project_id: string;
  revision: number;
  title: string;
  body: string;
  change_reason?: string;
  parent_revision_id?: string;
  based_on_experiment_id?: string;
  effective_at?: string;
  recorded_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  created_at: string;
}

export interface ExperimentRunRecord {
  experiment_id: string;
  project_id: string;
  plan_revision_id: string;
  name: string;
  hypothesis: string;
  body?: string;
  status: ExperimentStatus;
  summary?: string;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts?: string[];
  effective_at?: string;
  recorded_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  started_at: string;
  finished_at?: string;
}

export interface DecisionRecord {
  decision_id: string;
  project_id: string;
  plan_revision_id?: string;
  experiment_id?: string;
  title: string;
  summary: string;
  body?: string;
  effective_at?: string;
  recorded_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  created_at: string;
}

export interface CatalogAssetRecord {
  asset_id: string;
  project_id: string;
  kind: CatalogAssetKind;
  status: 'active' | 'forgotten' | 'merged';
  current_revision: number;
  current_revision_id: string;
  aliases: string[];
  protected: boolean;
  access_tier: CatalogAccessTier;
  created_at: string;
  updated_at: string;
}

export interface ArtifactReference {
  artifact_id: string;
  path?: string;
  member?: string;
  size?: number;
  media_type?: string;
  content_hash?: string;
  role?: string;
  location?: string;
  observed_at?: string;
  available?: boolean;
  verification?: 'declared' | 'present' | 'hash_verified' | 'restore_tested' | 'replayed';
}

export interface CatalogRevisionRecord {
  revision_id: string;
  asset_id: string;
  project_id: string;
  kind: CatalogAssetKind;
  revision: number;
  operation: CatalogWriteOperation;
  parent_revision_id?: string;
  body_blob_id?: string;
  body_bytes: number;
  fields: Record<string, unknown>;
  evidence_ids: string[];
  artifact_references: ArtifactReference[];
  artifact_manifest_id?: string;
  artifact_reference_count?: number;
  changed_fields: string[];
  missing_fields: string[];
  effective_at?: string;
  recorded_at: string;
  source_sequence?: number;
  source_reference?: string;
  correction_reason?: string;
}

export interface CatalogRecordReadback {
  asset: CatalogAssetRecord;
  revision: CatalogRevisionRecord;
  body?: string;
  body_span?: { start: number; end: number; total_bytes: number };
  next_body_offset?: number;
  artifact_span?: { start: number; end: number; total: number };
  next_artifact_offset?: number;
}

export interface DurableWriteReceipt {
  project_id: string;
  record_id: string;
  revision: number;
  revision_id: string;
  operation_id: string;
  idempotency_key: string;
  durability: 'committed';
  changed: boolean;
  changed_fields: string[];
  previous_revision?: number;
  previous_revision_id?: string;
  stored_fields: string[];
  body_bytes_received: number;
  body_bytes_stored: number;
  artifact_references_received: number;
  artifact_references_stored: number;
  omitted_fields: string[];
  truncated: false;
  index_state: 'not_required' | 'queued' | 'current';
  index_job_id?: string;
  readback: { action: 'get'; record_id: string };
  request_hash: string;
  committed_at: string;
}

export interface CatalogTimelineEvent {
  event_id: string;
  project_id: string;
  asset_id: string;
  revision_id: string;
  revision: number;
  kind: CatalogAssetKind;
  operation: CatalogWriteOperation;
  effective_at?: string;
  recorded_at: string;
  source_sequence?: number;
  changed_fields: string[];
  reason?: string;
}

export interface OntologyTermRecord {
  term_id: string;
  project_id?: string;
  kind: 'entity_type' | 'relation';
  name: string;
  aliases: string[];
  version: number;
  status: 'active' | 'superseded';
  supersedes_term_id?: string;
  created_at: string;
}

export interface EvidenceRecord {
  evidence_id: string;
  project_id: string;
  source_type: 'document' | 'source' | 'experiment' | 'decision' | 'manual';
  source_id: string;
  locator?: string;
  quote?: string;
  created_at: string;
}

export interface AssertionRecord {
  assertion_id: string;
  project_id: string;
  subject: string;
  predicate: string;
  object?: string;
  value?: AssertionValue;
  status: 'suggested' | 'confirmed' | 'rejected' | 'superseded' | 'forgotten';
  forgotten_from_status?: 'suggested' | 'confirmed';
  forgot_at?: string;
  source: 'deterministic' | 'sidecar' | 'explicit';
  confidence?: number;
  evidence_ids: string[];
  ontology_version: number;
  valid_from?: string;
  valid_to?: string;
  recorded_at: string;
  recorded_until?: string;
  supersedes_assertion_id?: string;
}

export interface AssertionCorrectionRecord {
  correction_id: string;
  project_id: string;
  target_assertion_id: string;
  replacement_assertion_id: string;
  reason: string;
  created_at: string;
}

export type EntityStatus = 'suggested' | 'confirmed' | 'merged';

export interface EntityRecord {
  entity_id: string;
  project_id: string;
  kind: string;
  canonical_name: string;
  normalized_name: string;
  status: EntityStatus;
  merged_into_entity_id?: string;
  created_at: string;
  updated_at: string;
}

export interface EntityAliasRecord {
  alias_id: string;
  project_id: string;
  entity_id: string;
  alias: string;
  normalized_alias: string;
  source: 'deterministic' | 'sidecar' | 'explicit';
  confidence: number;
  status: 'active' | 'moved';
  moved_to_alias_id?: string;
  created_at: string;
  ended_at?: string;
}

export interface EntityOperationRecord {
  operation_id: string;
  project_id: string;
  kind: 'merge' | 'split';
  source_entity_ids: string[];
  target_entity_id: string;
  alias_ids: string[];
  reason: string;
  created_at: string;
}

export interface EntityLinkCandidate {
  entity: EntityRecord;
  match: 'exact' | 'alias' | 'candidate';
  score: number;
}

export interface GraphNodeRecord {
  node_id: string;
  project_id: string;
  kind: 'project' | 'root' | 'directory' | 'source' | 'document' | 'plan'
    | 'task' | 'method' | 'experiment' | 'attempt' | 'arm' | 'measurement' | 'byte_ledger'
    | 'artifact' | 'decision' | 'session' | 'intent' | 'entity' | 'assertion' | 'symbol'
    | 'ontology' | 'schema' | 'identity' | 'evidence' | 'snapshot' | 'catalog_asset';
  label: string;
  text?: string;
  url?: string;
  source_id?: string;
  record_id?: string;
  revision_id?: string;
}

export interface GraphEdgeRecord {
  edge_id: string;
  project_id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  evidence_ids?: string[];
  qualifiers?: Record<string, string | number | boolean | null>;
  effective_at?: string;
  recorded_at?: string;
}

export interface GraphProjection {
  projection_id: string;
  schema_version: 'graph-v3';
  source_hash: string;
  source_versions: Record<string, string>;
  project_ids: string[];
  nodes: GraphNodeRecord[];
  edges: GraphEdgeRecord[];
}

export interface GraphAnalysis {
  engine: 'graphology' | 'neo4j-gds' | 'surrealdb';
  node_count: number;
  edge_count: number;
  component_count?: number;
  strongly_connected_component_count?: number;
  community_count?: number;
  pagerank?: Record<string, number>;
  community?: Record<string, number>;
  personalized_pagerank?: Record<string, number>;
  path?: string[];
  elapsed_ms: number;
}

export interface GraphArtifact {
  projection: GraphProjection;
  analysis: GraphAnalysis;
}

export interface KnowledgeJobSummary {
  job_id: string;
  status: KnowledgeJobStatus;
  attempts: number;
}

export type KnowledgeJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface KnowledgeJobRecord {
  job_id: string;
  job_key: string;
  project_id: string;
  kind: 'rebuild' | 'schema_link' | 'graph_projection' | 'retrieval_index';
  status: KnowledgeJobStatus;
  source_hash: string;
  schema_version: string;
  algorithm_version: string;
  affected_source_ids: string[];
  attempts: number;
  revision?: number;
  stage?: string;
  completed_items?: number;
  total_items?: number;
  result_digest?: string;
  result_counts?: Record<string, number>;
  error?: string;
  cancel_requested_at?: string;
  cancel_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  plans: PlanRevisionRecord[];
  experiments: ExperimentRunRecord[];
  decisions: DecisionRecord[];
  assertion_count: number;
  correction_count: number;
  entity_count: number;
  entity_operation_count: number;
  job_counts: Record<KnowledgeJobStatus, number>;
  session_count: number;
  search_event_count: number;
  document_count: number;
  citation_observation_count: number;
  source_entry_count: number;
  active_source_snapshot?: ProjectSourceSnapshot;
}

export interface ProjectSourceSnapshot {
  snapshot_id: string;
  project_id: string;
  inventory_digest: string;
  policy: 'structured';
  status: 'indexing' | 'active';
  file_count: number;
  collection_count: number;
  searchable_file_count: number;
  unique_body_count: number;
  sensitive_file_count: number;
  unreadable_file_count: number;
  total_bytes: number;
  kinds: Record<string, number>;
  root_labels: string[];
  roots: Array<{
    label: string;
    path: string;
    role?: ProjectDocumentRole;
    manifest?: Array<{ path: string; role: ProjectDocumentRole; aliases?: string[] }>;
  }>;
  git_root?: string;
  git?: {
    branch: string;
    head: string;
    dirty: boolean;
    changed_files: number;
  };
  created_at: string;
  activated_at?: string;
  parent_snapshot_id?: string;
  added_count?: number;
  modified_count?: number;
  removed_count?: number;
}

export interface ProjectSourceEntryRecord {
  entry_id: string;
  project_id: string;
  root: string;
  path: string;
  kind: string;
  entry_type: 'file' | 'collection';
  searchable: boolean;
  size: number;
  modified_ms: number;
  tracked: boolean;
  sensitive: boolean;
  unreadable?: boolean;
  content_hash?: string;
  experiment_key?: string;
  role?: ProjectDocumentRole;
  aliases?: string[];
  historical_locations?: string[];
  moved_from_entry_ids?: string[];
  updated_snapshot_id?: string;
}

export interface SourceRecordReadback {
  source: true;
  entry: ProjectSourceEntryRecord;
  body?: string;
  body_span?: { start: number; end: number; total_bytes: number };
  next_body_offset?: number;
}

export interface DocumentRecordReadback {
  document: true;
  record: ProjectDocumentRecord;
  body?: string;
  body_span?: { start: number; end: number; total_bytes: number };
  next_body_offset?: number;
}

export interface ProjectDocumentRecord {
  project_id: string;
  document_id: string;
  state: 'lexical_active' | 'metadata_archive';
  title: string;
  url: string;
  text?: string;
  scholar_id?: string;
}

export interface ProjectDocumentChunkRecord {
  document_id: string;
  chunk_index: number;
  title: string;
  url: string;
  text: string;
  content_hash: string;
}

export interface CodeSymbolRecord {
  symbol_id: string;
  project_id: string;
  source_entry_id: string;
  language: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'struct';
  name: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface CodeRelationRecord {
  relation_id: string;
  project_id: string;
  source_entry_id: string;
  source_symbol_id?: string;
  target_symbol_id?: string;
  target_name: string;
  kind: 'imports' | 'calls' | 'extends';
  line: number;
  column: number;
  confidence: number;
}

export interface ProjectIndexResult {
  project_id: string;
  snapshot_id: string;
  inventory_digest: string;
  policy: 'structured';
  file_count: number;
  collection_count: number;
  searchable_file_count: number;
  unique_body_count: number;
  sensitive_file_count: number;
  unreadable_file_count: number;
  total_bytes: number;
  git?: ProjectSourceSnapshot['git'];
  reused: boolean;
  added_count: number;
  modified_count: number;
  removed_count: number;
  job_id: string;
  job_status: KnowledgeJobStatus;
  summary: string;
}

export interface LocalSearchHit extends SearchResult {
  document_id: string;
  record_id?: string;
  revision_id?: string;
  body_handle?: string;
  source_span?: { start: number; end: number };
  index_freshness?: 'current' | 'stale';
  content: string;
  score: number;
  project_ids: string[];
  source_family: 'document' | 'code' | 'graph';
  retrieval_family?: 'exact' | 'bm25' | 'vector' | 'graph';
  retrieval_families?: Array<'exact' | 'bm25' | 'vector' | 'graph'>;
  kind?: string;
  role?: ProjectDocumentRole;
  recorded_at?: string;
}

export interface ResearchSearchFilters {
  source_families?: Array<'document' | 'code' | 'graph'>;
  retrieval_lanes?: Array<'exact' | 'bm25' | 'vector' | 'graph'>;
  kinds?: string[];
  roles?: ProjectDocumentRole[];
  recorded_after?: string;
  recorded_before?: string;
}

export interface LocalSearchFamilies {
  exact: LocalSearchHit[];
  bm25: LocalSearchHit[];
  vector: LocalSearchHit[];
  graph: LocalSearchHit[];
  degraded_lanes: Array<NonNullable<LocalSearchHit['retrieval_family']>>;
}

export interface RetrievalIndexItem {
  item_id: string;
  project_id: string;
  source_family: 'document' | 'code';
  source_id: string;
  title: string;
  url: string;
  content_hash: string;
  exact_terms: string[];
  text: string;
  span_start?: number;
  span_end?: number;
  role?: ProjectDocumentRole;
}

export interface ResearchReceipt {
  project_id: string;
  memory_handle?: string;
  session_intent?: string;
  stored: number;
  rag_active: number;
  rag_inactive: number;
  excluded: number;
  summary: string;
}

export interface SearchEventObservation {
  document_id: string;
  title?: string;
  summary: string;
}

export interface SearchEventRecord {
  search_event_id: string;
  project_id: string;
  tool: 'search' | 'search_parallel' | 'scholar_search' | 'extract';
  query?: string;
  queries?: string[];
  document_ids: string[];
  observations: SearchEventObservation[];
  observed_at: string;
}

export interface PriorResearchSearch {
  query: string;
  relation: 'same' | 'related' | 'recent';
  searched_at: string;
  results: number;
  surface?: string;
}

export interface ResearchSearchContext {
  prior_searches: PriorResearchSearch[];
}

export interface CaptureResult {
  title: string;
  url: string;
  description?: string;
  content?: string;
  snippet?: string;
  is_pdf?: boolean;
  page_count?: number;
  extraction_quality?: string;
  authors?: string;
  publication?: string;
  published_at?: string;
  year?: number;
  doi?: string;
  keywords?: string[];
  canonical_url?: string;
  language?: string;
  subject?: string;
  creator?: string;
  producer?: string;
  created_at?: string;
  modified_at?: string;
  cited_by_count?: number;
  scholar_id?: string;
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { fenceUntrustedContent } from '../response.js';
import { MAX_RESEARCH_CAPTURE_CHARS } from '../searchLimits.js';
import { VERSION } from '../version.js';
import type {
  ArtifactReference, CatalogAccessTier, CatalogAssetKind, CatalogRecordReadback, CatalogTimelineEvent,
  CatalogWriteOperation, DurableWriteReceipt,
  AssertionCorrectionRecord, AssertionRecord, AssertionValue, CaptureResult, DecisionRecord, DocumentRecordReadback,
  EntityAliasRecord, EntityLinkCandidate, EntityOperationRecord, EntityRecord, EvidenceRecord,
  ExperimentRunRecord, ExperimentStatus, GraphAnalysis, GraphArtifact, GraphProjection,
  IntentRevisionRecord,
  KnowledgeJobRecord, KnowledgeJobStatus, KnowledgeJobSummary, LocalSearchFamilies, LocalSearchHit,
  MemorySessionRecord,
  OntologyTermRecord, PlanRevisionRecord, ProjectDetail, ProjectIndexResult,
  ProjectForgetPreview, ProjectRecord, RecordForgetPreview, ResearchReceipt, RetrievalIndexItem,
  ResearchSearchContext, ResearchSearchFilters, SearchEventRecord, SourceRecordReadback,
} from './contracts.js';
import { runCodeStructureBatchStream, type CodeSourceInput } from './codeStructure.js';
import { cosineSimilarity, LocalEmbeddingModel, type EmbeddingProvider } from './dense.js';
import { aliasId, entityId, normalizeEntityName, rankEntityCandidates } from './entities.js';
import { buildGraphProjection, type ProjectGraphSource } from './graphProjection.js';
import {
  graphSeedNodes, isRetrievalGraphEdge, rankGraphProjection, runGraphSidecar,
} from './graphSidecar.js';
import { exportInteractiveGraphVisualization } from './interactiveVisualization.js';
import { searchableByPolicy } from './inventory.js';
import {
  decideRepository, GitHubClient, parseGitHubRepositoryUrl, selectedRepositoryPaths,
  type RepositoryClient, type RepositoryDecision, type RepositoryReadMode,
} from './github.js';
import {
  inventoryProject, inventoryProjectIncremental,
  type ProjectPathChange, type ProjectRootInput,
} from './projectInventory.js';
import { ResearchStore, type CodeSourceManifestEntry } from './store.js';
import {
  exportGraphVisualization, exportNeo4jVisualization,
  type GraphVisualizationFormat, type GraphVisualizationView,
} from './visualization.js';

export interface ResearchServiceOptions {
  enabled: boolean;
  root: string;
  endpoint?: string;
  databaseNamespace?: string;
  databaseName?: string;
  vectorModel?: string;
  vectorLowMemory?: boolean;
  vectorThreads?: number;
  vectorBackend?: 'hnsw' | 'exhaustive' | 'compact';
  embeddingProvider?: EmbeddingProvider;
  repositoryAuto?: boolean;
  repositoryMaxSourceBytes?: number;
  repositoryMaxSourceFiles?: number;
  repositoryClient?: RepositoryClient;
  queryTimeoutMs?: number;
  graphCacheMaxBytes?: number;
}

export interface ResearchServiceStatus {
  enabled: boolean;
  state: string;
  root: string;
  vector: 'off' | 'on';
  external_sync: 'off';
  database_open: boolean;
  background_jobs: number;
  repository_jobs: number;
  scheduled_graph_jobs: number;
  graph_projection_cache: number;
  graph_artifact_cache: number;
  graph_cache_bytes: number;
}

export interface ResearchPassiveStatus extends ResearchServiceStatus {
  passive: true;
  observed_at: string;
  process: {
    process_class: 'in_process' | 'research_broker';
    pid: number;
    parent_pid: number;
    uptime_ms: number;
    rss_bytes: number;
    peak_rss_bytes: number;
    private_bytes: null;
    heap_total_bytes: number;
    heap_used_bytes: number;
    external_bytes: number;
    array_buffers_bytes: number;
  };
  runtime: {
    google_surf_mcp: string;
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    surrealdb_node: string | null;
    surrealdb_engine: string | null;
  };
  capabilities: {
    persistent_store: 'surrealdb_rocksdb' | 'surrealdb_remote';
    remote_endpoint?: string;
    vector_index: 'hnsw' | 'exhaustive' | 'compact';
    vector_dimensions: number;
    passive_health_opens_database: false;
  };
}

let surrealRuntimeVersions: Pick<ResearchPassiveStatus['runtime'], 'surrealdb_node' | 'surrealdb_engine'> | undefined;

function readSurrealRuntimeVersions(): Pick<ResearchPassiveStatus['runtime'], 'surrealdb_node' | 'surrealdb_engine'> {
  if (surrealRuntimeVersions) return surrealRuntimeVersions;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../node_modules/@surrealdb/node/package.json') as {
      version?: string;
      surreal?: string;
    };
    surrealRuntimeVersions = {
      surrealdb_node: pkg.version ?? null,
      surrealdb_engine: pkg.surreal ?? null,
    };
  } catch {
    surrealRuntimeVersions = { surrealdb_node: null, surrealdb_engine: null };
  }
  return surrealRuntimeVersions;
}

interface CaptureInput {
  tool: 'search' | 'search_parallel' | 'scholar_search' | 'extract';
  project_id?: string;
  memory_handle?: string;
  session_id?: string;
  session_intent?: string;
  query?: string;
  queries?: string[];
  payload: Record<string, unknown>;
}

interface RepositoryCandidate {
  title: string;
  url: string;
  description?: string;
  content?: string;
  extraction_quality?: string;
  [key: string]: unknown;
}

interface DecisionInput {
  project_id: string;
  title: string;
  summary: string;
  body?: string;
  plan_revision_id?: string;
  experiment_id?: string;
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  idempotency_key?: string;
}

interface PlanInput {
  project_id: string;
  title: string;
  body: string;
  change_reason?: string;
  based_on_experiment_id?: string;
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  idempotency_key?: string;
}

interface ExperimentStartInput {
  project_id: string;
  name: string;
  hypothesis: string;
  body?: string;
  plan_revision_id?: string;
  artifacts?: string[];
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  idempotency_key?: string;
}

interface ExperimentFinishInput {
  project_id: string;
  experiment_id: string;
  status: Exclude<ExperimentStatus, 'running'>;
  summary: string;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts?: string[];
  body?: string;
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  missing_fields?: string[];
  idempotency_key?: string;
}

interface ProjectIndexInput {
  project_id: string;
  roots?: ProjectRootInput[];
  git_root?: string;
  root_mode?: 'merge' | 'replace' | 'remove';
  changed_paths?: ProjectPathChange[];
  removed_paths?: ProjectPathChange[];
}

export interface CatalogWriteInput {
  project_id: string;
  kind: CatalogAssetKind;
  operation: CatalogWriteOperation;
  asset_id?: string;
  expected_revision?: number;
  idempotency_key: string;
  body?: string;
  body_path?: string;
  fields?: Record<string, unknown>;
  evidence_ids?: string[];
  artifact_references?: ArtifactReference[];
  aliases?: string[];
  protected?: boolean;
  access_tier?: CatalogAccessTier;
  set_current?: boolean;
  missing_fields?: string[];
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  correction_reason?: string;
}

interface EvidenceInput {
  project_id: string;
  source_type: EvidenceRecord['source_type'];
  source_id: string;
  locator?: string;
  quote?: string;
}

interface AssertionInput {
  project_id: string;
  subject: string;
  predicate: string;
  object?: string;
  value?: AssertionValue;
  status?: AssertionRecord['status'];
  source: AssertionRecord['source'];
  confidence?: number;
  evidence_ids?: string[];
  ontology_version?: number;
  valid_from?: string;
  valid_to?: string;
}

interface AssertionCorrectionInput {
  project_id: string;
  target_assertion_id: string;
  replacement: AssertionValue;
  reason: string;
  evidence_ids?: string[];
  valid_from?: string;
  valid_to?: string;
}

interface KnowledgeJobInput {
  project_id: string;
  kind: KnowledgeJobRecord['kind'];
  source_hash: string;
  schema_version: string;
  algorithm_version: string;
  affected_source_ids?: string[];
}

const GRAPH_ALGORITHM_VERSION = 'graphology-v10-local-ppr-no-containment';
const CODE_ALGORITHM_VERSION = 'tree-sitter-v8-query-global-linking';
const RETRIEVAL_ALGORITHM_VERSION = 'exact-bm25-e5-hnsw-v1';

function knowledgeJobKey(input: Omit<KnowledgeJobInput, 'affected_source_ids'>): string {
  return createHash('sha256')
    .update(`${input.project_id}\0${input.kind}\0${input.source_hash}\0${input.schema_version}\0${input.algorithm_version}`)
    .digest('hex');
}

function hostMemoryHandle(projectId: string, sessionId: string): string {
  const value = createHash('sha256').update(`${projectId}\0${sessionId}`).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function cleanProjectId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error('project_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  }
  return id;
}

function cleanText(value: string, name: string, max: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} required`);
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return text;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('research search cancelled');
}

function cleanTime(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return time.toISOString();
}

function cleanAssertionTarget(input: { object?: string; value?: AssertionValue }): {
  object?: string;
  value?: AssertionValue;
} {
  const hasObject = input.object !== undefined;
  const hasValue = input.value !== undefined;
  if (hasObject === hasValue) throw new Error('exactly one of object or value required');
  return hasObject
    ? { object: cleanText(input.object!, 'object', 2_000) }
    : { value: input.value };
}

function slug(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || `project-${randomUUID().slice(0, 8)}`;
}

function canonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return undefined;
  }
}

function documentId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function classify(result: CaptureResult, tool: CaptureInput['tool']): 'paper' | 'repo' | 'web' {
  const url = result.url.toLowerCase();
  if (/github\.com|gitlab\.com|codeberg\.org/.test(url)) return 'repo';
  if (
    tool === 'scholar_search'
    || result.is_pdf
    || /arxiv\.org|biorxiv\.org|openreview\.net|doi\.org|pubmed|acm\.org|ieee\.org/.test(url)
  ) return 'paper';
  return 'web';
}

function shortLabel(title: string): string {
  return title.trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 40);
}

function exactTerms(...values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    const normalized = normalizeEntityName(value);
    return normalized ? [normalized] : [];
  }))];
}

const DOCUMENT_CHUNK_CHARS = 4_000;

function documentChunks(text: string): Array<{
  chunk_index: number;
  text: string;
  content_hash: string;
}> {
  const chunks = [];
  for (let start = 0, index = 0; start < text.length; start += DOCUMENT_CHUNK_CHARS, index++) {
    const chunk = text.slice(start, start + DOCUMENT_CHUNK_CHARS);
    chunks.push({
      chunk_index: index,
      text: chunk,
      content_hash: createHash('sha256').update(chunk).digest('hex'),
    });
  }
  return chunks;
}

function semanticSourceChunks(text: string): Array<{ text: string; start: number; end: number }> {
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + DOCUMENT_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + DOCUMENT_CHUNK_CHARS / 2) end = boundary + 1;
    }
    chunks.push({ text: text.slice(start, end), start, end });
    start = end;
  }
  return chunks;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const MEASUREMENT_CONTRACT_FIELDS = [
  'metric', 'value', 'unit', 'evaluator_contract', 'dataset', 'split', 'tokenizer',
  'context_length', 'targets', 'carrier_precision', 'source_locator',
] as const;
const MEASUREMENT_IDENTITY_FIELDS = MEASUREMENT_CONTRACT_FIELDS.filter((field) => field !== 'value');
const BYTE_LEDGER_FIELDS = ['byte_components', 'denominator', 'scope'] as const;

function normalizeCatalogFields(
  kind: CatalogAssetKind,
  input: Record<string, unknown> | undefined,
  missingFields: string[],
): Record<string, unknown> {
  const fields = { ...(input ?? {}) };
  const required = kind === 'measurement'
    ? MEASUREMENT_CONTRACT_FIELDS
    : kind === 'byte_ledger' ? BYTE_LEDGER_FIELDS : [];
  const undeclared = required.filter((field) => fields[field] === undefined && !missingFields.includes(field));
  if (undeclared.length) {
    throw new Error(
      `${kind} fields missing: ${undeclared.join(', ')}; provide values or list unknowns in missing_fields`,
    );
  }
  if (kind === 'measurement') {
    fields.comparison_contract_id = createHash('sha256').update(stableJson(Object.fromEntries(
      MEASUREMENT_IDENTITY_FIELDS.map((field) => [field, fields[field] ?? null]),
    ))).digest('hex');
  }
  if (kind === 'byte_ledger') {
    fields.ledger_scope_id = createHash('sha256').update(stableJson(Object.fromEntries(
      BYTE_LEDGER_FIELDS.map((field) => [field, fields[field] ?? null]),
    ))).digest('hex');
  }
  return fields;
}

function filterSearchHits(rows: LocalSearchHit[], filters?: ResearchSearchFilters): LocalSearchHit[] {
  if (!filters) return rows;
  return rows.filter((row) => {
    if (filters.source_families?.length && !filters.source_families.includes(row.source_family)) return false;
    if (filters.retrieval_lanes?.length
      && (!row.retrieval_family || !filters.retrieval_lanes.includes(row.retrieval_family))) return false;
    if (filters.kinds?.length && (!row.kind || !filters.kinds.includes(row.kind))) return false;
    if (filters.roles?.length && (!row.role || !filters.roles.includes(row.role))) return false;
    if (filters.recorded_after && (!row.recorded_at || row.recorded_at < filters.recorded_after)) return false;
    if (filters.recorded_before && (!row.recorded_at || row.recorded_at > filters.recorded_before)) return false;
    return true;
  });
}

function graphProjectionBytes(projection: GraphProjection): number {
  let bytes = 256;
  for (const node of projection.nodes) {
    bytes += 96 + Buffer.byteLength(node.node_id) + Buffer.byteLength(node.project_id)
      + Buffer.byteLength(node.kind) + Buffer.byteLength(node.label)
      + Buffer.byteLength(node.text ?? '') + Buffer.byteLength(node.url ?? '');
  }
  for (const edge of projection.edges) {
    bytes += 72 + Buffer.byteLength(edge.edge_id) + Buffer.byteLength(edge.source)
      + Buffer.byteLength(edge.target) + Buffer.byteLength(edge.type)
      + (edge.evidence_ids?.reduce((sum, id) => sum + Buffer.byteLength(id), 0) ?? 0);
  }
  return bytes;
}

function durableRequestHash(input: Omit<CatalogWriteInput, 'idempotency_key'>): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function artifactReferences(values: string[] = []): ArtifactReference[] {
  return values.map((value) => ({
    artifact_id: createHash('sha256').update(value).digest('hex'),
    path: value,
    verification: 'declared',
  }));
}

function queryTerms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
}

function querySimilarity(left: string, right: string): number {
  const a = normalizeEntityName(left);
  const b = normalizeEntityName(right);
  if (a === b) return 1;
  const leftTerms = queryTerms(a);
  const rightTerms = queryTerms(b);
  if (!leftTerms.size || !rightTerms.size) return 0;
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap++;
  return overlap / Math.max(leftTerms.size, rightTerms.size);
}

export function tuneLocalQueries(primary: string, variants: string[] = []): string[] {
  const query = cleanText(primary, 'query', 400);
  const discovered = [
    ...[...query.matchAll(/"([^"\r\n]{2,200})"/g)].map((match) => match[1]),
    ...(query.match(/\b(?:10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+|https?:\/\/\S+|[A-Za-z][A-Za-z0-9]*(?:[_./:-][A-Za-z0-9]+)+|[A-Za-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[A-Za-z0-9-]*)\b/g) ?? []),
  ].map((value) => value.replace(/[),.;]+$/, ''));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const value of [query, ...variants, ...discovered]) {
    const cleaned = cleanText(value, 'query_variants', 400);
    const key = normalizeEntityName(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(cleaned);
    if (selected.length >= 20) break;
  }
  return selected;
}

function eventQueries(event: SearchEventRecord): string[] {
  return [...new Set([event.query, ...(event.queries ?? [])]
    .filter((query): query is string => !!query?.trim()))];
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await worker(values[index], index);
    }
  }));
  return output;
}

type RetrievalLane = NonNullable<LocalSearchHit['retrieval_family']>;

function isResearchQueryTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:query|transaction).*?(?:exceeded the timeout|timed out|timeout)/i.test(message);
}

async function runRetrievalLane<T>(
  lane: RetrievalLane,
  degradedLanes: Set<RetrievalLane>,
  operation: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await operation();
  } catch (error) {
    if (!isResearchQueryTimeout(error)) throw error;
    degradedLanes.add(lane);
    return [];
  }
}

function fuseRankedGroups(
  groups: LocalSearchHit[][],
  limit: number,
  family?: LocalSearchHit['retrieval_family'],
): LocalSearchHit[] {
  const ranked = new Map<string, { row: LocalSearchHit; score: number; order: number }>();
  let order = 0;
  for (const rows of groups) {
    rows.forEach((row, index) => {
      const key = row.url || row.document_id;
      const contribution = 1 / (60 + index + 1);
      const existing = ranked.get(key);
      if (existing) {
        existing.score += contribution;
        existing.row = {
          ...existing.row,
          record_id: existing.row.record_id ?? row.record_id,
          revision_id: existing.row.revision_id ?? row.revision_id,
          body_handle: existing.row.body_handle ?? row.body_handle,
          source_span: existing.row.source_span ?? row.source_span,
          index_freshness: existing.row.index_freshness ?? row.index_freshness,
          project_ids: [...new Set([...existing.row.project_ids, ...row.project_ids])].sort(),
          retrieval_families: [...new Set([
            ...(existing.row.retrieval_families ?? (existing.row.retrieval_family
              ? [existing.row.retrieval_family]
              : [])),
            ...(row.retrieval_families ?? (row.retrieval_family ? [row.retrieval_family] : [])),
          ])],
        };
      }
      else ranked.set(key, { row, score: contribution, order: order++ });
    });
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ row, score }) => ({
      ...row,
      score,
      ...(family ? { retrieval_family: family, retrieval_families: [family] } : {}),
    }));
}

function preserveBoundedCandidates(
  bounded: LocalSearchHit[],
  expanded: LocalSearchHit[],
  limit: number,
): LocalSearchHit[] {
  const seen = new Set<string>();
  const selected: LocalSearchHit[] = [];
  for (const row of [...bounded, ...expanded]) {
    const key = row.url || row.document_id;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(row);
    if (selected.length >= limit) break;
  }
  return selected;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function captureRows(input: CaptureInput): CaptureResult[] {
  if (input.tool === 'extract') {
    const row = input.payload;
    if (typeof row.url !== 'string') return [];
    return [{
      title: typeof row.title === 'string' ? row.title : row.url,
      url: row.url,
      content: typeof row.content === 'string' ? row.content : undefined,
      description: typeof row.description === 'string'
        ? row.description
        : typeof row.excerpt === 'string' ? row.excerpt : undefined,
      is_pdf: row.is_pdf === true,
      page_count: typeof row.page_count === 'number' ? row.page_count : undefined,
      extraction_quality: typeof row.extraction_quality === 'string'
        ? row.extraction_quality
        : undefined,
      authors: typeof row.authors === 'string' ? row.authors : undefined,
      publication: typeof row.publication === 'string' ? row.publication : undefined,
      published_at: typeof row.published_at === 'string' ? row.published_at : undefined,
      year: typeof row.year === 'number' ? row.year : undefined,
      doi: typeof row.doi === 'string' ? row.doi : undefined,
      keywords: Array.isArray(row.keywords)
        ? row.keywords.filter((value): value is string => typeof value === 'string')
        : undefined,
      canonical_url: typeof row.canonical_url === 'string' ? row.canonical_url : undefined,
      language: typeof row.language === 'string' ? row.language : undefined,
      subject: typeof row.subject === 'string' ? row.subject : undefined,
      creator: typeof row.creator === 'string' ? row.creator : undefined,
      producer: typeof row.producer === 'string' ? row.producer : undefined,
      created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
      modified_at: typeof row.modified_at === 'string' ? row.modified_at : undefined,
      cited_by_count: typeof row.cited_by_count === 'number' ? row.cited_by_count : undefined,
      scholar_id: typeof row.scholar_id === 'string' ? row.scholar_id : undefined,
    }];
  }

  const rows: Record<string, unknown>[] = [];
  const results = Array.isArray(input.payload.results) ? input.payload.results : [];
  if (input.tool === 'search_parallel') {
    for (const group of results) {
      const record = asRecord(group);
      if (!record || !Array.isArray(record.results)) continue;
      for (const row of record.results) {
        const item = asRecord(row);
        if (item) rows.push(item);
      }
    }
  } else {
    for (const row of results) {
      const item = asRecord(row);
      if (item) rows.push(item);
    }
  }

  return rows.flatMap((row) => {
    const scholarFallback = typeof row.scholar_id === 'string'
      ? `https://scholar.google.com/scholar?cluster=${encodeURIComponent(row.scholar_id)}`
      : undefined;
    const url = typeof row.url === 'string'
      ? row.url
      : typeof row.full_text_url === 'string' ? row.full_text_url : scholarFallback;
    if (typeof row.title !== 'string' || !url) return [];
    return [{
      title: row.title,
      url,
      description: typeof row.description === 'string' ? row.description : undefined,
      snippet: typeof row.snippet === 'string' ? row.snippet : undefined,
      content: typeof row.content === 'string' ? row.content : undefined,
      is_pdf: row.is_pdf === true,
      page_count: typeof row.page_count === 'number' ? row.page_count : undefined,
      extraction_quality: typeof row.extraction_quality === 'string'
        ? row.extraction_quality
        : undefined,
      authors: typeof row.authors === 'string' ? row.authors : undefined,
      publication: typeof row.publication === 'string' ? row.publication : undefined,
      published_at: typeof row.published_at === 'string' ? row.published_at : undefined,
      year: typeof row.year === 'number' ? row.year : undefined,
      doi: typeof row.doi === 'string' ? row.doi : undefined,
      keywords: Array.isArray(row.keywords)
        ? row.keywords.filter((value): value is string => typeof value === 'string')
        : undefined,
      canonical_url: typeof row.canonical_url === 'string' ? row.canonical_url : undefined,
      language: typeof row.language === 'string' ? row.language : undefined,
      subject: typeof row.subject === 'string' ? row.subject : undefined,
      creator: typeof row.creator === 'string' ? row.creator : undefined,
      producer: typeof row.producer === 'string' ? row.producer : undefined,
      created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
      modified_at: typeof row.modified_at === 'string' ? row.modified_at : undefined,
      cited_by_count: typeof row.cited_by_count === 'number' ? row.cited_by_count : undefined,
      scholar_id: typeof row.scholar_id === 'string' ? row.scholar_id : undefined,
    }];
  });
}

function repositoryDecisions(payload: Record<string, unknown>): RepositoryDecision[] {
  const meta = asRecord(payload.meta);
  if (!Array.isArray(meta?.repository_ingest)) return [];
  return meta.repository_ingest.flatMap((value) => {
    const row = asRecord(value);
    if (!row || typeof row.repository !== 'string' || typeof row.action !== 'string'
      || typeof row.reason !== 'string') return [];
    if (!['readme', 'queued', 'web_only'].includes(row.action)) return [];
    return [{
      repository: row.repository,
      action: row.action as RepositoryDecision['action'],
      reason: row.reason,
      ...(typeof row.stars === 'number' ? { stars: row.stars } : {}),
      ...(typeof row.source_bytes === 'number' ? { source_bytes: row.source_bytes } : {}),
      ...(typeof row.source_files === 'number' ? { source_files: row.source_files } : {}),
    }];
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class ResearchService {
  private readonly store: ResearchStore;
  private readonly planLocks = new Map<string, Promise<unknown>>();
  private readonly graphCache = new Map<string, GraphProjection>();
  private readonly graphArtifacts = new Map<string, GraphArtifact>();
  private graphCacheBytes = 0;
  private readonly backgroundJobs = new Set<Promise<unknown>>();
  private readonly scheduledJobIds = new Set<string>();
  private readonly graphTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly embeddings: EmbeddingProvider;
  private readonly repositoryClient: RepositoryClient;
  private readonly repositoryJobs = new Set<string>();
  private recoveredDirtyProjects = false;
  private state: 'disabled' | 'idle' | 'ready' | 'unavailable';

  constructor(private readonly options: ResearchServiceOptions) {
    this.store = new ResearchStore(
      options.root,
      options.endpoint,
      options.queryTimeoutMs,
      options.vectorBackend ?? 'hnsw',
      options.databaseNamespace,
      options.databaseName,
    );
    this.embeddings = options.embeddingProvider ?? new LocalEmbeddingModel(
      options.vectorModel,
      undefined,
      undefined,
      { lowMemory: options.vectorLowMemory, threads: options.vectorThreads },
    );
    this.repositoryClient = options.repositoryClient ?? new GitHubClient();
    this.state = options.enabled ? 'idle' : 'disabled';
  }

  private rememberGraphProjection(key: string, projection: GraphProjection): GraphProjection {
    const shared = this.graphArtifacts.get(projection.projection_id)?.projection ?? projection;
    this.graphCache.clear();
    this.graphCacheBytes = 0;
    const weight = graphProjectionBytes(shared);
    if (weight <= (this.options.graphCacheMaxBytes ?? 64 * 1024 * 1024)) {
      this.graphCache.set(key, shared);
      this.graphCacheBytes = weight;
    }
    for (const projectionId of this.graphArtifacts.keys()) {
      if (projectionId !== shared.projection_id) this.graphArtifacts.delete(projectionId);
    }
    return shared;
  }

  private rememberGraphArtifact(projectionId: string, artifact: GraphArtifact): GraphArtifact {
    const cached = [...this.graphCache.values()]
      .find((projection) => projection.projection_id === projectionId);
    const shared = cached && cached !== artifact.projection
      ? { ...artifact, projection: cached }
      : artifact;
    this.graphArtifacts.clear();
    const weight = graphProjectionBytes(shared.projection);
    if (weight <= (this.options.graphCacheMaxBytes ?? 64 * 1024 * 1024)) {
      this.graphArtifacts.set(projectionId, shared);
      this.graphCacheBytes = Math.max(this.graphCacheBytes, weight);
    }
    for (const [key, projection] of this.graphCache) {
      if (projection.projection_id !== projectionId) this.graphCache.delete(key);
    }
    return shared;
  }

  status(): ResearchServiceStatus {
    return {
      enabled: this.options.enabled,
      state: this.state,
      root: this.options.root,
      vector: this.embeddings.enabled() ? 'on' : 'off',
      external_sync: 'off',
      database_open: this.store.isOpen(),
      background_jobs: this.backgroundJobs.size,
      repository_jobs: this.repositoryJobs.size,
      scheduled_graph_jobs: this.graphTimers.size,
      graph_projection_cache: this.graphCache.size,
      graph_artifact_cache: this.graphArtifacts.size,
      graph_cache_bytes: this.graphCacheBytes,
    };
  }

  passiveStatus(processClass: 'in_process' | 'research_broker' = 'in_process'): ResearchPassiveStatus {
    const memory = process.memoryUsage();
    const resources = process.resourceUsage();
    const remoteEndpoint = this.options.endpoint && /^(?:wss?|https?):\/\//i.test(this.options.endpoint)
      ? new URL(this.options.endpoint).origin
      : undefined;
    return {
      ...this.status(),
      passive: true,
      observed_at: new Date().toISOString(),
      process: {
        process_class: processClass,
        pid: process.pid,
        parent_pid: process.ppid,
        uptime_ms: Math.round(process.uptime() * 1_000),
        rss_bytes: memory.rss,
        peak_rss_bytes: Math.max(memory.rss, resources.maxRSS * 1024),
        private_bytes: null,
        heap_total_bytes: memory.heapTotal,
        heap_used_bytes: memory.heapUsed,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
      },
      runtime: {
        google_surf_mcp: VERSION,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ...readSurrealRuntimeVersions(),
      },
      capabilities: {
        persistent_store: remoteEndpoint ? 'surrealdb_remote' : 'surrealdb_rocksdb',
        ...(remoteEndpoint ? { remote_endpoint: remoteEndpoint } : {}),
        vector_index: this.options.vectorBackend ?? 'hnsw',
        vector_dimensions: this.embeddings.dimensions(),
        passive_health_opens_database: false,
      },
    };
  }

  async probe(): Promise<ReturnType<ResearchService['status']>> {
    if (this.options.enabled) await this.ready();
    return this.status();
  }

  async requestDrain(): Promise<{ accepted: true; background_jobs: number }> {
    return { accepted: true, background_jobs: this.backgroundJobs.size };
  }

  async close(): Promise<void> {
    for (const timer of this.graphTimers.values()) clearTimeout(timer);
    this.graphTimers.clear();
    await this.waitForIdle();
    await this.store.close();
    await this.embeddings.dispose?.();
    this.recoveredDirtyProjects = false;
    this.graphCache.clear();
    this.graphArtifacts.clear();
    this.graphCacheBytes = 0;
    if (this.options.enabled) this.state = 'idle';
  }

  async waitForIdle(): Promise<void> {
    while (this.backgroundJobs.size) {
      await Promise.allSettled([...this.backgroundJobs]);
    }
  }

  private async ready(): Promise<void> {
    if (!this.options.enabled) throw new Error('research memory disabled');
    try {
      await this.store.open();
      this.state = 'ready';
      if (!this.recoveredDirtyProjects) {
        this.recoveredDirtyProjects = true;
        const pendingJobs = await this.store.listPendingKnowledgeJobs();
        const pendingRebuildProjects = new Set(pendingJobs
          .filter((job) => job.kind === 'rebuild')
          .map((job) => job.project_id));
        for (const project of await this.store.listDirtyProjects()) {
          if (!pendingRebuildProjects.has(project.project_id)) this.scheduleGraph(project.project_id);
        }
        for (const job of pendingJobs) {
          if (job.kind === 'retrieval_index' && job.schema_version === 'catalog-record-v1') {
            this.scheduleCatalogIndex(job);
          } else if (job.kind === 'rebuild') {
            this.scheduleSourceIndex(job);
          }
        }
      }
    } catch (error) {
      this.state = 'unavailable';
      throw error;
    }
  }

  private async locked<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.planLocks.get(projectId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.planLocks.set(projectId, current);
    try {
      return await current;
    } finally {
      if (this.planLocks.get(projectId) === current) this.planLocks.delete(projectId);
    }
  }

  private async invalidateGraph(projectId: string, schedule = true): Promise<void> {
    for (const key of this.graphCache.keys()) {
      if (key.split('\0').includes(projectId)) this.graphCache.delete(key);
    }
    for (const [key, artifact] of this.graphArtifacts) {
      if (artifact.projection.project_ids.includes(projectId)) this.graphArtifacts.delete(key);
    }
    this.graphCacheBytes = Math.max(
      ...[...this.graphCache.values()].map(graphProjectionBytes),
      ...[...this.graphArtifacts.values()].map((artifact) => graphProjectionBytes(artifact.projection)),
      0,
    );
    await this.store.markGraphDirty(projectId, `${Date.now()}-${randomUUID()}`);
    if (schedule) this.scheduleGraph(projectId);
  }

  private scheduleGraph(projectId: string): void {
    const pending = this.graphTimers.get(projectId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.graphTimers.delete(projectId);
      this.schedule(async () => await this.materializeGraph([projectId]));
    }, 5_000);
    timer.unref();
    this.graphTimers.set(projectId, timer);
  }

  private schedule(operation: () => Promise<unknown>): void {
    const job = Promise.resolve().then(operation);
    this.backgroundJobs.add(job);
    void job.then(
      () => this.backgroundJobs.delete(job),
      () => this.backgroundJobs.delete(job),
    );
  }

  private scheduleCatalogIndex(job: KnowledgeJobRecord): void {
    if (this.scheduledJobIds.has(job.job_id)) return;
    this.scheduledJobIds.add(job.job_id);
    this.schedule(async () => {
      try {
        const current = await this.store.getKnowledgeJob(job.job_id);
        if (!current || current.status === 'done' || current.status === 'cancelled') return;
        if (current.status === 'queued') {
          await this.transitionKnowledgeJob({
            project_id: current.project_id,
            job_id: current.job_id,
            status: 'running',
          });
        }
        await this.updateKnowledgeJobProgress(
          current.project_id, current.job_id, 'indexing', 0, current.affected_source_ids.length,
        );
        for (let index = 0; index < current.affected_source_ids.length; index++) {
          const assetId = current.affected_source_ids[index];
          if (await this.knowledgeJobCancelled(current.job_id)) return;
          const record = await this.store.getCatalogRecord(current.project_id, assetId);
          if (record) await this.indexCatalogRecord(record);
          await this.updateKnowledgeJobProgress(
            current.project_id, current.job_id, 'indexing', index + 1, current.affected_source_ids.length,
          );
        }
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.updateKnowledgeJobProgress(
          current.project_id, current.job_id, 'retrieval_publish', 0, 1,
        );
        await this.materializeRetrievalIndex(current.project_id, 'document');
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.invalidateGraph(current.project_id, false);
        await this.materializeGraph([current.project_id]);
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.transitionKnowledgeJob({
          project_id: current.project_id,
          job_id: current.job_id,
          status: 'done',
          result_digest: current.source_hash,
        });
        const receipt = await this.store.getOperationReceiptByJobId(current.job_id);
        if (receipt) await this.store.updateOperationReceipt({ ...receipt, index_state: 'current' });
      } catch (error) {
        const current = await this.store.getKnowledgeJob(job.job_id).catch(() => undefined);
        if (current && current.status !== 'failed' && current.status !== 'done'
          && current.status !== 'cancelled') {
          await this.transitionKnowledgeJob({
            project_id: current.project_id,
            job_id: current.job_id,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
      } finally {
        this.scheduledJobIds.delete(job.job_id);
      }
    });
  }

  private scheduleSourceIndex(job: KnowledgeJobRecord): void {
    if (this.scheduledJobIds.has(job.job_id)) return;
    this.scheduledJobIds.add(job.job_id);
    this.schedule(async () => {
      try {
        let current = await this.store.getKnowledgeJob(job.job_id);
        if (!current || current.status === 'done' || current.status === 'cancelled') return;
        if (current.status === 'queued') {
          current = await this.transitionKnowledgeJob({
            project_id: current.project_id,
            job_id: current.job_id,
            status: 'running',
          });
        }
        await this.updateKnowledgeJobProgress(current.project_id, current.job_id, 'code', 0, 3);
        await this.materializeCodeStructure(current.project_id, current.source_hash);
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.updateKnowledgeJobProgress(current.project_id, current.job_id, 'retrieval', 1, 3);
        await this.materializeRetrievalIndex(current.project_id, 'code');
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.updateKnowledgeJobProgress(current.project_id, current.job_id, 'graph', 2, 3);
        const graph = await this.materializeGraph([current.project_id]);
        if (await this.knowledgeJobCancelled(current.job_id)) return;
        await this.transitionKnowledgeJob({
          project_id: current.project_id,
          job_id: current.job_id,
          status: 'done',
          result_digest: current.source_hash,
          result_counts: {
            code_sources: current.affected_source_ids.length,
            graph_nodes: graph.projection.nodes.length,
            graph_edges: graph.projection.edges.length,
          },
        });
      } catch (error) {
        const current = await this.store.getKnowledgeJob(job.job_id).catch(() => undefined);
        if (current && current.status !== 'failed' && current.status !== 'done'
          && current.status !== 'cancelled') {
          await this.transitionKnowledgeJob({
            project_id: current.project_id,
            job_id: current.job_id,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
      } finally {
        this.scheduledJobIds.delete(job.job_id);
      }
    });
  }

  private async indexAdditionalRoot(projectId: string, label: string, path: string): Promise<void> {
    await this.locked('db-write', async () => {
      const project = await this.ensureProject(projectId);
      const snapshot = project.active_source_snapshot_id
        ? await this.store.getSourceSnapshot(project.active_source_snapshot_id)
        : undefined;
      const roots = [...(snapshot?.roots ?? [])];
      if (!roots.some((root) => resolve(root.path) === resolve(path))) roots.push({ label, path });
      await this.indexProjectLocked({ project_id: projectId, roots });
    });
  }

  async prepareRepositoryResults(
    projectIdValue: string | undefined,
    mode: RepositoryReadMode,
    candidates: RepositoryCandidate[],
    allowAutoDownload = true,
  ): Promise<{ rows: RepositoryCandidate[]; decisions: RepositoryDecision[]; queued: boolean }> {
    const matches = candidates.map((row, index) => ({ row, index, repo: parseGitHubRepositoryUrl(row.url) }))
      .filter((match): match is typeof match & { repo: { owner: string; name: string } } => !!match.repo)
      .slice(0, 3);
    if (!matches.length) return { rows: candidates, decisions: [], queued: false };
    const project = await this.ensureProject(projectIdValue);
    const rows = [...candidates];
    const decisions: RepositoryDecision[] = [];
    let queued = false;
    const snapshot = project.active_source_snapshot_id
      ? await this.store.getSourceSnapshot(project.active_source_snapshot_id)
      : undefined;
    const inspected = await Promise.all(matches.map(async (match) => {
      try {
        return { match, repository: await this.repositoryClient.inspect(match.row.url, mode !== 'none') };
      } catch {
        return { match, repository: undefined, failed: true };
      }
    }));
    for (const { match, repository, failed } of inspected) {
      if (failed) {
        decisions.push({
          repository: `${match.repo.owner}/${match.repo.name}`,
          action: 'web_only',
          reason: 'repository metadata unavailable',
        });
        continue;
      }
      if (!repository) continue;
      if (repository.readme) {
        rows[match.index] = {
          ...match.row,
          content: fenceUntrustedContent(
            repository.readme.slice(0, mode === 'full' ? 50_000 : 1_500),
          ),
          extraction_quality: 'abstract',
        };
      }
      let decision = decideRepository(
        repository,
        match.index + 1,
        match.row.description ?? '',
        mode,
        {
          max_source_bytes: this.options.repositoryMaxSourceBytes ?? 20 * 1024 * 1024,
          max_source_files: this.options.repositoryMaxSourceFiles ?? 2_000,
          min_stars: 50,
        },
      );
      if (decision.action === 'queued' && this.options.repositoryAuto === false) {
        decision = { ...decision, action: 'web_only', reason: 'automatic repository indexing disabled' };
      }
      if (decision.action === 'queued' && (!allowAutoDownload || queued)) {
        decision = { ...decision, action: 'web_only', reason: 'automatic repository limit reached' };
      }
      const destination = join(
        this.options.root,
        'repositories',
        project.project_id,
        `${repository.owner.replace(/[^A-Za-z0-9_.-]/g, '_')}__${repository.name.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      );
      if (decision.action === 'queued'
        && snapshot?.roots.some((root) => resolve(root.path) === resolve(destination))) {
        decision = { ...decision, action: 'web_only', reason: 'repository already indexed' };
      }
      if (decision.action === 'queued') {
        await mkdir(this.options.root, { recursive: true });
        const disk = await statfs(this.options.root);
        const available = Number(disk.bavail) * Number(disk.bsize);
        const required = Math.max(512 * 1024 * 1024, repository.source_bytes * 6);
        if (available < required) {
          decision = { ...decision, action: 'web_only', reason: 'insufficient local storage' };
        }
      }
      if (decision.action === 'queued') {
        const paths = selectedRepositoryPaths(repository, mode === 'full' ? 'full' : 'abstract');
        const key = `${project.project_id}\0${repository.owner}/${repository.name}`.toLowerCase();
        if (this.repositoryJobs.has(key)) {
          decision = { ...decision, action: 'web_only', reason: 'repository indexing already queued' };
        } else {
          this.repositoryJobs.add(key);
          queued = true;
          const label = `gh-${repository.owner}-${repository.name}`
            .replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
          this.schedule(async () => {
            try {
              await this.repositoryClient.checkout(repository, paths, destination);
              await this.indexAdditionalRoot(project.project_id, label, destination);
            } catch (error) {
              console.error(
                `[google-surf-mcp] repository indexing failed for ${repository.owner}/${repository.name}:`,
                error instanceof Error ? error.message : error,
              );
              throw error;
            } finally {
              this.repositoryJobs.delete(key);
            }
          });
        }
      }
      decisions.push(decision);
    }
    return { rows, decisions, queued };
  }

  async createProject(nameValue: string, projectIdValue?: string): Promise<ProjectRecord> {
    await this.ready();
    const name = cleanText(nameValue, 'name', 120);
    let projectId = cleanProjectId(projectIdValue ?? slug(name));
    if (!projectIdValue && await this.store.getProject(projectId)) {
      projectId = `${projectId}-${randomUUID().slice(0, 6)}`;
    }
    if (await this.store.getProject(projectId)) throw new Error(`project already exists: ${projectId}`);
    const now = new Date().toISOString();
    return await this.store.putProject({
      project_id: projectId,
      name,
      status: 'active',
      created_at: now,
      updated_at: now,
      graph_dirty_at: now,
    });
  }

  async ensureProject(projectIdValue?: string): Promise<ProjectRecord> {
    await this.ready();
    const projectId = cleanProjectId(projectIdValue ?? 'inbox');
    const existing = await this.store.getProject(projectId);
    if (existing?.status === 'forgotten') throw new Error(`project forgotten: ${projectId}`);
    if (existing) return existing;
    if (projectId !== 'inbox') throw new Error(`project not found: ${projectId}`);
    const now = new Date().toISOString();
    return await this.store.putProject({
      project_id: 'inbox',
      name: 'Inbox',
      status: 'active',
      created_at: now,
      updated_at: now,
      graph_dirty_at: now,
    });
  }

  async listProjects(): Promise<ProjectRecord[]> {
    await this.ready();
    return await this.store.listProjects();
  }

  async updateProjectContext(input: {
    project_id: string;
    purpose?: string;
    user_constraints?: string[];
    protected_parent_ids?: string[];
  }): Promise<ProjectRecord> {
    const project = await this.ensureProject(input.project_id);
    return await this.store.updateProjectContext(project.project_id, {
      ...(input.purpose !== undefined
        ? { purpose: cleanText(input.purpose, 'purpose', 10_000) } : {}),
      ...(input.user_constraints !== undefined
        ? { user_constraints: [...new Set(input.user_constraints.map((item) => cleanText(item, 'user_constraint', 2_000)))] }
        : {}),
      ...(input.protected_parent_ids !== undefined
        ? { protected_parent_ids: [...new Set(input.protected_parent_ids.map((item) => cleanText(item, 'protected_parent_id', 500)))] }
        : {}),
    });
  }

  async exportCatalogSnapshot(projectIdValue: string): Promise<{
    path: string;
    sha256: string;
    catalog_generation: number;
    record_count: number;
    cutoff: string;
  }> {
    const project = await this.ensureProject(projectIdValue);
    const records: CatalogRecordReadback[] = [];
    let after: string | undefined;
    for (;;) {
      const assets = await this.store.listCatalogAssets(project.project_id, { after, limit: 100 });
      if (!assets.length) break;
      for (const asset of assets) {
        for (const revision of await this.store.listCatalogRevisions(project.project_id, asset.asset_id)) {
          const first = await this.store.getCatalogRecord(
            project.project_id,
            asset.asset_id,
            revision.revision,
            0,
            1024 * 1024,
          );
          if (!first) continue;
          let body = first.body ?? '';
          let offset = first.next_body_offset;
          while (offset !== undefined) {
            const next = await this.store.getCatalogRecord(
              project.project_id,
              asset.asset_id,
              revision.revision,
              offset,
              1024 * 1024,
            );
            if (!next) break;
            body += next.body ?? '';
            offset = next.next_body_offset;
          }
          records.push({ ...first, ...(first.revision.body_blob_id ? { body } : {}) });
        }
      }
      after = assets.at(-1)!.asset_id;
      if (assets.length < 100) break;
    }
    const cutoff = new Date().toISOString();
    const snapshot = {
      format: 'google-surf-catalog-v2',
      project,
      catalog_generation: project.catalog_generation ?? 0,
      cutoff,
      records,
    };
    const encoded = JSON.stringify(snapshot, null, 2);
    const sha256 = createHash('sha256').update(encoded).digest('hex');
    const directory = join(this.options.root, 'exports');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${project.project_id}-catalog-g${snapshot.catalog_generation}-${sha256.slice(0, 12)}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    return { path, sha256, catalog_generation: snapshot.catalog_generation, record_count: records.length, cutoff };
  }

  async importCatalogSnapshot(input: {
    project_id: string;
    path: string;
    expected_generation?: number;
    dry_run?: boolean;
    rollback?: boolean;
  }): Promise<Record<string, unknown>> {
    const project = await this.ensureProject(input.project_id);
    if (input.expected_generation !== undefined
      && input.expected_generation !== (project.catalog_generation ?? 0)) {
      throw new Error(`catalog generation conflict: expected ${input.expected_generation}, current ${project.catalog_generation ?? 0}`);
    }
    const snapshotBytes = await readFile(resolve(input.path));
    const snapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex');
    const payload = JSON.parse(snapshotBytes.toString('utf8')) as {
      format?: string;
      project?: ProjectRecord;
      records?: CatalogRecordReadback[];
    };
    if (!['google-surf-catalog-v1', 'google-surf-catalog-v2'].includes(payload.format ?? '')
      || !Array.isArray(payload.records)) {
      throw new Error('unsupported catalog snapshot');
    }
    const proposed = payload.records.filter((record) => record?.asset?.asset_id && record?.revision);
    const currentRevisionIds = new Set(payload.records
      .filter((record) => record.asset.current_revision_id === record.revision.revision_id)
      .map((record) => record.revision.revision_id));
    if (input.dry_run !== false) {
      return {
        dry_run: true,
        mode: input.rollback ? 'rollback' : 'import',
        revisions: proposed.length,
        current_records: currentRevisionIds.size,
        snapshot_sha256: snapshotSha256,
        project_id: project.project_id,
      };
    }
    const receipts: DurableWriteReceipt[] = [];
    const targetWasEmpty = !(await this.store.listCatalogAssets(project.project_id, { limit: 1 })).length;
    const applicable = targetWasEmpty
      ? proposed
      : proposed.filter((record) => currentRevisionIds.has(record.revision.revision_id));
    for (const record of applicable) {
      const existing = await this.store.getCatalogAsset(project.project_id, record.asset.asset_id);
      receipts.push(await this.writeCatalogRecord({
        project_id: project.project_id,
        kind: record.asset.kind,
        operation: existing ? 'patch' : 'create',
        asset_id: record.asset.asset_id,
        expected_revision: existing?.current_revision ?? 0,
        idempotency_key: `catalog-${input.rollback ? 'rollback' : 'import'}:${snapshotSha256}:${record.revision.revision_id}:${project.catalog_generation ?? 0}`,
        body: record.body,
        fields: record.revision.fields,
        evidence_ids: record.revision.evidence_ids,
        artifact_references: record.revision.artifact_references,
        aliases: record.asset.aliases,
        protected: record.asset.protected,
        access_tier: record.asset.access_tier,
        set_current: record.asset.asset_id === payload.project?.current_plan_asset_id,
        missing_fields: record.revision.missing_fields,
        effective_at: record.revision.effective_at,
        source_sequence: record.revision.source_sequence,
        source_reference: record.revision.source_reference,
      }));
    }
    const updated = await this.ensureProject(project.project_id);
    const journalId = createHash('sha256').update(
      `${input.rollback ? 'rollback' : 'import'}\0${project.project_id}\0${snapshotSha256}\0${project.catalog_generation ?? 0}`,
    ).digest('hex');
    await this.store.putCatalogMigrationJournal({
      journal_id: journalId,
      project_id: project.project_id,
      mode: input.rollback ? 'rollback' : 'import',
      snapshot_path: resolve(input.path),
      snapshot_sha256: snapshotSha256,
      snapshot_generation: payload.project?.catalog_generation ?? 0,
      catalog_generation_before: project.catalog_generation ?? 0,
      catalog_generation_after: updated.catalog_generation ?? 0,
      applied_revision_ids: receipts.map((receipt) => receipt.revision_id),
      preserved_post_snapshot_assets: !targetWasEmpty,
      created_at: new Date().toISOString(),
    });
    return {
      dry_run: false,
      mode: input.rollback ? 'rollback' : 'import',
      journal_id: journalId,
      records: receipts.length,
      snapshot_sha256: snapshotSha256,
      catalog_generation_before: project.catalog_generation ?? 0,
      catalog_generation_after: updated.catalog_generation ?? 0,
      preserved_post_snapshot_assets: !targetWasEmpty,
      receipts,
    };
  }

  private async indexCatalogRecord(record: CatalogRecordReadback): Promise<void> {
    const documentIdValue = `catalog-${createHash('sha256')
      .update(record.asset.asset_id).digest('hex').slice(0, 32)}`;
    const titleValue = record.revision.fields.title ?? record.revision.fields.name;
    const title = typeof titleValue === 'string' && titleValue.trim()
      ? titleValue.slice(0, 1_000)
      : `${record.asset.kind}: ${record.asset.asset_id}`.slice(0, 1_000);
    const fallbackText = stableJson(record.revision.fields);
    const chunkSetId = record.revision.body_blob_id
      ?? createHash('sha256').update(fallbackText).digest('hex');
    const now = new Date().toISOString();
    let chunkIndex = 0;
    let bodyOffset = 0;
    let hasBodyPage = false;
    for (;;) {
      const page = record.revision.body_blob_id
        ? await this.store.getCatalogRecord(
          record.asset.project_id,
          record.asset.asset_id,
          record.revision.revision,
          bodyOffset,
          1024 * 1024,
        )
        : undefined;
      const text = page?.body ?? (!hasBodyPage ? fallbackText : '');
      if (text) {
        const pageStart = page?.body_span?.start ?? 0;
        const chunks = documentChunks(text).map((chunk) => {
          const currentIndex = chunkIndex++;
          return {
            chunk_id: `${documentIdValue}_${chunkSetId.slice(0, 16)}_${currentIndex}`,
            document_id: documentIdValue,
            chunk_set_id: chunkSetId,
            chunk_index: currentIndex,
            title,
            url: `surf://projects/${record.asset.project_id}/records/${encodeURIComponent(record.asset.asset_id)}`,
            text: chunk.text,
            content_hash: chunk.content_hash,
            source_span: {
              start: pageStart + Buffer.byteLength(
                text.slice(0, chunk.chunk_index * DOCUMENT_CHUNK_CHARS),
                'utf8',
              ),
              end: pageStart + Buffer.byteLength(
                text.slice(0, chunk.chunk_index * DOCUMENT_CHUNK_CHARS + chunk.text.length),
                'utf8',
              ),
            },
            updated_at: now,
          };
        });
        await this.store.stageDocumentChunks(chunks);
      }
      hasBodyPage = true;
      if (!page?.next_body_offset) break;
      bodyOffset = page.next_body_offset;
    }
    if (!chunkIndex) return;
    await this.store.publishDocumentChunkSet({
      document_id: documentIdValue,
      canonical_url: `surf://projects/${record.asset.project_id}/records/${encodeURIComponent(record.asset.asset_id)}`,
      title,
      kind: record.asset.kind,
      content_hash: chunkSetId,
      catalog_asset_id: record.asset.asset_id,
      catalog_revision_id: record.revision.revision_id,
      updated_at: now,
    }, {
      project_id: record.asset.project_id,
      document_id: documentIdValue,
      state: 'lexical_active',
      added_at: record.asset.created_at,
      updated_at: now,
    }, chunkSetId);
  }

  async writeCatalogRecord(input: CatalogWriteInput): Promise<DurableWriteReceipt> {
    const project = await this.ensureProject(input.project_id);
    const assetIdValue = input.asset_id?.trim()
      || `${project.project_id}:${input.kind}:${randomUUID()}`;
    if (input.operation !== 'create' && !input.asset_id) throw new Error('asset_id required');
    if (!input.idempotency_key.trim()) throw new Error('idempotency_key required');
    if (input.body !== undefined && input.body_path) throw new Error('body and body_path cannot be combined');
    if (input.body !== undefined && Buffer.byteLength(input.body, 'utf8') > 64 * 1024 * 1024) {
      throw new Error('body exceeds 67108864 UTF-8 bytes; use body_path for a streamed versioned attachment');
    }
    if ((input.artifact_references?.length ?? 0) > 50_000) {
      throw new Error('artifact_references accepts at most 50000 entries per operation');
    }
    let bodyAttachment: { blob_id: string; byte_length: number } | undefined;
    if (input.body_path) {
      const path = resolve(input.body_path);
      const file = await stat(path);
      if (!file.isFile()) throw new Error('body_path must reference a regular file');
      if (file.size > 256 * 1024 * 1024) throw new Error('body_path exceeds 268435456 bytes');
      const hash = createHash('sha256');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
        hash.update(chunk);
        decoder.decode(chunk, { stream: true });
      }
      decoder.decode();
      bodyAttachment = { blob_id: hash.digest('hex'), byte_length: file.size };
      await this.store.putContentBlobChunks(
        bodyAttachment.blob_id,
        bodyAttachment.byte_length,
        createReadStream(path, { highWaterMark: 256 * 1024 }),
      );
    }
    const missingFields = [...new Set(input.missing_fields ?? [])];
    const fields = normalizeCatalogFields(input.kind, input.fields, missingFields);
    const { body_path: _bodyPath, fields: _fields, ...inputWithoutPath } = input;
    const normalized = {
      ...inputWithoutPath,
      project_id: project.project_id,
      asset_id: assetIdValue,
      fields,
      aliases: [...new Set(input.aliases ?? [])],
      evidence_ids: [...new Set(input.evidence_ids ?? [])],
      artifact_references: input.artifact_references ?? [],
      missing_fields: missingFields,
      ...(input.effective_at ? { effective_at: cleanTime(input.effective_at, 'effective_at') } : {}),
      ...(bodyAttachment ? { body_attachment: bodyAttachment } : {}),
    };
    const receipt = await this.store.commitCatalogRevision({
      ...normalized,
      asset_id: assetIdValue,
      idempotency_key: input.idempotency_key,
      request_hash: durableRequestHash(normalized),
    });
    if (receipt.changed) await this.invalidateGraph(project.project_id, false);
    if (receipt.index_job_id) {
      const job = await this.store.getKnowledgeJob(receipt.index_job_id);
      if (job) this.scheduleCatalogIndex(job);
    }
    return receipt;
  }

  async getCatalogRecord(
    projectIdValue: string,
    recordId: string,
    revision?: number,
    bodyOffset = 0,
    bodyBytes = 64 * 1024,
    artifactOffset = 0,
    artifactLimit = 200,
  ): Promise<CatalogRecordReadback | SourceRecordReadback | DocumentRecordReadback | { legacy: true; record: unknown }> {
    const project = await this.ensureProject(projectIdValue);
    const catalog = await this.store.getCatalogRecord(
      project.project_id,
      cleanText(recordId, 'record_id', 500),
      revision,
      bodyOffset,
      Math.min(Math.max(bodyBytes, 1), 1024 * 1024),
      Math.max(0, artifactOffset),
      Math.min(Math.max(artifactLimit, 1), 1_000),
    );
    if (catalog) return catalog;
    const source = await this.store.getProjectSourceRecord(
      project.project_id,
      cleanText(recordId, 'record_id', 500),
      bodyOffset,
      Math.min(Math.max(bodyBytes, 1), 1024 * 1024),
    );
    if (source) return source;
    const document = await this.store.getProjectDocumentRecord(
      project.project_id,
      cleanText(recordId, 'record_id', 500),
      bodyOffset,
      Math.min(Math.max(bodyBytes, 1), 1024 * 1024),
    );
    if (document) return document;
    const [plan, experiment, decision, assertion, entity, ontology] = await Promise.all([
      this.store.getPlan(recordId),
      this.store.getExperiment(recordId),
      this.store.getDecision(recordId),
      this.store.getAssertion(recordId),
      this.store.getEntity(recordId),
      this.store.getOntologyTerm(recordId),
    ]);
    const record = [plan, experiment, decision, assertion, entity, ontology]
      .find((value) => value?.project_id === project.project_id);
    if (!record) throw new Error(`record not found in project: ${recordId}`);
    return { legacy: true, record };
  }

  async getCatalogRecords(
    projectIdValue: string,
    recordIds: string[],
    options: {
      body_offset?: number;
      body_bytes?: number;
      artifact_offset?: number;
      artifact_limit?: number;
    } = {},
  ): Promise<Array<{ record_id: string; record?: Awaited<ReturnType<ResearchService['getCatalogRecord']>>; error?: string }>> {
    if (!recordIds.length || recordIds.length > 100) throw new Error('record_ids accepts 1-100 entries');
    return await mapConcurrent([...new Set(recordIds)], 4, async (recordId) => {
      try {
        return {
          record_id: recordId,
          record: await this.getCatalogRecord(
            projectIdValue,
            recordId,
            undefined,
            options.body_offset,
            options.body_bytes,
            options.artifact_offset,
            options.artifact_limit,
          ),
        };
      } catch (error) {
        return { record_id: recordId, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  async projectContext(
    projectIdValue: string,
    budgetBytes = 12_000,
    sinceRevision?: number,
    asOf?: string,
  ): Promise<Record<string, unknown>> {
    const project = await this.ensureProject(projectIdValue);
    const cutoff = asOf ? cleanTime(asOf, 'as_of') : undefined;
    const [summary, plans, timeline, catalogPlan, planAssets, intents, experiments] = await Promise.all([
      this.getProjectSummary(project.project_id),
      this.store.listPlans(project.project_id),
      this.store.listCatalogTimeline(project.project_id, { before: cutoff, limit: 200 }),
      cutoff
        ? this.store.findCatalogPlanAt(project.project_id, cutoff)
        : project.current_plan_asset_id
          ? this.store.getCatalogRecord(project.project_id, project.current_plan_asset_id, undefined, 0, 256 * 1024)
          : Promise.resolve(undefined),
      this.store.listCatalogAssets(project.project_id, { kind: 'plan', limit: 200 }),
      this.store.listProjectIntents(project.project_id),
      this.store.listExperiments(project.project_id),
    ]);
    const legacyPlan = cutoff
      ? [...plans].filter((plan) => (plan.effective_at ?? plan.recorded_at ?? plan.created_at) <= cutoff)
        .sort((left, right) => (right.effective_at ?? right.recorded_at ?? right.created_at)
          .localeCompare(left.effective_at ?? left.recorded_at ?? left.created_at))[0]
      : plans.find((plan) => plan.plan_revision_id === project.active_plan_revision_id);
    const activePlan = catalogPlan && !('legacy' in catalogPlan) ? {
      plan_revision_id: catalogPlan.revision.revision_id,
      asset_id: catalogPlan.asset.asset_id,
      revision: catalogPlan.revision.revision,
      title: typeof catalogPlan.revision.fields.title === 'string'
        ? catalogPlan.revision.fields.title : catalogPlan.asset.asset_id,
      body: catalogPlan.body ?? '',
      effective_at: catalogPlan.revision.effective_at,
      recorded_at: catalogPlan.revision.recorded_at,
    } : legacyPlan ? {
      plan_revision_id: legacyPlan.plan_revision_id,
      revision: legacyPlan.revision,
      title: legacyPlan.title,
      body: legacyPlan.body,
      effective_at: legacyPlan.effective_at,
      recorded_at: legacyPlan.recorded_at ?? legacyPlan.created_at,
    } : undefined;
    const protectedParents = (await Promise.all((project.protected_parent_ids ?? []).slice(0, 50)
      .map(async (recordId) => {
        const record = await this.store.getCatalogRecord(project.project_id, recordId, undefined, 0, 1);
        if (!record) return { record_id: recordId, missing: true };
        const label = record.revision.fields.title ?? record.revision.fields.name ?? record.asset.asset_id;
        return {
          record_id: record.asset.asset_id,
          revision: record.revision.revision,
          kind: record.asset.kind,
          label,
          access_tier: record.asset.access_tier,
          body_handle: record.revision.body_blob_id ? record.asset.asset_id : undefined,
        };
      })));
    const changes = timeline.filter((event) => event.revision > (sinceRevision ?? 0)).slice(-20);
    const latestPlanAsset = [...planAssets].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    const stalePlanWarning = !cutoff && latestPlanAsset
      && latestPlanAsset.current_revision_id !== project.current_plan_revision_id
      ? `A newer plan revision exists but is not the selected current plan: ${latestPlanAsset.current_revision_id}`
      : undefined;
    const context = {
      project: {
        project_id: project.project_id,
        name: project.name,
        purpose: project.purpose,
        user_constraints: project.user_constraints ?? [],
        protected_parent_ids: project.protected_parent_ids ?? [],
        catalog_generation: project.catalog_generation ?? 0,
      },
      active_plan: activePlan ? {
        plan_revision_id: activePlan.plan_revision_id,
        ...('asset_id' in activePlan ? { asset_id: activePlan.asset_id } : {}),
        revision: activePlan.revision,
        title: activePlan.title,
        body: activePlan.body,
        effective_at: activePlan.effective_at,
        recorded_at: activePlan.recorded_at,
      } : null,
      current_intent: intents.at(-1) ? {
        intent_revision_id: intents.at(-1)!.intent_revision_id,
        intent: intents.at(-1)!.intent,
        status: intents.at(-1)!.status,
        recorded_at: intents.at(-1)!.created_at,
      } : null,
      active_work: experiments.filter((experiment) => experiment.status === 'running').slice(-20).map((experiment) => ({
        experiment_id: experiment.experiment_id,
        plan_revision_id: experiment.plan_revision_id,
        name: experiment.name,
        hypothesis: experiment.hypothesis,
        started_at: experiment.started_at,
      })),
      protected_parents: protectedParents,
      counts: summary,
      changes,
      ...(cutoff ? { as_of: cutoff } : {}),
      ...(stalePlanWarning ? { warnings: [stalePlanWarning] } : {}),
    };
    const encoded = JSON.stringify(context);
    if (Buffer.byteLength(encoded, 'utf8') <= budgetBytes) return { ...context, truncated: false };
    return {
      project: context.project,
      active_plan: activePlan ? {
        plan_revision_id: activePlan.plan_revision_id,
        ...('asset_id' in activePlan ? { asset_id: activePlan.asset_id } : {}),
        revision: activePlan.revision,
        title: activePlan.title,
        body_handle: activePlan.plan_revision_id,
      } : null,
      current_intent: context.current_intent,
      active_work: context.active_work.slice(-5),
      counts: summary,
      protected_parents: protectedParents,
      changes: changes.slice(-5),
      truncated: true,
      budget_bytes: budgetBytes,
      ...(cutoff ? { as_of: cutoff } : {}),
      ...(stalePlanWarning ? { warnings: [stalePlanWarning] } : {}),
    };
  }

  async materializeCurrentView(projectIdValue: string): Promise<{
    path: string;
    catalog_generation: number;
    bytes: number;
  }> {
    const context = await this.projectContext(projectIdValue, 64 * 1024) as {
      project: { project_id: string; name: string; purpose?: string; user_constraints?: string[]; catalog_generation: number };
      active_plan: null | { plan_revision_id: string; asset_id?: string; title: string; body?: string; body_handle?: string };
      current_intent?: null | { intent_revision_id: string; intent: string; status: string };
      active_work?: Array<{ experiment_id: string; plan_revision_id: string; name: string; hypothesis: string }>;
      protected_parents?: Array<{ record_id: string; revision?: number; kind?: string; label?: unknown; missing?: boolean }>;
      warnings?: string[];
    };
    const oneLine = (value: unknown): string => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
    const lines = [
      `# ${oneLine(context.project.name)}: Current Research Context`,
      '',
      '> Generated from the authoritative Google Surf catalog. Do not edit this view directly.',
      '',
      `- Project: \`${context.project.project_id}\``,
      `- Catalog generation: ${context.project.catalog_generation}`,
      `- Generated at: ${new Date().toISOString()}`,
      ...(context.project.purpose ? [`- Purpose: ${oneLine(context.project.purpose)}`] : []),
      '',
      '## Current Intent',
      '',
      context.current_intent
        ? `${context.current_intent.intent}\n\nRecord: \`${context.current_intent.intent_revision_id}\``
        : 'No current intent is recorded.',
      '',
      '## Active Plan',
      '',
      context.active_plan
        ? `**${oneLine(context.active_plan.title)}**  \nRecord: \`${context.active_plan.asset_id ?? context.active_plan.plan_revision_id}\`  \nRevision: \`${context.active_plan.plan_revision_id}\`${context.active_plan.body ? `\n\n${context.active_plan.body.slice(0, 4_000)}${context.active_plan.body.length > 4_000 ? '\n\n[Body preview truncated; fetch the record by ID.]' : ''}` : ''}`
        : 'No active plan is selected.',
      '',
      '## Protected Parents',
      '',
      ...(context.protected_parents?.length
        ? context.protected_parents.map((parent) => `- \`${parent.record_id}\`${parent.missing ? ' (missing)' : `: ${oneLine(parent.label)}`}`)
        : ['- None recorded.']),
      '',
      '## Active Work',
      '',
      ...(context.active_work?.length
        ? context.active_work.map((work) => `- \`${work.experiment_id}\`: ${oneLine(work.name)} (plan \`${work.plan_revision_id}\`)`)
        : ['- No running experiment is recorded.']),
      ...(context.warnings?.length ? ['', '## Preservation Gaps', '', ...context.warnings.map((warning) => `- ${oneLine(warning)}`)] : []),
      '',
    ];
    const content = lines.join('\n');
    const directory = join(this.options.root, 'exports');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${context.project.project_id}-CURRENT.md`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    return {
      path,
      catalog_generation: context.project.catalog_generation,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  }

  async catalogTimeline(
    projectIdValue: string,
    options: { after?: string; before?: string; limit?: number } = {},
  ): Promise<{ events: CatalogTimelineEvent[]; next_cursor?: string }> {
    const project = await this.ensureProject(projectIdValue);
    const events = await this.store.listCatalogTimeline(project.project_id, options);
    return {
      events,
      ...(events.length === (options.limit ?? 50) ? { next_cursor: events.at(-1)!.recorded_at } : {}),
    };
  }

  async catalogDiff(
    projectIdValue: string,
    recordId: string,
    fromRevision: number,
    toRevision?: number,
  ): Promise<Record<string, unknown>> {
    const project = await this.ensureProject(projectIdValue);
    const asset = await this.store.getCatalogAsset(project.project_id, recordId);
    if (!asset) throw new Error(`record not found in project: ${recordId}`);
    const from = await this.store.getCatalogRecord(project.project_id, asset.asset_id, fromRevision);
    const to = await this.store.getCatalogRecord(
      project.project_id,
      asset.asset_id,
      toRevision ?? asset.current_revision,
    );
    if (!from || !to) throw new Error('revision not found');
    const keys = [...new Set([...Object.keys(from.revision.fields), ...Object.keys(to.revision.fields)])].sort();
    const fields = Object.fromEntries(keys.flatMap((key) => (
      stableJson(from.revision.fields[key]) === stableJson(to.revision.fields[key])
        ? [] : [[key, { before: from.revision.fields[key], after: to.revision.fields[key] }]]
    )));
    return {
      record_id: asset.asset_id,
      from_revision: from.revision.revision,
      to_revision: to.revision.revision,
      fields,
      body_changed: from.revision.body_blob_id !== to.revision.body_blob_id,
      evidence_added: to.revision.evidence_ids.filter((id) => !from.revision.evidence_ids.includes(id)),
      artifacts_added: to.revision.artifact_references.filter((item) => (
        !from.revision.artifact_references.some((prior) => stableJson(prior) === stableJson(item))
      )),
    };
  }

  async jobStatus(projectIdValue: string, jobId: string): Promise<KnowledgeJobRecord> {
    const project = await this.ensureProject(projectIdValue);
    const job = await this.store.getKnowledgeJob(jobId);
    if (!job || job.project_id !== project.project_id) throw new Error('job_id must belong to the project');
    return job;
  }

  async waitForJob(
    projectIdValue: string,
    jobId: string,
    afterRevision = 0,
    timeoutMs = 30_000,
  ): Promise<{ job: KnowledgeJobRecord; timed_out: boolean }> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000);
    for (;;) {
      const job = await this.jobStatus(projectIdValue, jobId);
      const revision = job.revision ?? job.attempts;
      if (revision > afterRevision || job.status === 'done' || job.status === 'failed'
        || job.status === 'cancelled') {
        return { job, timed_out: false };
      }
      if (Date.now() >= deadline) return { job, timed_out: true };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(250, deadline - Date.now())));
    }
  }

  async cancelJob(
    projectIdValue: string,
    jobId: string,
    reason = 'cancelled by client',
  ): Promise<KnowledgeJobRecord> {
    const project = await this.ensureProject(projectIdValue);
    return await this.locked(`job-state:${jobId}`, async () => {
      const job = await this.store.getKnowledgeJob(jobId);
      if (!job || job.project_id !== project.project_id) {
        throw new Error('job_id must belong to the project');
      }
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
      const now = new Date().toISOString();
      return await this.store.putKnowledgeJob({
        ...job,
        status: 'cancelled',
        revision: (job.revision ?? 1) + 1,
        cancel_requested_at: now,
        cancel_reason: cleanText(reason, 'cancel_reason', 500),
        updated_at: now,
      });
    });
  }

  private async knowledgeJobCancelled(jobId: string): Promise<boolean> {
    return (await this.store.getKnowledgeJob(jobId))?.status === 'cancelled';
  }

  private async updateKnowledgeJobProgress(
    projectId: string,
    jobId: string,
    stage: string,
    completedItems: number,
    totalItems: number,
  ): Promise<KnowledgeJobRecord> {
    return await this.locked(`job-state:${jobId}`, async () => {
      const job = await this.store.getKnowledgeJob(jobId);
      if (!job || job.project_id !== projectId) throw new Error('job_id must belong to the project');
      if (job.status !== 'running') return job;
      return await this.store.putKnowledgeJob({
        ...job,
        stage,
        completed_items: completedItems,
        total_items: totalItems,
        revision: (job.revision ?? 1) + 1,
        updated_at: new Date().toISOString(),
      });
    });
  }

  async verifyCatalogRecord(
    projectIdValue: string,
    recordId: string,
    level: 'declared' | 'present' | 'hash_verified' | 'restore_tested' | 'replayed' = 'declared',
  ): Promise<Record<string, unknown>> {
    const readback = await this.getCatalogRecord(projectIdValue, recordId, undefined, 0, 1);
    if ('legacy' in readback) return { record_id: recordId, level: 'declared', legacy: true };
    if ('source' in readback) {
      const present = Boolean(readback.entry.content_hash && readback.body_span);
      return {
        record_id: readback.entry.entry_id,
        source: true,
        requested_level: level,
        content_hash: readback.entry.content_hash,
        complete: level === 'declared' || (level === 'present' && present),
        ...(level !== 'declared' && level !== 'present'
          ? { reason: `${level} requires a full source-body verification workflow` }
          : {}),
      };
    }
    if ('document' in readback) {
      const present = Boolean(readback.body_span);
      return {
        record_id: readback.record.document_id,
        document: true,
        requested_level: level,
        complete: level === 'declared' || (level === 'present' && present),
        ...(level !== 'declared' && level !== 'present'
          ? { reason: `${level} requires a full document-body verification workflow` }
          : {}),
      };
    }
    const order = ['declared', 'present', 'hash_verified', 'restore_tested', 'replayed'];
    const artifacts = await mapConcurrent(readback.revision.artifact_references, 4, async (artifact) => {
      const location = artifact.location ?? artifact.path;
      const declared = artifact.verification ?? 'declared';
      const payloadState = artifact.available === false
        ? 'remote_unavailable'
        : artifact.available === true ? 'declared_available' : 'unknown';
      if (level === 'declared') {
        return {
          artifact_id: artifact.artifact_id,
          location,
          payload_state: payloadState,
          declared_verification: declared,
          satisfies: true,
        };
      }
      if (!location || !isAbsolute(location) || artifact.member) {
        return {
          artifact_id: artifact.artifact_id,
          location,
          payload_state: payloadState,
          declared_verification: declared,
          satisfies: order.indexOf(declared) >= order.indexOf(level),
          verification_source: 'existing_receipt',
          ...(!artifact.member ? { reason: 'no absolute local path' }
            : { reason: 'archive member requires an archive restore verifier' }),
        };
      }
      try {
        const file = await stat(location);
        if (!file.isFile()) throw new Error('not a regular file');
        if (level === 'present') {
          return {
            artifact_id: artifact.artifact_id,
            location,
            payload_state: 'local_present',
            declared_verification: declared,
            observed_size: file.size,
            expected_size: artifact.size,
            satisfies: artifact.size === undefined || artifact.size === file.size,
            verification_source: 'live_local_file',
          };
        }
        if (level === 'hash_verified') {
          if (!artifact.content_hash) {
            return {
              artifact_id: artifact.artifact_id,
              location,
              payload_state: 'local_present',
              declared_verification: declared,
              observed_size: file.size,
              satisfies: false,
              reason: 'no expected content hash',
            };
          }
          const actualHash = await sha256File(location);
          const expectedHash = artifact.content_hash.replace(/^sha256:/i, '').toLowerCase();
          return {
            artifact_id: artifact.artifact_id,
            location,
            payload_state: 'local_present',
            declared_verification: declared,
            observed_size: file.size,
            expected_hash: expectedHash,
            observed_hash: actualHash,
            satisfies: actualHash === expectedHash,
            verification_source: 'live_local_file',
          };
        }
        return {
          artifact_id: artifact.artifact_id,
          location,
          payload_state: 'local_present',
          declared_verification: declared,
          satisfies: order.indexOf(declared) >= order.indexOf(level),
          verification_source: 'existing_receipt',
          reason: `${level} requires an external workflow and cannot be inferred from file presence`,
        };
      } catch (error) {
        return {
          artifact_id: artifact.artifact_id,
          location,
          payload_state: payloadState,
          declared_verification: declared,
          satisfies: false,
          reason: artifact.available === false
            ? 'payload is declared unavailable at the recorded remote location; manifest metadata is retained'
            : error instanceof Error ? error.message : String(error),
        };
      }
    });
    return {
      record_id: readback.asset.asset_id,
      revision: readback.revision.revision,
      requested_level: level,
      body_committed: Boolean(readback.revision.body_blob_id),
      artifacts,
      complete: artifacts.every((artifact) => artifact.satisfies),
    };
  }

  async previewForgetProject(projectIdValue: string): Promise<ProjectForgetPreview> {
    await this.ready();
    const projectId = cleanProjectId(projectIdValue);
    if (projectId === 'inbox') throw new Error('Inbox cannot be forgotten');
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (project.status === 'forgotten') throw new Error(`project already forgotten: ${projectId}`);
    const [plans, experiments, decisions, counts, assertionCounts] = await Promise.all([
      this.store.listPlans(projectId),
      this.store.listExperiments(projectId),
      this.store.listDecisions(projectId),
      this.store.counts(projectId),
      this.store.assertionCounts(projectId),
    ]);
    const preview = {
      project_id: projectId,
      name: project.name,
      documents: counts.documents,
      source_entries: counts.sourceEntries,
      records: plans.length + experiments.length + decisions.length
        + assertionCounts.assertions + assertionCounts.corrections,
      sessions: counts.sessions,
    };
    return {
      ...preview,
      confirm_token: createHash('sha256')
        .update(JSON.stringify({ ...preview, updated_at: project.updated_at, counts }))
        .digest('hex')
        .slice(0, 16),
    };
  }

  async forgetProject(projectIdValue: string, confirmToken: string): Promise<ProjectRecord> {
    const preview = await this.previewForgetProject(projectIdValue);
    if (confirmToken !== preview.confirm_token) throw new Error('forget confirmation expired');
    const project = await this.store.getProject(preview.project_id);
    if (!project) throw new Error(`project not found: ${preview.project_id}`);
    const now = new Date().toISOString();
    return await this.store.forgetProject(project.project_id, now);
  }

  async restoreProject(projectIdValue: string): Promise<ProjectRecord> {
    await this.ready();
    const projectId = cleanProjectId(projectIdValue);
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (project.status !== 'forgotten') throw new Error(`project is active: ${projectId}`);
    return await this.store.restoreProject(project.project_id, new Date().toISOString());
  }

  async previewForgetAssertion(
    projectIdValue: string,
    assertionId: string,
  ): Promise<RecordForgetPreview> {
    const assertion = await this.getAssertion(projectIdValue, assertionId);
    if (assertion.status !== 'suggested' && assertion.status !== 'confirmed') {
      throw new Error('assertion is not active');
    }
    const preview = {
      project_id: assertion.project_id,
      target_id: assertion.assertion_id,
      kind: 'assertion' as const,
      evidence: assertion.evidence_ids.length,
    };
    return {
      ...preview,
      confirm_token: createHash('sha256')
        .update(JSON.stringify({ ...preview, status: assertion.status, recorded_at: assertion.recorded_at }))
        .digest('hex')
        .slice(0, 16),
    };
  }

  async forgetAssertion(
    projectIdValue: string,
    assertionId: string,
    confirmToken: string,
  ): Promise<AssertionRecord> {
    const preview = await this.previewForgetAssertion(projectIdValue, assertionId);
    if (preview.confirm_token !== confirmToken) throw new Error('forget confirmation expired');
    const assertion = await this.getAssertion(preview.project_id, preview.target_id);
    return await this.store.updateAssertion({
      ...assertion,
      status: 'forgotten',
      forgotten_from_status: assertion.status as 'suggested' | 'confirmed',
      forgot_at: new Date().toISOString(),
    });
  }

  async restoreAssertion(projectIdValue: string, assertionId: string): Promise<AssertionRecord> {
    const assertion = await this.getAssertion(projectIdValue, assertionId);
    if (assertion.status !== 'forgotten' || !assertion.forgotten_from_status) {
      throw new Error('assertion is active');
    }
    const { forgot_at: _forgotAt, forgotten_from_status: status, ...restored } = assertion;
    return await this.store.updateAssertion({ ...restored, status });
  }

  async getProject(projectIdValue: string): Promise<ProjectDetail> {
    const project = await this.ensureProject(projectIdValue);
    const [
      plans, experiments, decisions, counts, assertionCounts, entityCounts, jobCounts,
      activeSourceSnapshot,
    ] = await Promise.all([
      this.store.listPlans(project.project_id),
      this.store.listExperiments(project.project_id),
      this.store.listDecisions(project.project_id),
      this.store.counts(project.project_id),
      this.store.assertionCounts(project.project_id),
      this.store.entityCounts(project.project_id),
      this.store.knowledgeJobCounts(project.project_id),
      project.active_source_snapshot_id
        ? this.store.getSourceSnapshot(project.active_source_snapshot_id)
        : Promise.resolve(undefined),
    ]);
    return {
      project,
      plans,
      experiments,
      decisions,
      assertion_count: assertionCounts.assertions,
      correction_count: assertionCounts.corrections,
      entity_count: entityCounts.entities,
      entity_operation_count: entityCounts.operations,
      job_counts: jobCounts,
      session_count: counts.sessions,
      search_event_count: counts.searchEvents,
      document_count: counts.documents,
      citation_observation_count: counts.citationObservations,
      source_entry_count: activeSourceSnapshot?.file_count ?? 0,
      ...(activeSourceSnapshot ? { active_source_snapshot: activeSourceSnapshot } : {}),
    };
  }

  async getProjectSummary(projectIdValue: string) {
    const project = await this.ensureProject(projectIdValue);
    const [counts, assertionCounts, entityCounts, jobCounts, activeSourceSnapshot] = await Promise.all([
      this.store.counts(project.project_id),
      this.store.assertionCounts(project.project_id),
      this.store.entityCounts(project.project_id),
      this.store.knowledgeJobCounts(project.project_id),
      project.active_source_snapshot_id
        ? this.store.getSourceSnapshot(project.active_source_snapshot_id)
        : Promise.resolve(undefined),
    ]);
    return {
      project,
      plan_count: counts.plans,
      experiment_count: counts.experiments,
      decision_count: counts.decisions,
      assertion_count: assertionCounts.assertions,
      correction_count: assertionCounts.corrections,
      entity_count: entityCounts.entities,
      entity_operation_count: entityCounts.operations,
      job_counts: jobCounts,
      session_count: counts.sessions,
      search_event_count: counts.searchEvents,
      document_count: counts.documents,
      citation_observation_count: counts.citationObservations,
      source_entry_count: activeSourceSnapshot?.file_count ?? counts.sourceEntries,
      ...(activeSourceSnapshot ? {
        active_source_snapshot: {
          snapshot_id: activeSourceSnapshot.snapshot_id,
          status: activeSourceSnapshot.status,
          file_count: activeSourceSnapshot.file_count,
          searchable_file_count: activeSourceSnapshot.searchable_file_count,
          total_bytes: activeSourceSnapshot.total_bytes,
          created_at: activeSourceSnapshot.created_at,
          activated_at: activeSourceSnapshot.activated_at,
        },
      } : {}),
    };
  }

  async indexProject(input: ProjectIndexInput): Promise<ProjectIndexResult> {
    const projectId = cleanProjectId(input.project_id);
    return await this.locked('db-write', async () => await this.indexProjectLocked({
      ...input,
      project_id: projectId,
    }));
  }

  private async indexProjectLocked(input: ProjectIndexInput): Promise<ProjectIndexResult> {
    const project = await this.ensureProject(input.project_id);
    const activeSnapshot = project.active_source_snapshot_id
      ? await this.store.getSourceSnapshot(project.active_source_snapshot_id)
      : undefined;
    const mode = input.root_mode ?? 'merge';
    const requestedRoots = input.roots ?? [];
    const priorRoots = activeSnapshot?.roots ?? [];
    const roots = mode === 'replace'
      ? requestedRoots
      : mode === 'remove'
        ? priorRoots.filter((root) => !requestedRoots.some((removed) => removed.label === root.label))
        : [...new Map([...priorRoots, ...requestedRoots].map((root) => [root.label, root])).values()];
    if (!roots.length) throw new Error('root update would leave the project without indexed roots');
    const gitRoot = input.git_root ?? activeSnapshot?.git_root;
    const hasExplicitDelta = Boolean(input.changed_paths?.length || input.removed_paths?.length);
    if (hasExplicitDelta && mode !== 'merge') {
      throw new Error('changed_paths and removed_paths require root_mode=merge');
    }
    if (hasExplicitDelta && !activeSnapshot) {
      throw new Error('incremental path sync requires an existing source snapshot');
    }
    const inventory = hasExplicitDelta
      ? await inventoryProjectIncremental({
        roots,
        ...(gitRoot ? { git_root: gitRoot } : {}),
        current: await this.store.listProjectSourceEntries(project.project_id),
        changed_paths: input.changed_paths ?? [],
        removed_paths: input.removed_paths ?? [],
      })
      : await inventoryProject({
        roots,
        ...(gitRoot ? { git_root: gitRoot } : {}),
      });
    const searchable = inventory.records.filter((record) => (
      record.text !== undefined || record.searchable === true
    ) && searchableByPolicy('structured', record.kind, record.tracked));
    const bodies = new Map<string, string>();
    for (const record of searchable) {
      if (record.content_hash && record.text !== undefined) bodies.set(record.content_hash, record.text);
    }
    const now = new Date().toISOString();
    const snapshotId = activeSnapshot?.inventory_digest === inventory.digest
      ? activeSnapshot.snapshot_id
      : `${project.project_id}-${createHash('sha256')
        .update(`${project.active_source_snapshot_id ?? 'root'}\0${inventory.digest}`)
        .digest('hex').slice(0, 16)}`;
    const kinds = Object.fromEntries([...new Set(inventory.records.map((record) => record.kind))]
      .sort().map((kind) => [kind, inventory.records.filter((record) => record.kind === kind).length]));
    const snapshot = {
      snapshot_id: snapshotId,
      project_id: project.project_id,
      inventory_digest: inventory.digest,
      policy: 'structured' as const,
      status: 'indexing' as const,
      file_count: inventory.records.length,
      collection_count: inventory.records.filter((record) => record.entry_type === 'collection').length,
      searchable_file_count: searchable.length,
      unique_body_count: new Set(searchable.map((record) => record.content_hash).filter(Boolean)).size,
      sensitive_file_count: inventory.records.filter((record) => record.sensitive).length,
      unreadable_file_count: inventory.records.filter((record) => record.unreadable).length,
      total_bytes: inventory.records.reduce((sum, record) => sum + record.size, 0),
      kinds,
      root_labels: inventory.roots.map((root) => root.label),
      roots: inventory.roots,
      ...(inventory.git_root ? { git_root: inventory.git_root } : {}),
      ...(inventory.git ? { git: inventory.git } : {}),
      created_at: now,
    };
    const searchableIds = new Set(searchable.map((record) => record.id));
    let job = await this.queueKnowledgeJob({
      project_id: project.project_id,
      kind: 'rebuild',
      source_hash: snapshotId,
      schema_version: 'source-v1',
      algorithm_version: 'inventory-v1',
      affected_source_ids: inventory.records.map((record) => record.id),
    });
    if (job.status === 'done' && activeSnapshot?.snapshot_id !== snapshotId) {
      throw new Error('completed rebuild job has no matching active snapshot');
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      job = await this.transitionKnowledgeJob({
        project_id: project.project_id,
        job_id: job.job_id,
        status: 'queued',
      });
    }
    if (job.status === 'queued') {
      job = await this.transitionKnowledgeJob({
        project_id: project.project_id,
        job_id: job.job_id,
        status: 'running',
      });
    }
    let write;
    try {
      write = await this.store.putSourceSnapshot({
        project,
        snapshot,
        entries: inventory.records.map((record) => ({
          entry_id: record.id,
          project_id: project.project_id,
          snapshot_id: snapshotId,
          root: record.root,
          path: record.path,
          size: record.size,
          modified_ms: record.modified_ms,
          kind: record.kind,
          tracked: record.tracked,
          entry_type: record.entry_type,
          searchable: searchableIds.has(record.id),
          sensitive: record.sensitive,
          unreadable: record.unreadable,
          ...(record.content_hash ? { content_hash: record.content_hash } : {}),
          ...(record.experiment_key ? { experiment_key: record.experiment_key } : {}),
          ...(record.role ? { role: record.role } : {}),
          ...(record.aliases?.length ? { aliases: record.aliases } : {}),
        })),
        bodies: [...bodies].map(([content_hash, text]) => ({ content_hash, text })),
      });
    } catch (error) {
      if (job.status === 'running') {
        try {
          await this.transitionKnowledgeJob({
            project_id: project.project_id,
            job_id: job.job_id,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (transitionError) {
          throw new AggregateError([error, transitionError], 'rebuild and job update failed');
        }
      }
      throw error;
    }
    const added = {
      code: searchable.filter((record) => record.kind === 'source').length,
      experiment: searchable.filter((record) => ['prereg', 'result'].includes(record.kind)).length,
      document: searchable.filter((record) => record.kind === 'report').length,
      config: searchable.filter((record) => record.kind === 'config').length,
      checkpoint: inventory.records.filter((record) => record.kind === 'checkpoint').length,
    };
    const summary = write.reused
      ? `Project: ${project.name} | Stored: no changes`
        : activeSnapshot
        ? `Project: ${project.name} | Stored: added ${write.added}, modified ${write.modified}, removed ${write.removed}`
        : `Project: ${project.name} | Stored: code ${added.code}, experiments ${added.experiment}, documents ${added.document}, configs ${added.config}, checkpoint metadata ${added.checkpoint}`;
    if (!write.reused) {
      await this.invalidateGraph(project.project_id, false);
    }
    if (job.status !== 'done') this.scheduleSourceIndex(job);
    return {
      project_id: project.project_id,
      snapshot_id: snapshotId,
      inventory_digest: inventory.digest,
      policy: 'structured',
      file_count: inventory.records.length,
      collection_count: snapshot.collection_count,
      searchable_file_count: searchable.length,
      unique_body_count: snapshot.unique_body_count,
      sensitive_file_count: snapshot.sensitive_file_count,
      unreadable_file_count: snapshot.unreadable_file_count,
      total_bytes: snapshot.total_bytes,
      ...(inventory.git ? { git: inventory.git } : {}),
      reused: write.reused,
      added_count: write.added,
      modified_count: write.modified,
      removed_count: write.removed,
      job_id: job.job_id,
      job_status: job.status,
      summary,
    };
  }

  async createPlan(input: PlanInput, revise: boolean): Promise<PlanRevisionRecord> {
    const projectId = cleanProjectId(input.project_id);
    return await this.locked(projectId, async () => {
      const project = await this.ensureProject(projectId);
      const plans = await this.store.listPlans(projectId);
      if (revise && plans.length === 0) throw new Error('plan_revise requires an existing plan');
      if (!revise && plans.length > 0) throw new Error('plan_create requires a project without a plan');
      if (input.based_on_experiment_id) {
        const experiment = await this.store.getExperiment(input.based_on_experiment_id);
        if (!experiment || experiment.project_id !== projectId) {
          throw new Error('based_on_experiment_id must belong to the project');
        }
      }
      const revision = plans.length + 1;
      const plan: PlanRevisionRecord = {
        plan_revision_id: `${projectId}-v${revision}`,
        project_id: projectId,
        revision,
        title: cleanText(input.title, 'title', 200),
        body: cleanText(input.body, 'body', 50_000),
        ...(input.change_reason
          ? { change_reason: cleanText(input.change_reason, 'change_reason', 2_000) }
          : {}),
        ...(plans.length ? { parent_revision_id: plans.at(-1)!.plan_revision_id } : {}),
        ...(input.based_on_experiment_id
          ? { based_on_experiment_id: input.based_on_experiment_id }
          : {}),
        ...(cleanTime(input.effective_at, 'effective_at')
          ? { effective_at: cleanTime(input.effective_at, 'effective_at') }
          : {}),
        recorded_at: new Date().toISOString(),
        ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
        ...(input.source_reference
          ? { source_reference: cleanText(input.source_reference, 'source_reference', 2_000) }
          : {}),
        ...(input.missing_fields?.length ? { missing_fields: [...new Set(input.missing_fields)] } : {}),
        created_at: new Date().toISOString(),
      };
      await this.store.putPlan(project, plan);
      await this.writeCatalogRecord({
        project_id: projectId,
        kind: 'plan',
        operation: revision === 1 ? 'create' : 'patch',
        asset_id: `${projectId}:plan`,
        expected_revision: revision - 1,
        idempotency_key: input.idempotency_key ?? `legacy-plan:${plan.plan_revision_id}`,
        body: plan.body,
        fields: {
          title: plan.title,
          plan_revision_id: plan.plan_revision_id,
          change_reason: plan.change_reason,
          based_on_experiment_id: plan.based_on_experiment_id,
        },
        aliases: revision === 1 ? [`${projectId}:master-plan`] : [],
        missing_fields: plan.missing_fields,
        effective_at: plan.effective_at,
        source_sequence: plan.source_sequence,
        source_reference: plan.source_reference,
      });
      await this.invalidateGraph(projectId);
      return plan;
    });
  }

  async startExperiment(input: ExperimentStartInput): Promise<ExperimentRunRecord> {
    const project = await this.ensureProject(input.project_id);
    const planRevisionId = input.plan_revision_id ?? project.active_plan_revision_id;
    if (!planRevisionId) throw new Error('experiment_start requires an active plan revision');
    const plans = await this.store.listPlans(project.project_id);
    if (!plans.some((plan) => plan.plan_revision_id === planRevisionId)) {
      throw new Error('plan_revision_id must belong to the project');
    }
    const experiment: ExperimentRunRecord = {
      experiment_id: randomUUID(),
      project_id: project.project_id,
      plan_revision_id: planRevisionId,
      name: cleanText(input.name, 'name', 200),
      hypothesis: cleanText(input.hypothesis, 'hypothesis', 5_000),
      ...(input.body ? { body: cleanText(input.body, 'body', 4 * 1024 * 1024) } : {}),
      status: 'running',
      ...(input.artifacts?.length ? { artifacts: [...input.artifacts] } : {}),
      ...(cleanTime(input.effective_at, 'effective_at')
        ? { effective_at: cleanTime(input.effective_at, 'effective_at') }
        : {}),
      recorded_at: new Date().toISOString(),
      ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
      ...(input.source_reference
        ? { source_reference: cleanText(input.source_reference, 'source_reference', 2_000) }
        : {}),
      ...(input.missing_fields?.length ? { missing_fields: [...new Set(input.missing_fields)] } : {}),
      started_at: new Date().toISOString(),
    };
    const stored = await this.store.putExperiment(experiment);
    await this.writeCatalogRecord({
      project_id: project.project_id,
      kind: 'experiment',
      operation: 'create',
      asset_id: stored.experiment_id,
      expected_revision: 0,
      idempotency_key: input.idempotency_key ?? `legacy-experiment-start:${stored.experiment_id}`,
      body: stored.body ?? stored.hypothesis,
      fields: {
        name: stored.name,
        hypothesis: stored.hypothesis,
        status: stored.status,
        plan_revision_id: stored.plan_revision_id,
      },
      artifact_references: artifactReferences(stored.artifacts),
      missing_fields: stored.missing_fields,
      effective_at: stored.effective_at,
      source_sequence: stored.source_sequence,
      source_reference: stored.source_reference,
    });
    await this.invalidateGraph(project.project_id);
    return stored;
  }

  async finishExperiment(input: ExperimentFinishInput): Promise<ExperimentRunRecord> {
    const projectId = cleanProjectId(input.project_id);
    const experiment = await this.store.getExperiment(input.experiment_id);
    if (!experiment || experiment.project_id !== projectId) {
      throw new Error('experiment_id must belong to the project');
    }
    if (experiment.status !== 'running') throw new Error('experiment already finished');
    const stored = await this.store.putExperiment({
      ...experiment,
      status: input.status,
      summary: cleanText(input.summary, 'summary', 10_000),
      ...(input.body ? { body: cleanText(input.body, 'body', 4 * 1024 * 1024) } : {}),
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.artifacts?.length
        ? { artifacts: [...(experiment.artifacts ?? []), ...input.artifacts] }
        : {}),
      ...(cleanTime(input.effective_at, 'effective_at')
        ? { effective_at: cleanTime(input.effective_at, 'effective_at') }
        : {}),
      recorded_at: new Date().toISOString(),
      ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
      ...(input.source_reference
        ? { source_reference: cleanText(input.source_reference, 'source_reference', 2_000) }
        : {}),
      ...(input.missing_fields?.length ? { missing_fields: [...new Set(input.missing_fields)] } : {}),
      finished_at: new Date().toISOString(),
    });
    await this.writeCatalogRecord({
      project_id: projectId,
      kind: 'experiment',
      operation: 'patch',
      asset_id: stored.experiment_id,
      expected_revision: 1,
      idempotency_key: input.idempotency_key ?? `legacy-experiment-finish:${stored.experiment_id}`,
      body: stored.body ?? stored.summary,
      fields: {
        name: stored.name,
        hypothesis: stored.hypothesis,
        status: stored.status,
        summary: stored.summary,
        metrics: stored.metrics,
        plan_revision_id: stored.plan_revision_id,
      },
      artifact_references: artifactReferences(input.artifacts),
      missing_fields: stored.missing_fields,
      effective_at: stored.effective_at,
      source_sequence: stored.source_sequence,
      source_reference: stored.source_reference,
    });
    await this.invalidateGraph(projectId);
    return stored;
  }

  async recordDecision(input: DecisionInput): Promise<DecisionRecord> {
    const project = await this.ensureProject(input.project_id);
    const planRevisionId = input.plan_revision_id ?? project.active_plan_revision_id;
    if (planRevisionId) {
      const plans = await this.store.listPlans(project.project_id);
      if (!plans.some((plan) => plan.plan_revision_id === planRevisionId)) {
        throw new Error('plan_revision_id must belong to the project');
      }
    }
    if (input.experiment_id) {
      const experiment = await this.store.getExperiment(input.experiment_id);
      if (!experiment || experiment.project_id !== project.project_id) {
        throw new Error('experiment_id must belong to the project');
      }
    }
    const stored = await this.store.putDecision({
      decision_id: randomUUID(),
      project_id: project.project_id,
      ...(planRevisionId ? { plan_revision_id: planRevisionId } : {}),
      ...(input.experiment_id ? { experiment_id: input.experiment_id } : {}),
      title: cleanText(input.title, 'title', 200),
      summary: cleanText(input.summary, 'summary', 10_000),
      ...(input.body ? { body: cleanText(input.body, 'body', 4 * 1024 * 1024) } : {}),
      ...(cleanTime(input.effective_at, 'effective_at')
        ? { effective_at: cleanTime(input.effective_at, 'effective_at') }
        : {}),
      recorded_at: new Date().toISOString(),
      ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
      ...(input.source_reference
        ? { source_reference: cleanText(input.source_reference, 'source_reference', 2_000) }
        : {}),
      ...(input.missing_fields?.length ? { missing_fields: [...new Set(input.missing_fields)] } : {}),
      created_at: new Date().toISOString(),
    });
    await this.writeCatalogRecord({
      project_id: project.project_id,
      kind: 'decision',
      operation: 'create',
      asset_id: stored.decision_id,
      expected_revision: 0,
      idempotency_key: input.idempotency_key ?? `legacy-decision:${stored.decision_id}`,
      body: stored.body ?? stored.summary,
      fields: {
        title: stored.title,
        summary: stored.summary,
        plan_revision_id: stored.plan_revision_id,
        experiment_id: stored.experiment_id,
      },
      missing_fields: stored.missing_fields,
      effective_at: stored.effective_at,
      source_sequence: stored.source_sequence,
      source_reference: stored.source_reference,
    });
    await this.invalidateGraph(project.project_id);
    return stored;
  }

  async recordOntologyTerm(input: {
    project_id?: string;
    kind: OntologyTermRecord['kind'];
    name: string;
    aliases?: string[];
    version?: number;
    supersedes_term_id?: string;
  }): Promise<OntologyTermRecord> {
    if (input.project_id) await this.ensureProject(input.project_id);
    const name = cleanText(input.name, 'name', 200);
    let prior: OntologyTermRecord | undefined;
    if (input.supersedes_term_id) {
      prior = await this.store.getOntologyTerm(input.supersedes_term_id);
      if (!prior || prior.project_id !== input.project_id || prior.kind !== input.kind) {
        throw new Error('supersedes_term_id must match the ontology scope and kind');
      }
    }
    const version = input.version ?? (prior ? prior.version + 1 : 1);
    if (!Number.isInteger(version) || version < 1) throw new Error('version must be a positive integer');
    if (prior && version <= prior.version) throw new Error('ontology revision version must increase');
    const scope = input.project_id ?? 'core';
    const termId = createHash('sha256')
      .update(`${scope}\0${input.kind}\0${name}\0${version}`)
      .digest('hex')
      .slice(0, 24);
    const term: OntologyTermRecord = {
      term_id: termId,
      ...(input.project_id ? { project_id: input.project_id } : {}),
      kind: input.kind,
      name,
      aliases: [...new Set((input.aliases ?? [])
        .map((alias) => cleanText(alias, 'alias', 200)))].slice(0, 50),
      version,
      status: 'active',
      ...(input.supersedes_term_id ? { supersedes_term_id: input.supersedes_term_id } : {}),
      created_at: new Date().toISOString(),
    };
    await this.store.putOntologyRevision(prior, term);
    const projects = input.project_id
      ? [input.project_id]
      : (await this.store.listProjects()).map((project) => project.project_id);
    await Promise.all(projects.map(async (projectId) => await this.invalidateGraph(projectId)));
    return term;
  }

  async getOntologyTerm(termId: string): Promise<OntologyTermRecord | undefined> {
    await this.ready();
    return await this.store.getOntologyTerm(termId);
  }

  async recordEntity(input: {
    project_id: string;
    kind: string;
    name: string;
    aliases?: string[];
    source: EntityAliasRecord['source'];
    status?: EntityRecord['status'];
  }): Promise<EntityRecord> {
    const project = await this.ensureProject(input.project_id);
    const kind = cleanText(input.kind, 'kind', 100);
    const name = cleanText(input.name, 'name', 1_000);
    const normalizedName = normalizeEntityName(name);
    if (!normalizedName) throw new Error('name has no searchable characters');
    const existingAliases = await this.store.listEntityAliases(project.project_id, normalizedName);
    for (const alias of existingAliases) {
      const existing = await this.store.getEntity(alias.entity_id);
      if (existing && existing.kind === kind && existing.status !== 'merged') return existing;
    }
    const id = entityId(project.project_id, kind, normalizedName);
    const prior = await this.store.getEntity(id);
    if (prior?.status === 'merged') throw new Error('entity name was merged into another entity');
    const now = new Date().toISOString();
    const entity = await this.store.putEntity(prior ?? {
      entity_id: id,
      project_id: project.project_id,
      kind,
      canonical_name: name,
      normalized_name: normalizedName,
      status: input.status ?? (input.source === 'sidecar' ? 'suggested' : 'confirmed'),
      created_at: now,
      updated_at: now,
    });
    const values = [...new Set([name, ...(input.aliases ?? [])]
      .map((alias) => cleanText(alias, 'alias', 2_000)))];
    for (const value of values) {
      const normalizedAlias = normalizeEntityName(value);
      if (!normalizedAlias) continue;
      await this.store.putEntityAlias({
        alias_id: aliasId(project.project_id, entity.entity_id, normalizedAlias),
        project_id: project.project_id,
        entity_id: entity.entity_id,
        alias: value,
        normalized_alias: normalizedAlias,
        source: input.source,
        confidence: input.source === 'sidecar' ? 0.7 : 1,
        status: 'active',
        created_at: now,
      });
    }
    await this.invalidateGraph(project.project_id);
    return entity;
  }

  async linkEntity(
    projectIdValue: string,
    nameValue: string,
    limit = 5,
  ): Promise<EntityLinkCandidate[]> {
    const project = await this.ensureProject(projectIdValue);
    const name = cleanText(nameValue, 'name', 1_000);
    const normalized = normalizeEntityName(name);
    const [entities, aliases] = await Promise.all([
      this.store.listEntities(project.project_id),
      this.store.listEntityAliases(project.project_id, normalized),
    ]);
    return rankEntityCandidates(
      name,
      entities,
      new Set(aliases.map((alias) => alias.entity_id)),
      Math.min(Math.max(limit, 1), 20),
    );
  }

  async getEntity(projectIdValue: string, entityIdValue: string): Promise<EntityRecord> {
    const project = await this.ensureProject(projectIdValue);
    const entity = await this.store.getEntity(entityIdValue);
    if (!entity || entity.project_id !== project.project_id) {
      throw new Error('entity not found in project');
    }
    return entity;
  }

  async mergeEntities(input: {
    project_id: string;
    target_entity_id: string;
    source_entity_ids: string[];
    reason: string;
  }): Promise<{ operation: EntityOperationRecord; entity: EntityRecord }> {
    const project = await this.ensureProject(input.project_id);
    const sourceIds = [...new Set(input.source_entity_ids)];
    if (!sourceIds.length || sourceIds.includes(input.target_entity_id)) {
      throw new Error('source_entity_ids must exclude the target');
    }
    const [target, ...sources] = await Promise.all([
      this.store.getEntity(input.target_entity_id),
      ...sourceIds.map((id) => this.store.getEntity(id)),
    ]);
    if (!target || target.project_id !== project.project_id || target.status === 'merged') {
      throw new Error('target entity must be active in the project');
    }
    if (sources.some((entity) => !entity || entity.project_id !== project.project_id
      || entity.status === 'merged' || entity.kind !== target.kind)) {
      throw new Error('source entities must be active and share the target kind');
    }
    const now = new Date().toISOString();
    const operationId = randomUUID();
    const activeAliases = await this.store.listEntityAliases(project.project_id);
    const targetAliases = new Map(activeAliases.filter((alias) => alias.entity_id === target.entity_id)
      .map((alias) => [alias.normalized_alias, alias]));
    const selected = activeAliases.filter((alias) => sourceIds.includes(alias.entity_id));
    const aliases: EntityAliasRecord[] = [];
    const endedAliases: EntityAliasRecord[] = [];
    for (const alias of selected) {
      let replacement = targetAliases.get(alias.normalized_alias);
      if (!replacement) {
        replacement = {
          ...alias,
          alias_id: `${aliasId(project.project_id, target.entity_id, alias.normalized_alias)}-${operationId.slice(0, 8)}`,
          entity_id: target.entity_id,
          source: 'explicit',
          confidence: 1,
          status: 'active',
          created_at: now,
          ended_at: undefined,
          moved_to_alias_id: undefined,
        };
        aliases.push(replacement);
        targetAliases.set(alias.normalized_alias, replacement);
      }
      endedAliases.push({
        ...alias,
        status: 'moved',
        moved_to_alias_id: replacement.alias_id,
        ended_at: now,
      });
    }
    const entities = [
      { ...target, status: 'confirmed' as const, updated_at: now },
      ...sources.map((entity) => ({
        ...entity!,
        status: 'merged' as const,
        merged_into_entity_id: target.entity_id,
        updated_at: now,
      })),
    ];
    const operation: EntityOperationRecord = {
      operation_id: operationId,
      project_id: project.project_id,
      kind: 'merge',
      source_entity_ids: sourceIds,
      target_entity_id: target.entity_id,
      alias_ids: selected.map((alias) => alias.alias_id),
      reason: cleanText(input.reason, 'reason', 2_000),
      created_at: now,
    };
    await this.store.putEntityOperation({ entities, endedAliases, aliases, operation });
    await this.invalidateGraph(project.project_id);
    return { operation, entity: entities[0] };
  }

  async splitEntity(input: {
    project_id: string;
    source_entity_id: string;
    target_name: string;
    aliases: string[];
    reason: string;
  }): Promise<{ operation: EntityOperationRecord; entity: EntityRecord }> {
    const project = await this.ensureProject(input.project_id);
    const source = await this.store.getEntity(input.source_entity_id);
    if (!source || source.project_id !== project.project_id || source.status === 'merged') {
      throw new Error('source entity must be active in the project');
    }
    const targetName = cleanText(input.target_name, 'target_name', 1_000);
    const requested = new Set(input.aliases.map((alias) => normalizeEntityName(
      cleanText(alias, 'alias', 2_000),
    )));
    if (!requested.size) throw new Error('aliases required');
    const activeAliases = await this.store.listEntityAliases(project.project_id);
    const selected = activeAliases.filter((alias) => alias.entity_id === source.entity_id
      && requested.has(alias.normalized_alias));
    if (selected.length !== requested.size) throw new Error('aliases must belong to the source entity');
    const normalizedName = normalizeEntityName(targetName);
    const targetId = entityId(project.project_id, source.kind, normalizedName);
    if (await this.store.getEntity(targetId)) throw new Error('split target already exists');
    const now = new Date().toISOString();
    const operationId = randomUUID();
    const entity: EntityRecord = {
      entity_id: targetId,
      project_id: project.project_id,
      kind: source.kind,
      canonical_name: targetName,
      normalized_name: normalizedName,
      status: 'confirmed',
      created_at: now,
      updated_at: now,
    };
    const values = new Map<string, string>([[normalizedName, targetName]]);
    for (const alias of selected) values.set(alias.normalized_alias, alias.alias);
    const aliases: EntityAliasRecord[] = [...values].map(([normalizedAlias, alias]) => ({
      alias_id: `${aliasId(project.project_id, targetId, normalizedAlias)}-${operationId.slice(0, 8)}`,
      project_id: project.project_id,
      entity_id: targetId,
      alias,
      normalized_alias: normalizedAlias,
      source: 'explicit',
      confidence: 1,
      status: 'active',
      created_at: now,
    }));
    const replacements = new Map(aliases.map((alias) => [alias.normalized_alias, alias.alias_id]));
    const endedAliases = selected.map((alias) => ({
      ...alias,
      status: 'moved' as const,
      moved_to_alias_id: replacements.get(alias.normalized_alias),
      ended_at: now,
    }));
    const operation: EntityOperationRecord = {
      operation_id: operationId,
      project_id: project.project_id,
      kind: 'split',
      source_entity_ids: [source.entity_id],
      target_entity_id: targetId,
      alias_ids: selected.map((alias) => alias.alias_id),
      reason: cleanText(input.reason, 'reason', 2_000),
      created_at: now,
    };
    await this.store.putEntityOperation({
      entities: [{ ...source, updated_at: now }, entity],
      endedAliases,
      aliases,
      operation,
    });
    await this.invalidateGraph(project.project_id);
    return { operation, entity };
  }

  async recordEvidence(input: EvidenceInput): Promise<EvidenceRecord> {
    const project = await this.ensureProject(input.project_id);
    const sourceId = cleanText(input.source_id, 'source_id', 2_000);
    if (!await this.store.sourceBelongsToProject(project.project_id, input.source_type, sourceId)) {
      throw new Error('evidence source must belong to the project');
    }
    return await this.store.putEvidence({
      evidence_id: randomUUID(),
      project_id: project.project_id,
      source_type: input.source_type,
      source_id: sourceId,
      ...(input.locator ? { locator: cleanText(input.locator, 'locator', 2_000) } : {}),
      ...(input.quote ? { quote: cleanText(input.quote, 'quote', 5_000) } : {}),
      created_at: new Date().toISOString(),
    });
  }

  async recordAssertion(input: AssertionInput): Promise<AssertionRecord> {
    const project = await this.ensureProject(input.project_id);
    const target = cleanAssertionTarget(input);
    const status = input.status ?? 'suggested';
    if (input.source === 'sidecar' && status !== 'suggested') {
      throw new Error('sidecar assertions must start as suggested');
    }
    if (input.confidence !== undefined
      && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new Error('confidence must be between 0 and 1');
    }
    const evidenceIds = [...new Set(input.evidence_ids ?? [])];
    const evidence = await Promise.all(evidenceIds.map((id) => this.store.getEvidence(id)));
    if (evidence.some((row) => !row || row.project_id !== project.project_id)) {
      throw new Error('evidence_ids must belong to the project');
    }
    const validFrom = cleanTime(input.valid_from, 'valid_from');
    const validTo = cleanTime(input.valid_to, 'valid_to');
    if (validFrom && validTo && validFrom > validTo) throw new Error('valid_from must precede valid_to');
    const stored = await this.store.putAssertion({
      assertion_id: randomUUID(),
      project_id: project.project_id,
      subject: cleanText(input.subject, 'subject', 2_000),
      predicate: cleanText(input.predicate, 'predicate', 200),
      ...target,
      status,
      source: input.source,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      evidence_ids: evidenceIds,
      ontology_version: input.ontology_version ?? 1,
      ...(validFrom ? { valid_from: validFrom } : {}),
      ...(validTo ? { valid_to: validTo } : {}),
      recorded_at: new Date().toISOString(),
    });
    await this.invalidateGraph(project.project_id);
    return stored;
  }

  async correctAssertion(input: AssertionCorrectionInput): Promise<{
    correction: AssertionCorrectionRecord;
    assertion: AssertionRecord;
  }> {
    const project = await this.ensureProject(input.project_id);
    const target = await this.store.getAssertion(input.target_assertion_id);
    if (!target || target.project_id !== project.project_id) {
      throw new Error('target_assertion_id must belong to the project');
    }
    if (target.status !== 'suggested' && target.status !== 'confirmed') {
      throw new Error('target assertion is not active');
    }
    let replacementTarget: { object?: string; value?: AssertionValue };
    if (target.object !== undefined) {
      if (typeof input.replacement !== 'string') {
        throw new Error('entity assertion replacement must be a string');
      }
      replacementTarget = { object: cleanText(input.replacement, 'replacement', 2_000) };
    } else {
      replacementTarget = { value: input.replacement };
    }
    if (target.object === replacementTarget.object && target.value === replacementTarget.value) {
      throw new Error('correction must change the assertion');
    }
    const evidenceIds = [...new Set([...(target.evidence_ids ?? []), ...(input.evidence_ids ?? [])])];
    const evidence = await Promise.all(evidenceIds.map((id) => this.store.getEvidence(id)));
    if (evidence.some((row) => !row || row.project_id !== project.project_id)) {
      throw new Error('evidence_ids must belong to the project');
    }
    const validFrom = cleanTime(input.valid_from, 'valid_from') ?? target.valid_from;
    const validTo = cleanTime(input.valid_to, 'valid_to') ?? target.valid_to;
    if (validFrom && validTo && validFrom > validTo) throw new Error('valid_from must precede valid_to');
    const now = new Date().toISOString();
    const replacement: AssertionRecord = {
      assertion_id: randomUUID(),
      project_id: project.project_id,
      subject: target.subject,
      predicate: target.predicate,
      ...replacementTarget,
      status: 'confirmed',
      source: 'explicit',
      evidence_ids: evidenceIds,
      ontology_version: target.ontology_version,
      ...(validFrom ? { valid_from: validFrom } : {}),
      ...(validTo ? { valid_to: validTo } : {}),
      recorded_at: now,
      supersedes_assertion_id: target.assertion_id,
    };
    const correction: AssertionCorrectionRecord = {
      correction_id: randomUUID(),
      project_id: project.project_id,
      target_assertion_id: target.assertion_id,
      replacement_assertion_id: replacement.assertion_id,
      reason: cleanText(input.reason, 'reason', 2_000),
      created_at: now,
    };
    await this.store.putAssertionCorrection({
      ...target,
      status: 'superseded',
      recorded_until: now,
    }, replacement, correction);
    await this.invalidateGraph(project.project_id);
    return { correction, assertion: replacement };
  }

  async getAssertion(projectIdValue: string, assertionId: string): Promise<AssertionRecord> {
    const project = await this.ensureProject(projectIdValue);
    const assertion = await this.store.getAssertion(assertionId);
    if (!assertion || assertion.project_id !== project.project_id) {
      throw new Error('assertion not found in project');
    }
    return assertion;
  }

  async queueKnowledgeJob(input: KnowledgeJobInput): Promise<KnowledgeJobRecord> {
    const project = await this.ensureProject(input.project_id);
    const sourceHash = cleanText(input.source_hash, 'source_hash', 200);
    const schemaVersion = cleanText(input.schema_version, 'schema_version', 500);
    const algorithmVersion = cleanText(input.algorithm_version, 'algorithm_version', 500);
    const key = knowledgeJobKey({
      project_id: project.project_id,
      kind: input.kind,
      source_hash: sourceHash,
      schema_version: schemaVersion,
      algorithm_version: algorithmVersion,
    });
    return await this.locked(`job:${project.project_id}`, async () => {
      const existing = await this.store.getKnowledgeJobByKey(key);
      if (existing) return existing;
      const now = new Date().toISOString();
      return await this.store.putKnowledgeJob({
        job_id: randomUUID(),
        job_key: key,
        project_id: project.project_id,
        kind: input.kind,
        status: 'queued',
        source_hash: sourceHash,
        schema_version: schemaVersion,
        algorithm_version: algorithmVersion,
        affected_source_ids: [...new Set(input.affected_source_ids ?? [])],
        attempts: 0,
        revision: 1,
        created_at: now,
        updated_at: now,
      });
    });
  }

  async transitionKnowledgeJob(input: {
    project_id: string;
    job_id: string;
    status: KnowledgeJobStatus;
    result_digest?: string;
    result_counts?: Record<string, number>;
    error?: string;
  }): Promise<KnowledgeJobRecord> {
    const project = await this.ensureProject(input.project_id);
    return await this.locked(`job-state:${input.job_id}`, async () => {
      const job = await this.store.getKnowledgeJob(input.job_id);
      if (!job || job.project_id !== project.project_id) {
        throw new Error('job_id must belong to the project');
      }
      const allowed: Record<KnowledgeJobStatus, KnowledgeJobStatus[]> = {
        queued: ['running', 'cancelled'],
        running: ['done', 'failed', 'cancelled'],
        done: ['queued'],
        failed: ['queued'],
        cancelled: ['queued'],
      };
      if (!allowed[job.status].includes(input.status)) {
        throw new Error(`invalid job transition: ${job.status} -> ${input.status}`);
      }
      return await this.store.putKnowledgeJob({
        ...job,
        status: input.status,
        attempts: input.status === 'running' ? job.attempts + 1 : job.attempts,
        revision: (job.revision ?? 1) + 1,
        ...(input.result_digest
          ? { result_digest: cleanText(input.result_digest, 'result_digest', 200) }
          : {}),
        ...(input.result_counts ? { result_counts: input.result_counts } : {}),
        ...(input.error ? { error: cleanText(input.error, 'error', 2_000) } : {}),
        updated_at: new Date().toISOString(),
      });
    });
  }

  async ensureMemorySession(
    projectIdValue: string,
    memoryHandle?: string,
    provisionalIntent?: string,
    hostSessionIdValue?: string,
    hostIntentValue?: string,
  ): Promise<{ session: MemorySessionRecord; intent?: IntentRevisionRecord }> {
    const project = await this.ensureProject(projectIdValue);
    const hostSessionId = hostSessionIdValue
      ? cleanText(hostSessionIdValue, 'session_id', 200)
      : undefined;
    const hostIntent = hostIntentValue?.trim();
    const resolvedHandle = memoryHandle
      ?? (hostSessionId ? hostMemoryHandle(project.project_id, hostSessionId) : undefined);
    if (resolvedHandle) {
      const session = await this.store.getMemorySession(resolvedHandle);
      if (!session && memoryHandle) throw new Error('memory_handle must belong to the project');
      if (session) {
        if (session.project_id !== project.project_id
          || (hostSessionId && session.host_session_id && session.host_session_id !== hostSessionId)) {
          throw new Error('memory_handle must belong to the project');
        }
        const revisions = await this.store.listIntentRevisions(resolvedHandle);
        const currentIntent = revisions.at(-1);
        if (hostIntent && currentIntent?.intent !== hostIntent) {
          const updatedSession = {
            ...session,
            continuity: 'host' as const,
            ...(hostSessionId ? { host_session_id: hostSessionId } : {}),
          };
          const intent = await this.appendIntent(updatedSession, hostIntent, 'host', 'confirmed');
          return {
            session: { ...updatedSession, current_intent_revision_id: intent.intent_revision_id },
            intent,
          };
        }
        return { session, intent: currentIntent };
      }
    }

    const now = new Date().toISOString();
    const session = await this.store.putMemorySession({
      memory_handle: resolvedHandle ?? randomUUID(),
      project_id: project.project_id,
      ...(hostSessionId ? { host_session_id: hostSessionId } : {}),
      continuity: hostSessionId ? 'host' : 'request',
      created_at: now,
      updated_at: now,
    });
    const initialIntent = hostIntent || provisionalIntent?.trim();
    if (!initialIntent) return { session };
    const intent = await this.appendIntent(
      session,
      initialIntent,
      hostIntent ? 'host' : 'query',
      hostIntent ? 'confirmed' : 'provisional',
    );
    return { session: { ...session, current_intent_revision_id: intent.intent_revision_id }, intent };
  }

  async recordSessionIntent(input: {
    project_id: string;
    memory_handle?: string;
    intent: string;
    source?: 'explicit' | 'host';
  }): Promise<{ session: MemorySessionRecord; intent: IntentRevisionRecord }> {
    const current = await this.ensureMemorySession(input.project_id, input.memory_handle);
    const session = input.source === 'host'
      ? { ...current.session, continuity: 'host' as const }
      : current.session;
    const intent = await this.appendIntent(
      session,
      input.intent,
      input.source ?? 'explicit',
      'confirmed',
    );
    return {
      session: { ...session, current_intent_revision_id: intent.intent_revision_id },
      intent,
    };
  }

  private async appendIntent(
    session: MemorySessionRecord,
    intentValue: string,
    source: IntentRevisionRecord['source'],
    status: IntentRevisionRecord['status'],
  ): Promise<IntentRevisionRecord> {
    const revisions = await this.store.listIntentRevisions(session.memory_handle);
    const now = new Date().toISOString();
    const revision: IntentRevisionRecord = {
      intent_revision_id: `${session.memory_handle}-v${revisions.length + 1}`,
      memory_handle: session.memory_handle,
      project_id: session.project_id,
      revision: revisions.length + 1,
      intent: cleanText(intentValue, 'intent', 2_000),
      source,
      status,
      created_at: now,
    };
    await this.store.putIntentRevision({
      ...session,
      current_intent_revision_id: revision.intent_revision_id,
      updated_at: now,
    }, revision);
    await this.invalidateGraph(session.project_id);
    return revision;
  }

  private async buildRetrievalItems(projectId: string): Promise<RetrievalIndexItem[]> {
    const [documents, documentChunks, sources, symbols] = await Promise.all([
      this.store.listProjectDocuments(projectId),
      this.store.listProjectDocumentChunks(projectId),
      this.store.listProjectSourceBodies(projectId),
      this.store.listCodeSymbols(projectId),
    ]);
    const symbolNames = new Map<string, string[]>();
    for (const symbol of symbols) {
      const values = symbolNames.get(symbol.source_entry_id) ?? [];
      values.push(symbol.name);
      symbolNames.set(symbol.source_entry_id, values);
    }
    const documentsById = new Map(documents.map((document) => [document.document_id, document]));
    const documentItems: RetrievalIndexItem[] = documentChunks.flatMap((chunk) => {
      const document = documentsById.get(chunk.document_id);
      if (!document || document.state !== 'lexical_active') return [];
      return [{
        item_id: `document:${document.document_id}:${chunk.chunk_index}`,
        project_id: projectId,
        source_family: 'document',
        source_id: document.document_id,
        title: document.title,
        url: document.url,
        content_hash: chunk.content_hash,
        exact_terms: exactTerms(document.title, document.url, document.scholar_id),
        text: chunk.text,
      }];
    });
    const sourceItems: RetrievalIndexItem[] = sources.flatMap((source) => {
      const name = basename(source.path);
      const extension = extname(name);
      const terms = exactTerms(
        `${source.root}/${source.path}`,
        source.path,
        name,
        extension ? name.slice(0, -extension.length) : name,
        ...(source.aliases ?? []),
        ...(symbolNames.get(source.entry_id) ?? []),
      );
      return semanticSourceChunks(source.text).map((chunk, index) => ({
        item_id: `source:${source.entry_id}:${index}`,
        project_id: projectId,
        source_family: 'code',
        source_id: source.entry_id,
        title: `${source.root}/${source.path}`,
        url: `surf://projects/${projectId}/files/${source.entry_id}`,
        content_hash: source.content_hash,
        exact_terms: index === 0 ? terms : [],
        text: chunk.text,
        span_start: chunk.start,
        span_end: chunk.end,
        ...(source.role ? { role: source.role } : {}),
      }));
    });
    return [...documentItems, ...sourceItems];
  }

  private async materializeRetrievalIndex(
    projectId: string,
    sourceFamily: 'document' | 'code',
  ): Promise<KnowledgeJobRecord | undefined> {
    return await this.locked(`retrieval:${projectId}`, async () => (
      await this.materializeRetrievalIndexLocked(projectId, sourceFamily)
    ));
  }

  private async materializeRetrievalIndexLocked(
    projectId: string,
    sourceFamily: 'document' | 'code',
  ): Promise<KnowledgeJobRecord | undefined> {
    const items = (await this.buildRetrievalItems(projectId))
      .filter((item) => item.source_family === sourceFamily);
    const digest = createHash('sha256').update(JSON.stringify(items.map((item) => ({
      item_id: item.item_id,
      content_hash: item.content_hash,
      exact_terms: item.exact_terms,
      text_hash: createHash('sha256').update(item.text).digest('hex'),
    })))).digest('hex');
    const delta = await this.store.planRetrievalItemDelta(projectId, sourceFamily, items);
    const model = this.embeddings.modelId();
    if (!model) {
      await this.store.commitRetrievalGeneration(projectId, sourceFamily, digest, delta);
      return undefined;
    }
    const vectorItems = this.options.vectorBackend === 'compact'
      ? [...items].sort((left, right) => left.item_id.localeCompare(right.item_id))
        .filter((item, index, values) => values.findIndex((row) => row.source_id === item.source_id) === index)
      : items;
    const prunedVectorItemIds = this.options.vectorBackend === 'compact'
      ? (await this.store.listVectorItemIds(projectId, sourceFamily))
        .filter((itemId) => !vectorItems.some((item) => item.item_id === itemId))
      : [];
    const vectorsPruned = prunedVectorItemIds.length;
    const identity = {
      project_id: projectId,
      kind: 'retrieval_index' as const,
      source_hash: digest,
      schema_version: `retrieval-v2-${sourceFamily}-${this.embeddings.dimensions()}`,
      algorithm_version: `${RETRIEVAL_ALGORITHM_VERSION}:${sourceFamily}:${model}:${this.options.vectorBackend ?? 'hnsw'}`,
    };
    let job = await this.queueKnowledgeJob({
      ...identity,
      affected_source_ids: vectorItems.map((item) => item.source_id),
    });
    if (job.status === 'done') {
      if (delta.inserted || delta.updated || delta.removed || prunedVectorItemIds.length) {
        throw new Error('completed retrieval generation does not match current item state');
      }
      return job;
    }
    if (job.status === 'running') {
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'failed',
        error: 'interrupted before completion',
      });
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'queued',
      });
    }
    if (job.status === 'queued') {
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'running',
      });
    }
    try {
      await this.updateKnowledgeJobProgress(projectId, job.job_id, 'embedding', 0, vectorItems.length);
      const states = new Map((await this.store.listRetrievalItemStates(projectId, sourceFamily))
        .map((state) => [state.item_id, state]));
      const pendingItems = vectorItems.filter((item) => {
        const state = states.get(item.item_id);
        return state?.embedding_model !== model || !state.embedding_hash;
      });
      const cacheKeys = pendingItems.map((item) => createHash('sha256')
        .update(stableJson({
          model,
          dimensions: this.embeddings.dimensions(),
          normalization: 'passage-v1',
          role: item.role ?? 'passage',
          text_hash: createHash('sha256').update(item.text).digest('hex'),
        })).digest('hex'));
      const cached = await this.store.cachedEmbeddings(cacheKeys);
      const missing = pendingItems.map((item, index) => ({ item, index, cache_key: cacheKeys[index] }))
        .filter((row) => !cached.has(row.cache_key));
      const generated = await this.embeddings.embedPassages(missing.map((row) => row.item.text));
      if (await this.knowledgeJobCancelled(job.job_id)) throw new Error(`job ${job.job_id} cancelled`);
      await this.store.putCachedEmbeddings(missing.map((row, index) => ({
        cache_key: row.cache_key,
        embedding: generated[index],
      })));
      const generatedByKey = new Map(missing.map((row, index) => [row.cache_key, generated[index]]));
      const vectors = cacheKeys.map((key) => cached.get(key) ?? generatedByKey.get(key)!);
      const currentItems = (await this.buildRetrievalItems(projectId))
        .filter((item) => item.source_family === sourceFamily);
      const currentDigest = createHash('sha256').update(JSON.stringify(currentItems.map((item) => ({
        item_id: item.item_id,
        content_hash: item.content_hash,
        exact_terms: item.exact_terms,
        text_hash: createHash('sha256').update(item.text).digest('hex'),
      })))).digest('hex');
      if (currentDigest !== digest) throw new Error('retrieval source superseded');
      await this.updateKnowledgeJobProgress(
        projectId, job.job_id, 'retrieval_publish', vectorItems.length, vectorItems.length,
      );
      await this.store.commitRetrievalGeneration(
        projectId,
        sourceFamily,
        digest,
        delta,
        pendingItems.map((item, index) => ({ item, embedding: vectors[index] })),
        model,
        prunedVectorItemIds,
      );
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'done',
        result_digest: digest,
        result_counts: {
          retrieval_documents: sourceFamily === 'document' ? items.length : 0,
          retrieval_sources: sourceFamily === 'code' ? items.length : 0,
          retrieval_vectors: pendingItems.length,
          retrieval_vectors_pruned: vectorsPruned,
          retrieval_vectors_reused: vectors.length - missing.length,
          retrieval_items_inserted: delta.inserted,
          retrieval_items_updated: delta.updated,
          retrieval_items_removed: delta.removed,
          retrieval_items_unchanged: delta.unchanged,
        },
      });
      return job;
    } catch (error) {
      const current = await this.store.getKnowledgeJob(job.job_id);
      if (current?.status === 'running') {
        await this.transitionKnowledgeJob({
          project_id: projectId,
          job_id: job.job_id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async *codeSourceBatches(
    projectId: string,
    entries: CodeSourceManifestEntry[],
    loaded: { count: number },
  ): AsyncGenerator<CodeSourceInput[]> {
    let batch: CodeSourceManifestEntry[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (batch.length && bytes + entry.size > 8 * 1024 * 1024) {
        const sources = await this.store.loadCodeSourceBodies(batch);
        loaded.count += sources.length;
        yield sources.map((source) => ({ project_id: projectId, ...source }));
        batch = [];
        bytes = 0;
      }
      batch.push(entry);
      bytes += entry.size;
    }
    if (batch.length) {
      const sources = await this.store.loadCodeSourceBodies(batch);
      loaded.count += sources.length;
      yield sources.map((source) => ({ project_id: projectId, ...source }));
    }
  }

  private async materializeCodeStructure(
    projectId: string,
    snapshotId: string,
  ): Promise<KnowledgeJobRecord> {
    return await this.locked(`code:${projectId}`, async () => {
      const project = await this.store.getProject(projectId);
      if (project?.active_source_snapshot_id !== snapshotId) throw new Error('source snapshot superseded');
      const entries = await this.store.listCodeSourceEntries(projectId);
      let job = await this.locked('db-write', async () => {
        let current = await this.queueKnowledgeJob({
          project_id: projectId,
          kind: 'schema_link',
          source_hash: snapshotId,
          schema_version: 'code-v1',
          algorithm_version: CODE_ALGORITHM_VERSION,
          affected_source_ids: entries.map((entry) => entry.entry_id),
        });
        if (current.status === 'running') {
          current = await this.transitionKnowledgeJob({
            project_id: projectId,
            job_id: current.job_id,
            status: 'failed',
            error: 'interrupted before completion',
          });
        }
        if (current.status === 'failed' || current.status === 'cancelled') {
          current = await this.transitionKnowledgeJob({
            project_id: projectId,
            job_id: current.job_id,
            status: 'queued',
          });
        }
        if (current.status === 'queued') {
          current = await this.transitionKnowledgeJob({
            project_id: projectId,
            job_id: current.job_id,
            status: 'running',
          });
        }
        return current;
      });
      if (job.status === 'done') return job;
      try {
        await this.updateKnowledgeJobProgress(projectId, job.job_id, 'code_parse', 0, entries.length);
        const loaded = { count: 0 };
        const structure = await runCodeStructureBatchStream(
          this.codeSourceBatches(projectId, entries, loaded),
        );
        if (await this.knowledgeJobCancelled(job.job_id)) throw new Error(`job ${job.job_id} cancelled`);
        const deferred = entries.length - loaded.count;
        await this.updateKnowledgeJobProgress(projectId, job.job_id, 'code_publish', loaded.count, entries.length);
        job = await this.locked('db-write', async () => {
          const current = await this.store.getProject(projectId);
          if (current?.active_source_snapshot_id !== snapshotId) {
            throw new Error('source snapshot superseded');
          }
          const codeSnapshotId = `${snapshotId}-${createHash('sha256')
            .update(CODE_ALGORITHM_VERSION).digest('hex').slice(0, 12)}`;
          await this.store.replaceCodeStructure(
            projectId,
            codeSnapshotId,
            structure.symbols,
            structure.relations,
          );
          await this.invalidateGraph(projectId, false);
          const completed = await this.transitionKnowledgeJob({
            project_id: projectId,
            job_id: job.job_id,
            status: 'done',
            result_digest: createHash('sha256')
              .update(`${structure.symbols.length}\0${structure.relations.length}\0${deferred}`)
              .digest('hex'),
            result_counts: {
              code_sources: loaded.count,
              code_sources_deferred: deferred,
              code_symbols: structure.symbols.length,
              code_relations: structure.relations.length,
            },
          });
          this.schedule(async () => await this.store.pruneCodeStructure(projectId, codeSnapshotId));
          return completed;
        });
        return job;
      } catch (error) {
        await this.locked('db-write', async () => {
          const current = await this.store.getKnowledgeJob(job.job_id);
          if (current?.status === 'running') {
            await this.transitionKnowledgeJob({
              project_id: projectId,
              job_id: job.job_id,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        throw error;
      }
    });
  }

  async rebuildDerivedState(projectIdValue: string): Promise<{
    project_id: string;
    source_snapshot_id: string;
    code_job: KnowledgeJobSummary;
    retrieval_jobs?: KnowledgeJobSummary[];
    graph_job: KnowledgeJobSummary;
    projection_id: string;
    code_sources: number;
    code_sources_deferred: number;
    code_elapsed_ms: number;
    retrieval_elapsed_ms?: number;
    graph_elapsed_ms: number;
    graph_export_ms: number;
    graph_analysis_ms: number;
    graph_publish_ms: number;
    elapsed_ms: number;
  }> {
    const started = Date.now();
    const project = await this.ensureProject(projectIdValue);
    if (!project.active_source_snapshot_id) throw new Error('project has no source snapshot');
    const codeIdentity = {
      project_id: project.project_id,
      kind: 'schema_link' as const,
      source_hash: project.active_source_snapshot_id,
      schema_version: 'code-v1',
      algorithm_version: CODE_ALGORITHM_VERSION,
    };
    const [existingCodeJob, currentGraph, latestGraphJob] = await Promise.all([
      this.store.getKnowledgeJobByKey(knowledgeJobKey(codeIdentity)),
      this.store.currentGraph(project.project_id),
      this.store.latestKnowledgeJob(project.project_id, 'graph_projection'),
    ]);
    const currentGraphArtifact = currentGraph.current && currentGraph.projection_id
      ? await this.store.validateGraphArtifact(currentGraph.projection_id)
      : false;
    if (!this.embeddings.enabled()
      && existingCodeJob?.status === 'done' && existingCodeJob.result_counts
      && currentGraph.current && currentGraph.projection_id
      && currentGraphArtifact
      && latestGraphJob?.status === 'done'
      && latestGraphJob.algorithm_version === GRAPH_ALGORITHM_VERSION
      && latestGraphJob.result_digest === currentGraph.projection_id) {
      return {
        project_id: project.project_id,
        source_snapshot_id: project.active_source_snapshot_id,
        code_job: {
          job_id: existingCodeJob.job_id,
          status: existingCodeJob.status,
          attempts: existingCodeJob.attempts,
        },
        graph_job: {
          job_id: latestGraphJob.job_id,
          status: latestGraphJob.status,
          attempts: latestGraphJob.attempts,
        },
        projection_id: currentGraph.projection_id,
        code_sources: existingCodeJob.result_counts.code_sources ?? 0,
        code_sources_deferred: existingCodeJob.result_counts.code_sources_deferred ?? 0,
        code_elapsed_ms: 0,
        graph_elapsed_ms: 0,
        graph_export_ms: 0,
        graph_analysis_ms: 0,
        graph_publish_ms: 0,
        elapsed_ms: Date.now() - started,
      };
    }
    let codeJob = existingCodeJob;
    let codeSources = existingCodeJob?.result_counts?.code_sources ?? 0;
    let codeSourcesDeferred = existingCodeJob?.result_counts?.code_sources_deferred ?? 0;
    let codeElapsedMs = 0;
    if (codeJob?.status !== 'done' || !codeJob.result_counts) {
      const codeStarted = Date.now();
      codeJob = await this.materializeCodeStructure(
        project.project_id,
        project.active_source_snapshot_id,
      );
      codeSources = codeJob.result_counts?.code_sources ?? 0;
      codeSourcesDeferred = codeJob.result_counts?.code_sources_deferred ?? 0;
      codeElapsedMs = Date.now() - codeStarted;
    }
    if (!codeJob) throw new Error('code structure job unavailable');
    const retrievalStarted = Date.now();
    const retrievalJobs = (await Promise.all([
      this.materializeRetrievalIndex(project.project_id, 'document'),
      this.materializeRetrievalIndex(project.project_id, 'code'),
    ])).flatMap((job) => job ? [{
      job_id: job.job_id,
      status: job.status,
      attempts: job.attempts,
    }] : []);
    const retrievalElapsedMs = Date.now() - retrievalStarted;
    const graphStarted = Date.now();
    const graph = await this.materializeGraph([project.project_id]);
    const graphElapsedMs = Date.now() - graphStarted;
    return {
      project_id: project.project_id,
      source_snapshot_id: project.active_source_snapshot_id,
      code_job: {
        job_id: codeJob.job_id,
        status: codeJob.status,
        attempts: codeJob.attempts,
      },
      ...(retrievalJobs.length ? { retrieval_jobs: retrievalJobs } : {}),
      graph_job: {
        job_id: graph.job.job_id,
        status: graph.job.status,
        attempts: graph.job.attempts,
      },
      projection_id: graph.projection.projection_id,
      code_sources: codeSources,
      code_sources_deferred: codeSourcesDeferred,
      code_elapsed_ms: codeElapsedMs,
      ...(retrievalJobs.length ? { retrieval_elapsed_ms: retrievalElapsedMs } : {}),
      graph_elapsed_ms: graphElapsedMs,
      graph_export_ms: graph.timings.export_ms,
      graph_analysis_ms: graph.timings.analysis_ms,
      graph_publish_ms: graph.timings.publish_ms,
      elapsed_ms: Date.now() - started,
    };
  }

  async exportGraphProjection(projectIdValues: string[]): Promise<GraphProjection> {
    const projectIds = [...new Set(projectIdValues.map(cleanProjectId))].sort();
    if (!projectIds.length) throw new Error('at least one project_id required');
    const key = projectIds.join('\0');
    const cached = this.graphCache.get(key);
    if (cached) return this.rememberGraphProjection(key, cached);
    const sources = await Promise.all(projectIds.map(async (projectId): Promise<ProjectGraphSource> => {
      const project = await this.ensureProject(projectId);
      const [
        sourceSnapshots, sourceEntries, documents, plans, experiments, decisions, sessions, intents, entities,
        aliases, ontologyTerms, evidence, assertions, symbols, codeRelations, catalog,
      ] = await Promise.all([
        this.store.listProjectSourceSnapshots(projectId),
        this.store.listProjectSourceEntries(projectId),
        this.store.listProjectDocuments(projectId),
        this.store.listPlans(projectId),
        this.store.listExperiments(projectId),
        this.store.listDecisions(projectId),
        this.store.listProjectSessions(projectId),
        this.store.listProjectIntents(projectId),
        this.store.listEntities(projectId),
        this.store.listEntityAliases(projectId),
        this.store.listOntologyTerms(projectId),
        this.store.listEvidence(projectId),
        this.store.listAssertions(projectId),
        this.store.listCodeSymbols(projectId),
        this.store.listCodeRelations(projectId),
        this.store.listCatalogGraphRecords(projectId),
      ]);
      return {
        project,
        source_snapshots: sourceSnapshots,
        source_entries: sourceEntries,
        documents,
        plans,
        experiments,
        decisions,
        sessions,
        intents,
        entities,
        aliases,
        ontology_terms: ontologyTerms,
        evidence,
        assertions,
        symbols,
        code_relations: codeRelations,
        catalog_assets: catalog.assets,
        catalog_revisions: catalog.revisions,
      };
    }));
    const projection = buildGraphProjection(sources);
    return this.rememberGraphProjection(key, projection);
  }

  async exportVisualization(input: {
    project_id?: string;
    include_project_ids?: string[];
    all_projects?: boolean;
    format: GraphVisualizationFormat;
    view: GraphVisualizationView;
  }): Promise<{
    format: GraphVisualizationFormat;
    view: GraphVisualizationView;
    projection_id: string;
    project_ids: string[];
    node_count: number;
    edge_count: number;
    path: string;
    files?: string[];
    bytes: number;
    sha256: string;
  }> {
    await this.ready();
    if (input.all_projects && (input.project_id || input.include_project_ids?.length)) {
      throw new Error('all_projects cannot be combined with project_id or include_project_ids');
    }
    const requested = input.all_projects
      ? (await this.listProjects())
        .filter((project) => project.status !== 'forgotten' && project.project_id !== 'inbox')
        .map((project) => project.project_id)
      : [input.project_id, ...(input.include_project_ids ?? [])]
        .filter((projectId): projectId is string => !!projectId);
    const projectIds = [...new Set(requested.map(cleanProjectId))].sort();
    if (!projectIds.length) {
      throw new Error('project_id, include_project_ids, or all_projects=true required');
    }
    await Promise.all(projectIds.map(async (projectId) => await this.ensureProject(projectId)));
    const projection = await this.exportGraphProjection(projectIds);
    const analysis = await runGraphSidecar(projection);
    const scope = projectIds.length === 1
      ? projectIds[0]
      : `combined-${createHash('sha256').update(projectIds.join('\0')).digest('hex').slice(0, 12)}`;
    const exportRoot = resolve(this.options.root, 'exports');
    if (input.format === 'neo4j') {
      const exported = exportNeo4jVisualization(projection, analysis, input.view);
      const path = resolve(
        exportRoot,
        `${scope}-${input.view}-${projection.projection_id}-neo4j`,
      );
      await mkdir(path, { recursive: true });
      const files: string[] = [];
      const digest = createHash('sha256');
      let bytes = 0;
      for (const file of exported.files) {
        const target = resolve(path, file.name);
        const temporaryPath = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(temporaryPath, file.content, 'utf8');
          await rename(temporaryPath, target);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        files.push(target);
        bytes += Buffer.byteLength(file.content);
        digest.update(file.name).update('\0').update(file.content).update('\0');
      }
      return {
        format: input.format,
        view: input.view,
        projection_id: projection.projection_id,
        project_ids: projectIds,
        node_count: exported.node_count,
        edge_count: exported.edge_count,
        path,
        files,
        bytes,
        sha256: digest.digest('hex'),
      };
    }
    const exported = input.format === 'html'
      ? exportInteractiveGraphVisualization(projection, analysis, input.view)
      : exportGraphVisualization(projection, analysis, input.format, input.view);
    const extension = input.format === 'dot' ? 'dot' : input.format === 'html' ? 'html' : 'json';
    const path = resolve(
      exportRoot,
      `${scope}-${input.view}-${projection.projection_id}.${extension}`,
    );
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(exportRoot, { recursive: true });
    try {
      await writeFile(temporaryPath, exported.content, 'utf8');
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return {
      format: input.format,
      view: input.view,
      projection_id: projection.projection_id,
      project_ids: projectIds,
      node_count: exported.node_count,
      edge_count: exported.edge_count,
      path,
      bytes: Buffer.byteLength(exported.content),
      sha256: createHash('sha256').update(exported.content).digest('hex'),
    };
  }

  async materializeGraph(projectIdValues: string[]): Promise<{
    projection: GraphProjection;
    analysis?: GraphAnalysis;
    job: KnowledgeJobRecord;
    timings: { export_ms: number; analysis_ms: number; publish_ms: number };
  }> {
    for (const projectId of projectIdValues) {
      const pending = this.graphTimers.get(projectId);
      if (pending) clearTimeout(pending);
      this.graphTimers.delete(projectId);
    }
    const key = [...new Set(projectIdValues)].sort().join('\0');
    return await this.locked(`graph:${key}`, async () => (
      await this.materializeGraphLocked(projectIdValues)
    ));
  }

  private async completeGraphJobs(
    projection: GraphProjection,
    resultCounts: Record<string, number>,
  ): Promise<Map<string, KnowledgeJobRecord>> {
    const jobs = new Map<string, KnowledgeJobRecord>();
    for (const projectId of projection.project_ids) {
      let job = await this.queueKnowledgeJob({
        project_id: projectId,
        kind: 'graph_projection',
        source_hash: projection.source_hash,
        schema_version: projection.schema_version,
        algorithm_version: GRAPH_ALGORITHM_VERSION,
        affected_source_ids: [],
      });
      if (job.status === 'failed' || job.status === 'cancelled') {
        job = await this.transitionKnowledgeJob({
          project_id: projectId,
          job_id: job.job_id,
          status: 'queued',
        });
      }
      if (job.status === 'queued') {
        job = await this.transitionKnowledgeJob({
          project_id: projectId,
          job_id: job.job_id,
          status: 'running',
        });
      }
      if (job.status === 'running') {
        job = await this.transitionKnowledgeJob({
          project_id: projectId,
          job_id: job.job_id,
          status: 'done',
          result_digest: projection.projection_id,
          result_counts: resultCounts,
        });
      }
      jobs.set(projectId, job);
    }
    return jobs;
  }

  private async materializeGraphLocked(projectIdValues: string[]): Promise<{
    projection: GraphProjection;
    analysis?: GraphAnalysis;
    job: KnowledgeJobRecord;
    timings: { export_ms: number; analysis_ms: number; publish_ms: number };
  }> {
    const exportStarted = Date.now();
    const projection = await this.exportGraphProjection(projectIdValues);
    const exportMs = Date.now() - exportStarted;
    const owner = projection.project_ids[0];
    let job = await this.queueKnowledgeJob({
      project_id: owner,
      kind: 'graph_projection',
      source_hash: projection.source_hash,
      schema_version: projection.schema_version,
      algorithm_version: GRAPH_ALGORITHM_VERSION,
      affected_source_ids: [],
    });
    if (job.status === 'done') {
      const reusable = await this.store.validateGraphArtifact(projection.projection_id, false);
      if (reusable) {
        const artifact = await this.store.loadGraphArtifact(projection.projection_id, false);
        if (!artifact) throw new Error('validated graph artifact unavailable');
        const publishStarted = Date.now();
        await this.store.publishGraphProjection(projection, artifact.analysis);
        this.rememberGraphArtifact(projection.projection_id, artifact);
        const jobs = await this.completeGraphJobs(projection, {
          graph_nodes: projection.nodes.length,
          graph_edges: projection.edges.length,
          graph_communities: artifact.analysis.community_count ?? 0,
        });
        return {
          projection,
          job: jobs.get(owner)!,
          timings: {
            export_ms: exportMs,
            analysis_ms: 0,
            publish_ms: Date.now() - publishStarted,
          },
        };
      }
      job = await this.transitionKnowledgeJob({
        project_id: owner,
        job_id: job.job_id,
        status: 'queued',
      });
    }
    if (job.status === 'running') {
      job = await this.transitionKnowledgeJob({
        project_id: owner,
        job_id: job.job_id,
        status: 'failed',
        error: 'interrupted before completion',
      });
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      job = await this.transitionKnowledgeJob({
        project_id: owner,
        job_id: job.job_id,
        status: 'queued',
      });
    }
    if (job.status === 'queued') {
      job = await this.transitionKnowledgeJob({
        project_id: owner,
        job_id: job.job_id,
        status: 'running',
      });
    }
    try {
      const analysisStarted = Date.now();
      await this.updateKnowledgeJobProgress(owner, job.job_id, 'graph_analysis', 0, projection.nodes.length);
      const analysis = await runGraphSidecar(projection);
      if (await this.knowledgeJobCancelled(job.job_id)) throw new Error(`job ${job.job_id} cancelled`);
      const analysisMs = Date.now() - analysisStarted;
      const publishStarted = Date.now();
      await this.updateKnowledgeJobProgress(
        owner, job.job_id, 'graph_publish', projection.nodes.length, projection.nodes.length,
      );
      await this.store.publishGraphProjection(projection, analysis);
      this.rememberGraphArtifact(projection.projection_id, { projection, analysis });
      const publishMs = Date.now() - publishStarted;
      const jobs = await this.completeGraphJobs(projection, {
        graph_nodes: projection.nodes.length,
        graph_edges: projection.edges.length,
        graph_communities: analysis.community_count ?? 0,
      });
      return {
        projection,
        analysis,
        job: jobs.get(owner)!,
        timings: { export_ms: exportMs, analysis_ms: analysisMs, publish_ms: publishMs },
      };
    } catch (error) {
      const current = await this.store.getKnowledgeJob(job.job_id);
      if (current?.status === 'running') {
        await this.transitionKnowledgeJob({
          project_id: owner,
          job_id: job.job_id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async traverseMaterializedGraph(
    projectionId: string,
    seeds: string[],
    hops: number,
  ): Promise<string[]> {
    await this.ready();
    if (!Number.isInteger(hops) || hops < 1 || hops > 8) throw new Error('hops must be 1..8');
    const artifact = this.graphArtifacts.get(projectionId)
      ?? await this.store.loadGraphArtifact(projectionId);
    if (!artifact) return [];
    this.rememberGraphArtifact(projectionId, artifact);
    const adjacency = new Map<string, Set<string>>();
    for (const edge of artifact.projection.edges) {
      if (!isRetrievalGraphEdge(edge)) continue;
      const source = adjacency.get(edge.source) ?? new Set<string>();
      source.add(edge.target);
      adjacency.set(edge.source, source);
      const target = adjacency.get(edge.target) ?? new Set<string>();
      target.add(edge.source);
      adjacency.set(edge.target, target);
    }
    const visited = new Set(seeds);
    let frontier = [...seeds];
    for (let hop = 0; hop < hops && frontier.length; hop++) {
      const next = new Set<string>();
      for (const node of frontier) {
        for (const neighbor of adjacency.get(node) ?? []) {
          if (!visited.has(neighbor)) next.add(neighbor);
        }
      }
      for (const node of next) visited.add(node);
      frontier = [...next];
    }
    return [...visited];
  }

  private async searchMaterializedGraph(
    project: ProjectRecord,
    query: string,
    limit: number,
    seedHits: LocalSearchHit[] = [],
  ): Promise<LocalSearchHit[]> {
    const current = await this.store.currentGraph(project.project_id);
    if (!current.current || !current.projection_id) return [];
    const artifact = this.graphArtifacts.get(current.projection_id)
      ?? await this.store.loadGraphArtifact(current.projection_id);
    if (!artifact) return [];
    const remembered = this.rememberGraphArtifact(current.projection_id, artifact);
    const seeds = graphSeedNodes(remembered.projection, seedHits.flatMap((hit) => (
      [hit.document_id, hit.url]
    )));
    return this.graphSearchHits(
      remembered.projection,
      query,
      limit,
      new Set([project.project_id]),
      remembered.analysis.pagerank,
      seeds,
    );
  }

  private graphSearchHits(
    projection: GraphProjection,
    query: string,
    limit: number,
    projectIds: Set<string>,
    pagerank: Record<string, number> = {},
    seeds: string[] = [],
  ): LocalSearchHit[] {
    return rankGraphProjection(projection, query, limit * 5, seeds)
      .filter(({ node }) => projectIds.has(node.project_id))
      .slice(0, limit)
      .map(({ node, score }) => ({
        document_id: node.source_id ?? node.node_id,
        ...(node.record_id ? { record_id: node.record_id, body_handle: node.record_id } : {}),
        ...(node.revision_id ? { revision_id: node.revision_id } : {}),
        title: node.label,
        url: node.url ?? `surf://projects/${node.project_id}/graph/${node.node_id}`,
        description: (node.text ?? node.label).slice(0, 500),
        content: node.text ?? node.label,
        score: score + (pagerank[node.node_id] ?? 0),
        project_ids: [node.project_id],
        source_family: node.kind === 'source' || node.kind === 'symbol'
          ? 'code' as const
          : 'graph' as const,
        retrieval_family: 'graph' as const,
        kind: node.kind,
      }));
  }

  private async searchCombinedGraph(
    projects: ProjectRecord[],
    query: string,
    limit: number,
    seedHits: LocalSearchHit[] = [],
  ): Promise<LocalSearchHit[]> {
    const projectIds = projects.map((project) => project.project_id);
    const projection = await this.exportGraphProjection(projectIds);
    const seeds = graphSeedNodes(projection, seedHits.flatMap((hit) => [hit.document_id, hit.url]));
    return this.graphSearchHits(projection, query, limit, new Set(projectIds), {}, seeds);
  }

  async searchFamilies(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
    preparedQueryVector?: number[],
    includeGraph = true,
    signal?: AbortSignal,
    filters?: ResearchSearchFilters,
  ): Promise<LocalSearchFamilies> {
    ensureNotAborted(signal);
    const degradedLanes = new Set<RetrievalLane>();
    const projectIds = [...new Set([projectIdValue, ...includeProjectIds])];
    const projects = await Promise.all(projectIds.map((projectId) => this.ensureProject(projectId)));
    const cleanedQuery = cleanText(query, 'query', 400);
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const lanes = new Set(filters?.retrieval_lanes ?? ['exact', 'bm25', 'vector', 'graph']);
    const [exactGroups, bm25Groups, queryVector] = await Promise.all([
      lanes.has('exact') ? mapConcurrent(projects, 1, async (project) => await runRetrievalLane(
        'exact',
        degradedLanes,
        async () => await this.store.searchProjectExact(
          project.project_id,
          normalizeEntityName(cleanedQuery),
          cappedLimit,
        ),
      )) : Promise.resolve(projects.map(() => [] as LocalSearchHit[])),
      lanes.has('bm25') ? mapConcurrent(projects, 1, async (project) => await runRetrievalLane(
        'bm25',
        degradedLanes,
        async () => await this.store.searchProjectBm25(project.project_id, cleanedQuery, cappedLimit),
      )) : Promise.resolve(projects.map(() => [] as LocalSearchHit[])),
      lanes.has('vector') && preparedQueryVector
        ? Promise.resolve(preparedQueryVector)
        : lanes.has('vector') && this.embeddings.enabled()
        ? this.embeddings.embedQuery(cleanedQuery).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const model = this.embeddings.modelId();
    const vectorGroups = queryVector && model
      ? await mapConcurrent(projects, 1, async (project) => {
        try {
          return await this.store.searchProjectVector(
            project.project_id,
            model,
            queryVector,
            cappedLimit,
          );
        } catch {
          degradedLanes.add('vector');
          return [];
        }
      })
      : [];
    ensureNotAborted(signal);
    const seedGroups = projects.map((_project, index) => fuseRankedGroups([
      exactGroups[index] ?? [],
      bm25Groups[index] ?? [],
      vectorGroups[index] ?? [],
    ], cappedLimit));
    const graphGroups = !includeGraph || !lanes.has('graph') ? [] : projects.length > 1
      ? [await runRetrievalLane(
        'graph',
        degradedLanes,
        async () => await this.searchCombinedGraph(
          projects,
          cleanedQuery,
          cappedLimit,
          seedGroups.flat(),
        ),
      )]
      : await mapConcurrent(projects, 1, async (project, index) => await runRetrievalLane(
        'graph',
        degradedLanes,
        async () => await this.searchMaterializedGraph(
          project,
          cleanedQuery,
          cappedLimit,
          seedGroups[index],
        ),
      ));
    ensureNotAborted(signal);
    return {
      exact: filterSearchHits(fuseRankedGroups(exactGroups, cappedLimit, 'exact'), filters),
      bm25: filterSearchHits(fuseRankedGroups(bm25Groups, cappedLimit, 'bm25'), filters),
      vector: filterSearchHits(fuseRankedGroups(vectorGroups, cappedLimit, 'vector'), filters),
      graph: filterSearchHits(fuseRankedGroups(graphGroups, cappedLimit, 'graph'), filters),
      degraded_lanes: [...degradedLanes].sort(),
    };
  }

  async search(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
    signal?: AbortSignal,
    filters?: ResearchSearchFilters,
  ): Promise<LocalSearchHit[]> {
    return (await this.searchBatch(
      projectIdValue,
      query,
      [],
      limit,
      includeProjectIds,
      signal,
      filters,
    )).results;
  }

  async searchBatch(
    projectIdValue: string,
    query: string,
    queryVariants: string[],
    limit: number,
    includeProjectIds: string[] = [],
    signal?: AbortSignal,
    filters?: ResearchSearchFilters,
    rerank = true,
    includePreRerank = false,
  ): Promise<{
    request_id: string;
    queries: string[];
    results: LocalSearchHit[];
    pre_rerank_results?: LocalSearchHit[];
    graph_project_count: number;
    degraded_lanes: RetrievalLane[];
    timings: { embedding_ms: number; retrieval_ms: number; rerank_ms: number };
    candidate_counts: { exact: number; bm25: number; vector: number; graph: number; fused: number };
  }> {
    const started = performance.now();
    const requestId = randomUUID();
    ensureNotAborted(signal);
    const degradedLanes = new Set<RetrievalLane>();
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const candidateLimit = Math.min(40, cappedLimit * 3);
    const queries = tuneLocalQueries(query, queryVariants);
    const candidateCounts = { exact: 0, bm25: 0, vector: 0, graph: 0, fused: 0 };
    let vectors: Array<number[] | undefined> = queries.map(() => undefined);
    if (this.embeddings.enabled()) {
      try {
        const generated = this.embeddings.embedQueries
          ? await this.embeddings.embedQueries(queries)
          : await Promise.all(queries.map(async (value) => await this.embeddings.embedQuery(value)));
        vectors = generated;
      } catch {}
    }
    ensureNotAborted(signal);
    const embedded = performance.now();
    const queryGroups = await mapConcurrent(queries, 2, async (value, index) => {
      const families = await this.searchFamilies(
        projectIdValue,
        value,
        candidateLimit,
        includeProjectIds,
        vectors[index],
        false,
        signal,
        filters,
      );
      candidateCounts.exact += families.exact.length;
      candidateCounts.bm25 += families.bm25.length;
      candidateCounts.vector += families.vector.length;
      for (const lane of families.degraded_lanes) degradedLanes.add(lane);
      const groups = [families.exact, families.bm25, families.vector, families.graph];
      return {
        bounded: groups.map((rows) => rows.slice(0, cappedLimit)),
        expanded: groups,
      };
    });
    const boundedBaseFused = fuseRankedGroups(
      queryGroups.flatMap((group) => group.bounded),
      cappedLimit,
    );
    const baseFused = fuseRankedGroups(
      queryGroups.flatMap((group) => group.expanded),
      candidateLimit,
    );
    ensureNotAborted(signal);
    const projectIds = [...new Set([projectIdValue, ...includeProjectIds])];
    let projects: ProjectRecord[] = [];
    let graph: LocalSearchHit[] = [];
    try {
      const seededProjects = new Set(baseFused.flatMap((row) => row.project_ids));
      if (!seededProjects.size) {
        await this.store.ensureGraphSearchIndexes(projectIds);
        const graphSeeds = await this.store.searchGraphSeeds(projectIds, queries, candidateLimit);
        for (const seed of graphSeeds) {
          seededProjects.add(seed.project_id);
          if (seededProjects.size >= 4) break;
        }
        if (!seededProjects.size) {
          for (const projectId of await this.store.searchMemorySeedProjects(projectIds, queries, 4)) {
            seededProjects.add(projectId);
          }
        }
      }
      const selectedProjects = projectIds.filter((projectId) => seededProjects.has(projectId)).slice(0, 4);
      const linkedProjects = await this.store.linkedProjectIds(
        selectedProjects,
        projectIds,
        Math.max(0, 4 - selectedProjects.length),
      );
      const graphProjectIds = [...selectedProjects, ...linkedProjects].slice(0, 4);
      projects = await Promise.all(graphProjectIds.map((projectId) => this.ensureProject(projectId)));
      graph = !projects.length || (filters?.retrieval_lanes?.length
        && !filters.retrieval_lanes.includes('graph')) ? [] : projects.length > 1
        ? await this.searchCombinedGraph(projects, query, candidateLimit, boundedBaseFused)
        : await this.searchMaterializedGraph(projects[0], query, candidateLimit, boundedBaseFused);
    } catch (error) {
      if (!isResearchQueryTimeout(error)) throw error;
      degradedLanes.add('graph');
    }
    ensureNotAborted(signal);
    const baseKeys = new Set(baseFused.map((row) => row.url || row.document_id));
    const filteredGraph = filterSearchHits(graph, filters);
    const graphCandidates = !this.embeddings.enabled() && baseKeys.size
      ? filteredGraph.filter((row) => baseKeys.has(row.url || row.document_id))
      : filteredGraph;
    candidateCounts.graph = graphCandidates.length;
    const boundedFused = fuseRankedGroups([
      ...queryGroups.flatMap((group) => group.bounded),
      graphCandidates.slice(0, cappedLimit),
    ], cappedLimit);
    const expandedFused = fuseRankedGroups([
      ...queryGroups.flatMap((group) => group.expanded),
      graphCandidates,
    ], candidateLimit);
    const fused = preserveBoundedCandidates(boundedFused, expandedFused, candidateLimit);
    candidateCounts.fused = fused.length;
    const retrieved = performance.now();
    const results = rerank
      ? await this.rerankCandidates(query, fused, cappedLimit, vectors[0], signal)
      : fused.slice(0, cappedLimit);
    const reranked = performance.now();
    return {
      request_id: requestId,
      queries,
      results,
      ...(includePreRerank ? { pre_rerank_results: fused.slice(0, cappedLimit) } : {}),
      graph_project_count: projects.length,
      degraded_lanes: [...degradedLanes].sort(),
      timings: {
        embedding_ms: embedded - started,
        retrieval_ms: retrieved - embedded,
        rerank_ms: reranked - retrieved,
      },
      candidate_counts: candidateCounts,
    };
  }

  async searchGrouped(
    projectIdValue: string,
    groups: Array<{ id: string; query: string; query_variants?: string[]; limit?: number }>,
    includeProjectIds: string[] = [],
    signal?: AbortSignal,
    filters?: ResearchSearchFilters,
  ): Promise<Array<{
    request_id: string;
    id: string;
    query: string;
    results: LocalSearchHit[];
    degraded_lanes: RetrievalLane[];
    timings: { embedding_ms: number; retrieval_ms: number; rerank_ms: number };
    candidate_counts: { exact: number; bm25: number; vector: number; graph: number; fused: number };
  }>> {
    if (!groups.length || groups.length > 20) throw new Error('queries accepts 1-20 groups');
    const ids = new Set<string>();
    for (const group of groups) {
      cleanText(group.id, 'query id', 100);
      if (ids.has(group.id)) throw new Error(`duplicate query id: ${group.id}`);
      ids.add(group.id);
    }
    return await mapConcurrent(groups, 2, async (group) => {
      ensureNotAborted(signal);
      const searched = await this.searchBatch(
        projectIdValue,
        group.query,
        group.query_variants ?? [],
        group.limit ?? 10,
        includeProjectIds,
        signal,
        filters,
      );
      return {
        request_id: searched.request_id,
        id: group.id,
        query: group.query,
        results: searched.results,
        degraded_lanes: searched.degraded_lanes,
        timings: searched.timings,
        candidate_counts: searched.candidate_counts,
      };
    });
  }

  async researchSearchContext(
    projectIdValue: string,
    queries: string[],
    limit = 3,
  ): Promise<ResearchSearchContext | undefined> {
    const project = await this.ensureProject(projectIdValue);
    const current = queries.map((query) => cleanText(query, 'query', 400));
    const events = await this.store.listRecentSearchEvents(project.project_id, 50);
    const candidates = events.flatMap((event, eventIndex) => eventQueries(event).map((query) => {
      const similarity = Math.max(...current.map((value) => querySimilarity(value, query)));
      const relation = similarity === 1 ? 'same' as const
        : similarity >= 0.25 ? 'related' as const
          : 'recent' as const;
      const observation = event.observations?.find((item) => item.summary || item.title);
      const surface = observation
        ? `${observation.title ? `${observation.title}: ` : ''}${observation.summary}`.trim().slice(0, 180)
        : undefined;
      return {
        query: query.slice(0, 120),
        relation,
        similarity,
        eventIndex,
        searched_at: event.observed_at.slice(0, 10),
        results: event.document_ids?.length ?? 0,
        ...(surface ? { surface } : {}),
      };
    }));
    const seen = new Set<string>();
    const prior_searches = candidates
      .sort((a, b) => b.similarity - a.similarity || a.eventIndex - b.eventIndex)
      .filter((entry) => {
        const key = normalizeEntityName(entry.query);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, Math.min(Math.max(limit, 1), 3))
      .map(({ similarity: _similarity, eventIndex: _eventIndex, ...entry }) => entry);
    return prior_searches.length ? { prior_searches } : undefined;
  }

  async rerankCandidates<T extends {
    title: string;
    description?: string;
    content?: string;
    fresh_web?: boolean;
    score?: number;
    _rrf_score?: number;
  }>(
    query: string,
    rows: T[],
    limit: number,
    preparedQueryVector?: number[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    ensureNotAborted(signal);
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const visible = (selected: T[]): T[] => selected.map((entry) => {
      const { _rrf_score: _score, ...row } = entry;
      return row as T;
    });
    if (!this.embeddings.enabled() || rows.length < 2) return visible(rows.slice(0, cappedLimit));
    try {
      const working = rows.slice(0, Math.max(cappedLimit, 12));
      let freshCount = working.filter((candidate) => candidate.fresh_web).length;
      for (const row of rows) {
        if (freshCount >= 2) break;
        if (!row.fresh_web || working.includes(row)) continue;
        working.push(row);
        freshCount++;
      }
      const [queryVector, passageVectors] = await Promise.all([
        preparedQueryVector
          ? Promise.resolve(preparedQueryVector)
          : this.embeddings.embedQuery(query),
        this.embeddings.embedPassages(working.map((row) => (
          `${row.title}\n${row.description ?? ''}\n${row.content?.slice(0, 1_200) ?? ''}`
        ))),
      ]);
      ensureNotAborted(signal);
      const semantic = working.map((row, index) => ({
        row,
        index,
        similarity: cosineSimilarity(queryVector, passageVectors[index]),
      })).sort((a, b) => b.similarity - a.similarity || a.index - b.index);
      const byIndex = new Map(semantic.map((entry) => [entry.index, entry]));
      const selected = working.slice(0, cappedLimit).map((_row, index) => byIndex.get(index)!);
      const tail = semantic.filter((entry) => entry.index >= cappedLimit && !entry.row.fresh_web);
      for (const candidate of tail.slice(0, 2)) {
        let replacement = -1;
        for (let index = 2; index < selected.length; index++) {
          if (selected[index].row.fresh_web) continue;
          if (replacement < 0 || selected[index].similarity < selected[replacement].similarity) {
            replacement = index;
          }
        }
        if (replacement < 0 || candidate.similarity - selected[replacement].similarity < 0.05) continue;
        selected[replacement] = candidate;
      }
      const fresh = semantic.filter((entry) => entry.row.fresh_web);
      const freshFloor = Math.min(fresh.length, cappedLimit >= 10 ? 2 : 1);
      const selectedFresh = selected.filter((entry) => entry.row.fresh_web).length;
      for (let index = selectedFresh; index < freshFloor; index++) {
        const candidate = fresh.find((entry) => !selected.some((selectedEntry) => (
          selectedEntry.row === entry.row
        )));
        const replace = [...selected].reverse().findIndex((entry, reverseIndex) => (
          selected.length - 1 - reverseIndex >= 2 && !entry.row.fresh_web
        ));
        if (!candidate || replace < 0) break;
        selected.splice(selected.length - 1 - replace, 1, candidate);
      }
      return visible(selected.map((entry) => entry.row));
    } catch {
      return visible(rows.slice(0, cappedLimit));
    }
  }

  async searchHybridBaseline(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
  ): Promise<LocalSearchHit[]> {
    return (await this.searchBatch(
      projectIdValue,
      query,
      [],
      limit,
      includeProjectIds,
      undefined,
      undefined,
      false,
    )).results;
  }

  async searchLexicalBaseline(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
  ): Promise<LocalSearchHit[]> {
    const projectIds = [...new Set([projectIdValue, ...includeProjectIds])];
    const projects = await Promise.all(projectIds.map((projectId) => this.ensureProject(projectId)));
    const cleanedQuery = cleanText(query, 'query', 400);
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const groups = await Promise.all(projects.map(async (project) => (
      await this.store.searchProjectBm25(project.project_id, cleanedQuery, cappedLimit)
    )));
    return groups.flatMap((rows) => rows).slice(0, cappedLimit);
  }

  private async recordMetadataAssertions(
    projectId: string,
    documentIdValue: string,
    entity: EntityRecord,
    row: CaptureResult,
  ): Promise<void> {
    const facts: Array<{ predicate: string; value: AssertionValue }> = [
      ...(row.authors ? [{ predicate: 'authors', value: row.authors }] : []),
      ...(row.publication ? [{ predicate: 'published_in', value: row.publication }] : []),
      ...(row.year !== undefined ? [{ predicate: 'publication_year', value: row.year }] : []),
      ...(row.published_at ? [{ predicate: 'publication_date', value: row.published_at }] : []),
      ...(row.doi ? [{ predicate: 'doi', value: row.doi }] : []),
      ...(row.subject ? [{ predicate: 'subject', value: row.subject }] : []),
      ...(row.keywords?.length ? [{ predicate: 'keywords', value: row.keywords.join(', ') }] : []),
      ...(row.page_count !== undefined ? [{ predicate: 'page_count', value: row.page_count }] : []),
    ];
    let evidence: EvidenceRecord | undefined;
    for (const fact of facts) {
      const existing = await this.store.findAssertion({
        projectId,
        subject: entity.entity_id,
        predicate: fact.predicate,
        value: fact.value,
      });
      if (existing) continue;
      evidence ??= await this.recordEvidence({
        project_id: projectId,
        source_type: 'document',
        source_id: documentIdValue,
        locator: 'document_metadata',
      });
      await this.recordAssertion({
        project_id: projectId,
        subject: entity.entity_id,
        predicate: fact.predicate,
        value: fact.value,
        source: 'sidecar',
        confidence: 0.8,
        evidence_ids: [evidence.evidence_id],
      });
    }
  }

  async capture(input: CaptureInput): Promise<ResearchReceipt> {
    if (!this.options.enabled) {
      return { project_id: 'off', stored: 0, rag_active: 0, rag_inactive: 0, excluded: 0, summary: 'Memory: disabled' };
    }
    try {
      const project = await this.ensureProject(input.project_id);
      const rows = captureRows(input);
      const unique = new Map<string, CaptureResult>();
      let excluded = 0;
      for (const row of rows) {
        const url = canonicalUrl(row.url);
        if (!url) {
          excluded++;
          continue;
        }
        if (unique.has(url)) {
          excluded++;
          continue;
        }
        unique.set(url, { ...row, url });
      }

      const provisionalIntent = input.query
        ?? input.queries?.slice(0, 3).join('; ')
        ?? [...unique.values()][0]?.title;
      const memory = input.project_id || input.memory_handle || input.session_id
        ? await this.ensureMemorySession(
          project.project_id,
          input.memory_handle,
          provisionalIntent,
          input.session_id,
          input.session_intent,
        )
        : undefined;

      const now = new Date().toISOString();
      const repoDecisions = repositoryDecisions(input.payload);
      const kinds = { paper: [] as string[], repo: [] as string[], web: [] as string[] };
      let ragActive = 0;
      const documentIds: string[] = [];
      const observations: Array<{ document_id: string; title: string; summary: string }> = [];
      for (const row of unique.values()) {
        const id = documentId(row.url);
        const kind = classify(row, input.tool);
        const content = row.content?.trim();
        const active = !!content && row.extraction_quality !== 'metadata_only';
        const text = active
          ? `${row.title}\n${content}`.slice(0, MAX_RESEARCH_CAPTURE_CHARS)
          : undefined;
        const chunks = text ? documentChunks(text) : [];
        const chunkSetId = text ? createHash('sha256').update(text).digest('hex') : undefined;
        kinds[kind].push(shortLabel(row.title));
        documentIds.push(id);
        observations.push({
          document_id: id,
          title: row.title.slice(0, 200),
          summary: (row.description ?? row.snippet ?? '').slice(0, 4_000),
        });
        if (active) ragActive++;
        await this.store.upsertDocument({
          document_id: id,
          canonical_url: row.url,
          title: row.title.slice(0, 1_000),
          kind,
          ...(row.authors ? { authors: row.authors.slice(0, 2_000) } : {}),
          ...(row.publication ? { publication: row.publication.slice(0, 1_000) } : {}),
          ...(row.published_at ? { published_at: row.published_at.slice(0, 100) } : {}),
          ...(row.year !== undefined ? { year: row.year } : {}),
          ...(row.doi ? { doi: row.doi.slice(0, 500) } : {}),
          ...(row.description ? { description: row.description.slice(0, 4_000) } : {}),
          ...(row.keywords?.length ? { keywords: row.keywords.slice(0, 100) } : {}),
          ...(row.canonical_url ? { canonical_url: row.canonical_url.slice(0, 2_000) } : {}),
          ...(row.language ? { language: row.language.slice(0, 100) } : {}),
          ...(row.subject ? { subject: row.subject.slice(0, 2_000) } : {}),
          ...(row.creator ? { creator: row.creator.slice(0, 1_000) } : {}),
          ...(row.producer ? { producer: row.producer.slice(0, 1_000) } : {}),
          ...(row.created_at ? { created_at: row.created_at.slice(0, 100) } : {}),
          ...(row.modified_at ? { modified_at: row.modified_at.slice(0, 100) } : {}),
          ...(row.page_count !== undefined ? { page_count: row.page_count } : {}),
          ...(row.scholar_id ? { scholar_id: row.scholar_id } : {}),
          ...(chunkSetId ? { content_hash: chunkSetId } : {}),
          updated_at: now,
        });
        await this.store.upsertMembership({
          project_id: project.project_id,
          document_id: id,
          state: active ? 'lexical_active' : 'metadata_archive',
          added_at: now,
          updated_at: now,
        });
        const entity = await this.recordEntity({
          project_id: project.project_id,
          kind,
          name: row.title,
          aliases: [row.url, ...(row.scholar_id ? [row.scholar_id] : [])],
          source: 'deterministic',
          status: 'confirmed',
        });
        await this.recordMetadataAssertions(project.project_id, id, entity, row);
        if (active && chunkSetId) {
          const stagedChunks = chunks.map((chunk) => ({
            chunk_id: `${id}_${chunkSetId.slice(0, 16)}_${chunk.chunk_index}`,
            document_id: id,
            chunk_set_id: chunkSetId,
            chunk_index: chunk.chunk_index,
            title: row.title.slice(0, 1_000),
            url: row.url,
            text: chunk.text,
            content_hash: chunk.content_hash,
            updated_at: now,
          }));
          await this.store.stageDocumentChunks(stagedChunks);
          await this.store.publishDocumentChunkSet({
            document_id: id,
            content_hash: chunkSetId,
            updated_at: now,
          }, {
            project_id: project.project_id,
            document_id: id,
            state: 'lexical_active',
            added_at: now,
            updated_at: now,
          }, chunkSetId);
        }
        if (row.cited_by_count !== undefined) {
          await this.store.createMetadataObservation({
            metadata_observation_id: randomUUID(),
            project_id: project.project_id,
            document_id: id,
            kind: 'citation_count',
            value: row.cited_by_count,
            source: 'google_scholar',
            observed_at: now,
          });
        }
      }

      await this.store.createSearchEvent({
        search_event_id: randomUUID(),
        project_id: project.project_id,
        plan_revision_id: project.active_plan_revision_id,
        tool: input.tool,
        query: input.query,
        queries: input.queries,
        memory_handle: memory?.session.memory_handle,
        document_ids: documentIds,
        observations,
        repository_ingest: repoDecisions,
        observed_at: now,
      });
      await this.invalidateGraph(project.project_id);
      if (ragActive) {
        this.schedule(async () => await this.materializeRetrievalIndex(project.project_id, 'document'));
      }

      const stored = unique.size;
      const ragInactive = stored - ragActive;
      const labels = { paper: 'paper', repo: 'repo', web: 'search summary' } as const;
      const addedParts = (['paper', 'repo', 'web'] as const).flatMap((kind) => {
        if (!kinds[kind].length) return [];
        const examples = [...new Set(kinds[kind])].slice(0, 2).join(', ');
        return [`${labels[kind]} ${kinds[kind].length}${examples ? ` (${examples})` : ''}`];
      });
      const intentLabel = memory?.intent?.intent.slice(0, 40) || 'unspecified';
      const repoParts = repoDecisions.slice(0, 2).map((decision) => (
        decision.action === 'queued'
          ? `${decision.repository} code indexing queued`
          : decision.action === 'readme'
            ? `${decision.repository} README only`
            : `${decision.repository} web result only (${decision.reason})`
      ));
      const summary = `Project: ${project.name} | Session: ${intentLabel} | Stored: ${addedParts.join(', ') || 'none'}${repoParts.length ? ` | Repos: ${repoParts.join(', ')}` : ''} | Status: ready`;
      return {
        project_id: project.project_id,
        ...(memory ? { memory_handle: memory.session.memory_handle } : {}),
        ...(memory?.intent ? { session_intent: memory.intent.intent } : {}),
        stored,
        rag_active: ragActive,
        rag_inactive: ragInactive,
        excluded,
        summary,
      };
    } catch {
      this.state = 'unavailable';
      return {
        project_id: input.project_id ?? 'inbox',
        stored: 0,
        rag_active: 0,
        rag_inactive: 0,
        excluded: 0,
        summary: 'Memory: needs attention',
      };
    }
  }
}

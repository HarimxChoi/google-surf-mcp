import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { RecordId, Table, type Surreal, type SurrealTransaction } from 'surrealdb';
import { isRetryableTransactionError, isTransactionConflict } from './errors.js';
import type {
  ArtifactReference, CatalogAccessTier, CatalogAssetKind, CatalogAssetRecord, CatalogRecordReadback,
  CatalogRevisionRecord, CatalogTimelineEvent, CatalogWriteOperation, DurableWriteReceipt,
  AssertionCorrectionRecord, AssertionRecord, CodeRelationRecord, CodeSymbolRecord,
  DecisionRecord, DocumentRecordReadback, EvidenceRecord,
  EntityAliasRecord, EntityOperationRecord, EntityRecord, ExperimentRunRecord,
  GraphAnalysis, GraphArtifact, GraphProjection, IntentRevisionRecord,
  KnowledgeJobRecord, KnowledgeJobStatus,
  LocalSearchHit, MemorySessionRecord, OntologyTermRecord, PlanRevisionRecord,
  ProjectDocumentChunkRecord, ProjectDocumentRecord, ProjectDocumentRole, ProjectRecord,
  ProjectSourceEntryRecord, ProjectSourceSnapshot,
  RetrievalIndexItem, SearchEventRecord, SourceRecordReadback,
} from './contracts.js';
import { DEFAULT_RESEARCH_QUERY_TIMEOUT_MS } from './limits.js';
import { cosineSimilarity } from './dense.js';

const SCHEMA = `
DEFINE TABLE IF NOT EXISTS project SCHEMALESS;
DEFINE TABLE IF NOT EXISTS catalog_asset SCHEMALESS;
DEFINE TABLE IF NOT EXISTS catalog_revision SCHEMALESS;
DEFINE TABLE IF NOT EXISTS catalog_event SCHEMALESS;
DEFINE TABLE IF NOT EXISTS content_blob SCHEMALESS;
DEFINE TABLE IF NOT EXISTS content_blob_chunk SCHEMALESS;
DEFINE TABLE IF NOT EXISTS artifact_manifest SCHEMALESS;
DEFINE TABLE IF NOT EXISTS artifact_record SCHEMALESS;
DEFINE TABLE IF NOT EXISTS artifact_location_observation SCHEMALESS;
DEFINE TABLE IF NOT EXISTS operation_receipt SCHEMALESS;
DEFINE TABLE IF NOT EXISTS catalog_migration_journal SCHEMALESS;
DEFINE TABLE IF NOT EXISTS catalog_alias SCHEMALESS;
DEFINE TABLE IF NOT EXISTS memory_session SCHEMALESS;
DEFINE TABLE IF NOT EXISTS intent_revision SCHEMALESS;
DEFINE TABLE IF NOT EXISTS plan_revision SCHEMALESS;
DEFINE TABLE IF NOT EXISTS experiment_run SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS decision SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS ontology_term SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS evidence SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS assertion SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS assertion_correction SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS entity_alias SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS entity_operation SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS knowledge_job SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS graph_projection SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS graph_search_node SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS code_symbol SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS code_relation SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS document SCHEMALESS;
DEFINE TABLE IF NOT EXISTS project_document SCHEMALESS;
DEFINE TABLE IF NOT EXISTS chunk SCHEMALESS;
DEFINE TABLE IF NOT EXISTS search_event SCHEMALESS;
DEFINE TABLE IF NOT EXISTS metadata_observation SCHEMALESS;
DEFINE TABLE IF NOT EXISTS project_source_snapshot SCHEMALESS;
DEFINE TABLE IF NOT EXISTS project_source_entry SCHEMALESS;
DEFINE TABLE IF NOT EXISTS project_source_change SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS source_body SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS retrieval_exact SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS retrieval_vector SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS retrieval_item SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS retrieval_generation SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS embedding_cache SCHEMALESS;
DEFINE ANALYZER IF NOT EXISTS research_text TOKENIZERS blank,class,camel FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS chunk_text ON TABLE chunk FIELDS text FULLTEXT ANALYZER research_text BM25;
DEFINE INDEX IF NOT EXISTS catalog_asset_project ON TABLE catalog_asset FIELDS project_id, kind;
DEFINE INDEX IF NOT EXISTS catalog_revision_asset ON TABLE catalog_revision FIELDS asset_id, revision;
DEFINE INDEX IF NOT EXISTS catalog_event_project ON TABLE catalog_event FIELDS project_id, recorded_at;
DEFINE INDEX IF NOT EXISTS artifact_manifest_hash ON TABLE artifact_manifest FIELDS manifest_id UNIQUE;
DEFINE INDEX IF NOT EXISTS artifact_record_project ON TABLE artifact_record FIELDS project_id, artifact_id;
DEFINE INDEX IF NOT EXISTS artifact_location_project ON TABLE artifact_location_observation FIELDS project_id, artifact_id;
DEFINE INDEX IF NOT EXISTS operation_idempotency ON TABLE operation_receipt FIELDS project_id, idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS catalog_alias_lookup ON TABLE catalog_alias FIELDS project_id, alias UNIQUE;
DEFINE INDEX IF NOT EXISTS chunk_document ON TABLE chunk FIELDS document_id, chunk_set_id;
DEFINE INDEX IF NOT EXISTS source_body_text ON TABLE source_body FIELDS text FULLTEXT ANALYZER research_text BM25;
DEFINE INDEX IF NOT EXISTS membership_project ON TABLE project_document FIELDS project_id;
DEFINE INDEX IF NOT EXISTS event_project ON TABLE search_event FIELDS project_id;
DEFINE INDEX IF NOT EXISTS plan_project ON TABLE plan_revision FIELDS project_id;
DEFINE INDEX IF NOT EXISTS experiment_project ON TABLE experiment_run FIELDS project_id;
DEFINE INDEX IF NOT EXISTS session_project ON TABLE memory_session FIELDS project_id;
DEFINE INDEX IF NOT EXISTS session_host ON TABLE memory_session FIELDS project_id, host_session_id;
DEFINE INDEX IF NOT EXISTS intent_session ON TABLE intent_revision FIELDS memory_handle;
  DEFINE INDEX IF NOT EXISTS decision_project ON TABLE decision FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS ontology_project ON TABLE ontology_term FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS evidence_project ON TABLE evidence FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS assertion_project ON TABLE assertion FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS assertion_subject ON TABLE assertion FIELDS project_id, subject;
  DEFINE INDEX IF NOT EXISTS correction_project ON TABLE assertion_correction FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS entity_project ON TABLE entity FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS entity_name ON TABLE entity FIELDS project_id, normalized_name;
  DEFINE INDEX IF NOT EXISTS alias_project ON TABLE entity_alias FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS alias_name ON TABLE entity_alias FIELDS project_id, normalized_alias;
  DEFINE INDEX IF NOT EXISTS entity_operation_project ON TABLE entity_operation FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS job_project ON TABLE knowledge_job FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS job_key_unique ON TABLE knowledge_job FIELDS job_key UNIQUE;
  DEFINE INDEX IF NOT EXISTS graph_search_text ON TABLE graph_search_node FIELDS text FULLTEXT ANALYZER research_text BM25;
  DEFINE INDEX IF NOT EXISTS graph_search_project ON TABLE graph_search_node FIELDS project_id, projection_id;
  DEFINE INDEX IF NOT EXISTS code_symbol_project ON TABLE code_symbol FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS code_symbol_source ON TABLE code_symbol FIELDS project_id, source_entry_id;
  DEFINE INDEX IF NOT EXISTS code_symbol_snapshot ON TABLE code_symbol FIELDS project_id, snapshot_id;
  DEFINE INDEX IF NOT EXISTS code_relation_project ON TABLE code_relation FIELDS project_id;
  DEFINE INDEX IF NOT EXISTS code_relation_snapshot ON TABLE code_relation FIELDS project_id, snapshot_id;
DEFINE INDEX IF NOT EXISTS source_entry_project ON TABLE project_source_entry FIELDS project_id;
DEFINE INDEX IF NOT EXISTS source_entry_snapshot ON TABLE project_source_entry FIELDS snapshot_id;
DEFINE INDEX IF NOT EXISTS source_entry_hash ON TABLE project_source_entry FIELDS content_hash;
  DEFINE INDEX IF NOT EXISTS source_change_snapshot ON TABLE project_source_change FIELDS snapshot_id;
  DEFINE INDEX IF NOT EXISTS retrieval_exact_term ON TABLE retrieval_exact FIELDS project_id, normalized_term;
  DEFINE INDEX IF NOT EXISTS retrieval_exact_item ON TABLE retrieval_exact FIELDS project_id, item_id;
  DEFINE INDEX IF NOT EXISTS retrieval_vector_project ON TABLE retrieval_vector FIELDS project_id, embedding_model;
  DEFINE INDEX IF NOT EXISTS retrieval_item_project ON TABLE retrieval_item FIELDS project_id, source_family;
  DEFINE INDEX IF NOT EXISTS embedding_cache_key ON TABLE embedding_cache FIELDS cache_key UNIQUE;
`;

function utf8Page(text: string, requestedStart: number, requestedBytes: number): {
  body: string;
  span: { start: number; end: number; total_bytes: number };
  next?: number;
} {
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(0, Math.min(Math.floor(requestedStart), bytes.length));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.max(start, Math.min(start + Math.max(0, Math.floor(requestedBytes)), bytes.length));
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    body: bytes.subarray(start, end).toString('utf8'),
    span: { start, end, total_bytes: bytes.length },
    ...(end < bytes.length ? { next: end } : {}),
  };
}
const HNSW_SCHEMA = 'DEFINE INDEX IF NOT EXISTS retrieval_vector_embedding ON TABLE retrieval_vector FIELDS embedding HNSW DIMENSION 384 TYPE F32 DIST COSINE;';
const HNSW_SEARCH_EF = 400;
const VECTOR_SCORE_SCALE = 100_000;

function stableVectorScore(value: number): number {
  return Math.round(value * VECTOR_SCORE_SCALE);
}

export interface GraphSearchSeed {
  projection_id: string;
  project_id: string;
  node_id: string;
  score: number;
}

const GRAPH_SEARCH_KINDS = new Set([
  'plan', 'experiment', 'decision', 'assertion',
]);

const CORE_ONTOLOGY: OntologyTermRecord[] = [
  ['entity_type', 'paper', ['publication', 'article', 'preprint']],
  ['entity_type', 'repo', ['repository', 'codebase', 'software']],
  ['entity_type', 'web', ['web result', 'web page', 'website']],
  ['entity_type', 'project', ['research project']],
  ['entity_type', 'document', ['extracted document', 'source document']],
  ['entity_type', 'source_snapshot', ['source revision', 'inventory snapshot']],
  ['entity_type', 'source_file', ['file', 'code file']],
  ['entity_type', 'directory', ['source directory', 'root']],
  ['entity_type', 'code_symbol', ['function', 'class', 'method']],
  ['entity_type', 'code_dependency', ['module', 'library', 'header']],
  ['entity_type', 'session', ['research session']],
  ['entity_type', 'intent', ['session intent']],
  ['entity_type', 'plan', ['research plan', 'plan revision']],
  ['entity_type', 'experiment', ['experiment run', 'evaluation']],
  ['entity_type', 'decision', ['research decision']],
  ['entity_type', 'evidence', ['source evidence']],
  ['entity_type', 'assertion', ['claim', 'fact']],
  ['relation', 'authors', ['authored by']],
  ['relation', 'published_in', ['venue']],
  ['relation', 'publication_year', ['year']],
  ['relation', 'doi', ['digital object identifier']],
  ['relation', 'subject', ['topic']],
  ['relation', 'keywords', ['key terms']],
  ['relation', 'publication_date', ['published at']],
  ['relation', 'page_count', ['pages']],
  ['relation', 'contains', ['contains source']],
  ['relation', 'defines', ['defines symbol']],
  ['relation', 'calls', ['calls symbol']],
  ['relation', 'imports', ['imports dependency']],
  ['relation', 'derived_from', ['derived from source']],
  ['relation', 'supported_by', ['supported by evidence']],
  ['relation', 'supersedes', ['revises', 'replaces']],
  ['relation', 'uses_plan', ['follows plan']],
  ['relation', 'based_on', ['based on experiment']],
  ['relation', 'decides', ['decision about']],
].map(([kind, name, aliases]) => ({
  term_id: createHash('sha256').update(`core\0${kind}\0${name}\0${1}`).digest('hex').slice(0, 24),
  kind: kind as OntologyTermRecord['kind'],
  name: name as string,
  aliases: aliases as string[],
  version: 1,
  status: 'active',
  created_at: '2026-08-26T00:00:00.000Z',
}));

type RecordWithId<T> = T & { id: RecordId };

export interface CodeSourceManifestEntry {
  entry_id: string;
  path: string;
  root: string;
  tracked: boolean;
  size: number;
  content_hash: string;
}

interface RetrievalReference {
  item_id: string;
  project_id: string;
  source_family: 'document' | 'code';
  source_id: string;
  title: string;
  url: string;
  content_hash: string;
  score: number;
  span_start?: number;
  span_end?: number;
  role?: string;
}

export interface RetrievalItemState {
  item_id: string;
  project_id: string;
  source_family: 'document' | 'code';
  source_id: string;
  content_hash: string;
  exact_terms: string[];
  text_hash: string;
  title: string;
  url: string;
  span_start?: number;
  span_end?: number;
  role?: string;
  embedding_model?: string;
  embedding_hash?: string;
}

export interface RetrievalDeltaResult {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface RetrievalDeltaPlan extends RetrievalDeltaResult {
  changed_items: RetrievalIndexItem[];
  removed_items: RetrievalItemState[];
  previous_items: RetrievalItemState[];
}

export interface CommitCatalogRevisionInput {
  project_id: string;
  asset_id: string;
  kind: CatalogAssetKind;
  operation: CatalogWriteOperation;
  idempotency_key: string;
  request_hash: string;
  expected_revision?: number;
  body?: string;
  body_attachment?: { blob_id: string; byte_length: number };
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

function withoutId<T extends object>(record: RecordWithId<T>): T {
  const { id: _id, ...value } = record;
  return value as T;
}

function catalogRecordId(table: string, value: string): RecordId {
  return new RecordId(table, createHash('sha256').update(value).digest('hex'));
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

function uniqueArtifacts(values: ArtifactReference[]): ArtifactReference[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rocksDbEndpoint(path: string): string {
  return `rocksdb:${resolve(path).replace(/\\/g, '/')}`;
}

export class ResearchStore {
  private db?: Surreal;
  private opening?: Promise<Surreal>;

  constructor(
    private readonly root: string,
    private readonly endpoint = rocksDbEndpoint(resolve(root, 'surreal', 'rocksdb')),
    private readonly queryTimeoutMs = DEFAULT_RESEARCH_QUERY_TIMEOUT_MS,
    private readonly vectorBackend: 'hnsw' | 'exhaustive' | 'compact' = 'hnsw',
    private readonly databaseNamespace = 'google_surf',
    private readonly databaseName = 'research',
  ) {}

  isOpen(): boolean {
    return Boolean(this.db || this.opening);
  }

  async open(): Promise<Surreal> {
    if (this.db) return this.db;
    if (this.opening) return await this.opening;
    this.opening = this.connect();
    try {
      this.db = await this.opening;
      return this.db;
    } finally {
      this.opening = undefined;
    }
  }

  private async connect(): Promise<Surreal> {
    await mkdir(this.root, { recursive: true });
    const [{ Surreal, createRemoteEngines }, { createNodeEngines }] = await Promise.all([
      import('surrealdb'),
      import('@surrealdb/node'),
    ]);
    const db = new Surreal({
      engines: {
        ...createRemoteEngines(),
        ...createNodeEngines({
          query_timeout: Math.max(1, Math.ceil(this.queryTimeoutMs / 1_000)),
          transaction_timeout: Math.max(60, Math.ceil(this.queryTimeoutMs / 1_000)),
        }),
      },
    });
    const remote = /^(?:wss?|https?):\/\//i.test(this.endpoint);
    const token = process.env.SURF_RESEARCH_DB_TOKEN?.trim();
    const username = process.env.SURF_RESEARCH_DB_USERNAME?.trim();
    const password = process.env.SURF_RESEARCH_DB_PASSWORD;
    if (remote && !token && !(username && password)) {
      throw new Error('remote research database requires SURF_RESEARCH_DB_TOKEN or SURF_RESEARCH_DB_USERNAME and SURF_RESEARCH_DB_PASSWORD');
    }
    const authentication = token || (username && password ? { username, password } : undefined);
    const connect = db.connect(this.endpoint, {
      namespace: this.databaseNamespace,
      database: this.databaseName,
      ...(authentication ? { authentication } : {}),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connect,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('research database open timed out after 15 seconds')), 15_000);
        }),
      ]);
    } catch (error) {
      void db.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    await db.query(SCHEMA).collect();
    if (this.vectorBackend === 'hnsw' || this.vectorBackend === 'compact') {
      await db.query(HNSW_SCHEMA).collect();
    } else {
      await db.query('REMOVE INDEX IF EXISTS retrieval_vector_embedding ON TABLE retrieval_vector;').collect();
    }
    for (const term of CORE_ONTOLOGY) {
      const id = new RecordId('ontology_term', term.term_id);
      if (!await db.select(id)) {
        await db.create<OntologyTermRecord>(id).content(term as unknown as Record<string, unknown>);
      }
    }
    return db;
  }

  async close(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    if (db) await db.close();
  }

  private async transaction<T>(
    db: Surreal,
    operation: (tx: SurrealTransaction) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = await db.beginTransaction();
      try {
        const result = await operation(tx);
        await tx.commit();
        return result;
      } catch (error) {
        lastError = error;
        await tx.cancel().catch(() => {});
        if (!isRetryableTransactionError(error) || attempt === 4) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  async getProject(projectId: string): Promise<ProjectRecord | undefined> {
    const db = await this.open();
    const value = await db.select<ProjectRecord>(new RecordId('project', projectId));
    return value ? withoutId(value as RecordWithId<ProjectRecord>) : undefined;
  }

  async putProject(project: ProjectRecord): Promise<ProjectRecord> {
    const db = await this.open();
    const value = await db.upsert<ProjectRecord>(new RecordId('project', project.project_id))
      .content(project as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<ProjectRecord>);
  }

  async forgetProject(projectId: string, now: string): Promise<ProjectRecord> {
    const db = await this.open();
    const value = await db.update<ProjectRecord>(new RecordId('project', projectId)).merge({
      status: 'forgotten',
      forgot_at: now,
      updated_at: now,
    }).retry({ attempts: 5, retryable: isTransactionConflict });
    return withoutId(value as RecordWithId<ProjectRecord>);
  }

  async restoreProject(projectId: string, now: string): Promise<ProjectRecord> {
    const db = await this.open();
    const value = await db.update<ProjectRecord>(new RecordId('project', projectId)).patch([
      { op: 'remove', path: '/forgot_at' },
      { op: 'replace', path: '/status', value: 'active' },
      { op: 'replace', path: '/updated_at', value: now },
    ]).retry({ attempts: 5, retryable: isTransactionConflict });
    return withoutId(value as RecordWithId<ProjectRecord>);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectRecord[]]>(
      `SELECT project_id, name, status, created_at, updated_at,
        active_plan_revision_id, current_plan_asset_id, current_plan_revision_id,
        active_source_snapshot_id, active_code_snapshot_id,
        active_graph_projection_id,
        graph_dirty_at, active_graph_dirty_at, catalog_generation, purpose,
        user_constraints, protected_parent_ids
       FROM project WHERE status = NONE OR status = 'active' ORDER BY updated_at DESC`,
    ).collect();
    return rows;
  }

  async updateProjectContext(
    projectId: string,
    patch: Partial<Pick<ProjectRecord, 'purpose' | 'user_constraints' | 'protected_parent_ids'>>,
  ): Promise<ProjectRecord> {
    const db = await this.open();
    const id = new RecordId('project', projectId);
    const current = await db.select<ProjectRecord>(id);
    if (!current) throw new Error(`project not found: ${projectId}`);
    const value = await db.update<ProjectRecord>(id).merge({
      ...patch,
      catalog_generation: Number(current.catalog_generation ?? 0) + 1,
      updated_at: new Date().toISOString(),
    });
    return withoutId(value as RecordWithId<ProjectRecord>);
  }

  async getOperationReceipt(
    projectId: string,
    idempotencyKey: string,
  ): Promise<DurableWriteReceipt | undefined> {
    const db = await this.open();
    const value = await db.select<DurableWriteReceipt>(
      catalogRecordId('operation_receipt', `${projectId}\0${idempotencyKey}`),
    );
    return value ? withoutId(value as RecordWithId<DurableWriteReceipt>) : undefined;
  }

  async updateOperationReceipt(receipt: DurableWriteReceipt): Promise<DurableWriteReceipt> {
    const db = await this.open();
    const value = await db.upsert<DurableWriteReceipt>(
      catalogRecordId('operation_receipt', `${receipt.project_id}\0${receipt.idempotency_key}`),
    ).content(receipt as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<DurableWriteReceipt>);
  }

  async putContentBlobChunks(
    blobId: string,
    byteLength: number,
    chunks: AsyncIterable<Buffer>,
  ): Promise<void> {
    const db = await this.open();
    const blobRecordId = catalogRecordId('content_blob', blobId);
    const existing = await db.select<{ complete?: boolean; byte_length?: number }>(blobRecordId);
    if (existing?.complete && existing.byte_length === byteLength) return;
    let chunkIndex = 0;
    for await (const chunk of chunks) {
      await db.upsert(catalogRecordId('content_blob_chunk', `${blobId}\0${chunkIndex}`)).content({
        blob_id: blobId,
        chunk_index: chunkIndex,
        byte_length: chunk.length,
        data_base64: chunk.toString('base64'),
      });
      chunkIndex++;
    }
    await db.upsert(blobRecordId).content({
      blob_id: blobId,
      encoding: 'utf-8',
      storage: 'chunks',
      byte_length: byteLength,
      chunk_bytes: 256 * 1024,
      chunk_count: chunkIndex,
      complete: true,
      created_at: new Date().toISOString(),
    });
  }

  async getOperationReceiptByJobId(jobId: string): Promise<DurableWriteReceipt | undefined> {
    const db = await this.open();
    const [rows] = await db.query<[DurableWriteReceipt[]]>(
      'SELECT * OMIT id FROM operation_receipt WHERE index_job_id = $job_id LIMIT 1',
      { job_id: jobId },
    ).collect();
    return rows[0];
  }

  async getCatalogAsset(projectId: string, assetOrAliasId: string): Promise<CatalogAssetRecord | undefined> {
    const db = await this.open();
    const direct = await db.select<CatalogAssetRecord>(catalogRecordId('catalog_asset', assetOrAliasId));
    if (direct && direct.project_id === projectId) {
      return withoutId(direct as RecordWithId<CatalogAssetRecord>);
    }
    const alias = await db.select<{ project_id: string; asset_id: string }>(
      catalogRecordId('catalog_alias', `${projectId}\0${assetOrAliasId}`),
    );
    if (!alias || alias.project_id !== projectId) return undefined;
    const resolved = await db.select<CatalogAssetRecord>(catalogRecordId('catalog_asset', alias.asset_id));
    return resolved ? withoutId(resolved as RecordWithId<CatalogAssetRecord>) : undefined;
  }

  async getCatalogRevision(
    revisionId: string,
  ): Promise<CatalogRevisionRecord | undefined> {
    const db = await this.open();
    const value = await db.select<CatalogRevisionRecord>(
      catalogRecordId('catalog_revision', revisionId),
    );
    return value
      ? await this.hydrateArtifactManifest(
        db,
        withoutId(value as RecordWithId<CatalogRevisionRecord>),
      )
      : undefined;
  }

  private async hydrateArtifactManifest(
    db: Surreal,
    revision: CatalogRevisionRecord,
  ): Promise<CatalogRevisionRecord> {
    if (!revision.artifact_manifest_id || revision.artifact_references?.length) return revision;
    const manifest = await db.select<{ references?: ArtifactReference[] }>(
      catalogRecordId('artifact_manifest', revision.artifact_manifest_id),
    );
    return {
      ...revision,
      artifact_references: manifest?.references ?? [],
    };
  }

  async commitCatalogRevision(input: CommitCatalogRevisionInput): Promise<DurableWriteReceipt> {
    const db = await this.open();
    const receiptId = catalogRecordId(
      'operation_receipt',
      `${input.project_id}\0${input.idempotency_key}`,
    );
    const previousReceipt = await db.select<DurableWriteReceipt>(receiptId);
    if (previousReceipt) {
      const receipt = withoutId(previousReceipt as RecordWithId<DurableWriteReceipt>);
      if (receipt.request_hash !== input.request_hash) {
        throw new Error('idempotency key conflict: the key was already committed with different content');
      }
      return { ...receipt, applied_this_request: false, idempotent_replay: true };
    }
    return await this.transaction(db, async (tx) => {
      const concurrentReceipt = await tx.select<DurableWriteReceipt>(receiptId);
      if (concurrentReceipt) {
        const receipt = withoutId(concurrentReceipt as RecordWithId<DurableWriteReceipt>);
        if (receipt.request_hash !== input.request_hash) {
          throw new Error('idempotency key conflict: the key was already committed with different content');
        }
        return { ...receipt, applied_this_request: false, idempotent_replay: true };
      }
      const assetId = catalogRecordId('catalog_asset', input.asset_id);
      const storedAsset = await tx.select<CatalogAssetRecord>(assetId);
      const currentAsset = storedAsset
        ? withoutId(storedAsset as RecordWithId<CatalogAssetRecord>)
        : undefined;
      if (input.operation !== 'create' && !currentAsset) {
        throw new Error(`asset not found: ${input.asset_id}`);
      }
      if (input.expected_revision !== undefined
        && input.expected_revision !== (currentAsset?.current_revision ?? 0)) {
        throw new Error(
          `revision conflict: expected ${input.expected_revision}, current ${currentAsset?.current_revision ?? 0}`,
        );
      }
      const prior = currentAsset
        ? await tx.select<CatalogRevisionRecord>(
          catalogRecordId('catalog_revision', currentAsset.current_revision_id),
        )
        : undefined;
      const previous = prior
        ? withoutId(prior as RecordWithId<CatalogRevisionRecord>)
        : undefined;
      let previousArtifactReferences = previous?.artifact_references ?? [];
      if (previous?.artifact_manifest_id && !previousArtifactReferences.length) {
        const manifest = await tx.select<{ references?: ArtifactReference[] }>(
          catalogRecordId('artifact_manifest', previous.artifact_manifest_id),
        );
        previousArtifactReferences = manifest?.references ?? [];
      }
      if (input.body !== undefined && input.body_attachment) {
        throw new Error('body and body_attachment cannot be combined');
      }
      const bodyBytes = input.body === undefined ? undefined : Buffer.from(input.body, 'utf8');
      const bodyBlobId = input.body_attachment?.blob_id ?? (bodyBytes
        ? createHash('sha256').update(bodyBytes).digest('hex')
        : previous?.body_blob_id);
      const submittedBodyBytes = input.body_attachment?.byte_length ?? bodyBytes?.length;
      const fields = input.operation === 'create' && !currentAsset
        ? { ...(input.fields ?? {}) }
        : { ...(previous?.fields ?? {}), ...(input.fields ?? {}) };
      const evidenceIds = [...new Set([
        ...(previous?.evidence_ids ?? []),
        ...(input.evidence_ids ?? []),
      ])];
      const artifactReferences = uniqueArtifacts([
        ...previousArtifactReferences,
        ...(input.artifact_references ?? []),
      ]);
      const artifactManifestId = artifactReferences.length
        ? createHash('sha256').update(stableJson(artifactReferences)).digest('hex')
        : undefined;
      const aliases = [...new Set([...(currentAsset?.aliases ?? []), ...(input.aliases ?? [])])];
      const missingFields = input.missing_fields ?? previous?.missing_fields ?? [];
      const protectedValue = input.protected ?? currentAsset?.protected ?? false;
      const accessTier: CatalogAccessTier = input.access_tier ?? currentAsset?.access_tier
        ?? (protectedValue || ['project', 'plan', 'task'].includes(input.kind) ? 'hot'
          : ['artifact', 'document'].includes(input.kind) ? 'cold' : 'warm');
      const changedFields = [
        ...(bodyBlobId !== previous?.body_blob_id ? ['body'] : []),
        ...(stableJson(fields) !== stableJson(previous?.fields ?? {}) ? Object.keys(input.fields ?? {}) : []),
        ...(stableJson(evidenceIds) !== stableJson(previous?.evidence_ids ?? []) ? ['evidence_ids'] : []),
        ...(stableJson(artifactReferences) !== stableJson(previousArtifactReferences)
          ? ['artifact_references'] : []),
        ...(stableJson(aliases) !== stableJson(currentAsset?.aliases ?? []) ? ['aliases'] : []),
        ...(protectedValue !== (currentAsset?.protected ?? false) ? ['protected'] : []),
        ...(accessTier !== currentAsset?.access_tier ? ['access_tier'] : []),
        ...(stableJson(missingFields) !== stableJson(previous?.missing_fields ?? []) ? ['missing_fields'] : []),
      ].filter((value, index, values) => values.indexOf(value) === index);
      const changed = !currentAsset || changedFields.length > 0
        || input.operation === 'correct'
        || input.effective_at !== previous?.effective_at
        || input.source_reference !== previous?.source_reference;
      if (input.operation === 'create' && currentAsset && changed) {
        throw new Error(`asset already exists with different content: ${input.asset_id}; use patch`);
      }
      const committedAt = new Date().toISOString();
      const operationId = randomUUID();
      const revisionNumber = changed ? (currentAsset?.current_revision ?? 0) + 1 : currentAsset!.current_revision;
      const revisionId = changed ? `${input.asset_id}:v${revisionNumber}` : currentAsset!.current_revision_id;
      const indexJobId = changed
        ? createHash('sha256').update(`catalog-index\0${input.project_id}\0${revisionId}`).digest('hex')
        : undefined;
      if (changed) {
        if (bodyBytes && bodyBlobId) {
          await tx.upsert(catalogRecordId('content_blob', bodyBlobId)).content({
            blob_id: bodyBlobId,
            encoding: 'utf-8',
            byte_length: bodyBytes.length,
            text: input.body,
            created_at: committedAt,
          });
        }
        if (artifactManifestId) {
          await tx.upsert(catalogRecordId('artifact_manifest', artifactManifestId)).content({
            manifest_id: artifactManifestId,
            reference_count: artifactReferences.length,
            references: artifactReferences,
            created_at: committedAt,
          });
          for (let index = 0; index < artifactReferences.length; index += 500) {
            const batch = artifactReferences.slice(index, index + 500);
            await tx.insert(new Table('artifact_record'), batch.map((reference) => ({
              id: catalogRecordId(
                'artifact_record',
                createHash('sha256').update(`${input.project_id}\0${reference.artifact_id}`).digest('hex'),
              ),
              project_id: input.project_id,
              artifact_id: reference.artifact_id,
              first_record_id: input.asset_id,
              first_seen_at: committedAt,
            }))).ignore();
            await tx.insert(new Table('artifact_location_observation'), batch.map((reference) => {
              const location = reference.location ?? reference.path;
              const observationKey = stableJson({
                project_id: input.project_id,
                artifact_id: reference.artifact_id,
                location,
                member: reference.member,
                content_hash: reference.content_hash,
                available: reference.available,
                verification: reference.verification,
              });
              return {
                id: catalogRecordId(
                  'artifact_location_observation',
                  createHash('sha256').update(observationKey).digest('hex'),
                ),
                project_id: input.project_id,
                artifact_id: reference.artifact_id,
                record_id: input.asset_id,
                revision_id: revisionId,
                ...(location ? { location } : {}),
                ...(reference.member ? { member: reference.member } : {}),
                ...(reference.size !== undefined ? { size: reference.size } : {}),
                ...(reference.media_type ? { media_type: reference.media_type } : {}),
                ...(reference.content_hash ? { content_hash: reference.content_hash } : {}),
                ...(reference.role ? { role: reference.role } : {}),
                ...(reference.available !== undefined ? { available: reference.available } : {}),
                verification: reference.verification ?? 'declared',
                observed_at: reference.observed_at ?? committedAt,
              };
            })).ignore();
          }
        }
        const revision: CatalogRevisionRecord = {
          revision_id: revisionId,
          asset_id: input.asset_id,
          project_id: input.project_id,
          kind: input.kind,
          revision: revisionNumber,
          operation: input.operation,
          ...(currentAsset ? { parent_revision_id: currentAsset.current_revision_id } : {}),
          ...(bodyBlobId ? { body_blob_id: bodyBlobId } : {}),
          body_bytes: submittedBodyBytes ?? previous?.body_bytes ?? 0,
          fields,
          evidence_ids: evidenceIds,
          artifact_references: [],
          ...(artifactManifestId ? {
            artifact_manifest_id: artifactManifestId,
            artifact_reference_count: artifactReferences.length,
          } : {}),
          changed_fields: changedFields,
          missing_fields: missingFields,
          ...(input.effective_at ? { effective_at: input.effective_at } : previous?.effective_at
            ? { effective_at: previous.effective_at } : {}),
          recorded_at: committedAt,
          ...(input.source_sequence !== undefined ? { source_sequence: input.source_sequence } : {}),
          ...(input.source_reference ? { source_reference: input.source_reference } : {}),
          ...(input.correction_reason ? { correction_reason: input.correction_reason } : {}),
        };
        const asset: CatalogAssetRecord = {
          asset_id: input.asset_id,
          project_id: input.project_id,
          kind: input.kind,
          status: currentAsset?.status ?? 'active',
          current_revision: revisionNumber,
          current_revision_id: revisionId,
          aliases,
          protected: protectedValue,
          access_tier: accessTier,
          created_at: currentAsset?.created_at ?? committedAt,
          updated_at: committedAt,
        };
        await tx.upsert(catalogRecordId('catalog_revision', revisionId))
          .content(revision as unknown as Record<string, unknown>);
        await tx.upsert(assetId).content(asset as unknown as Record<string, unknown>);
        const event: CatalogTimelineEvent = {
          event_id: operationId,
          project_id: input.project_id,
          asset_id: input.asset_id,
          revision_id: revisionId,
          revision: revisionNumber,
          kind: input.kind,
          operation: input.operation,
          ...(revision.effective_at ? { effective_at: revision.effective_at } : {}),
          recorded_at: committedAt,
          ...(revision.source_sequence !== undefined ? { source_sequence: revision.source_sequence } : {}),
          changed_fields: changedFields,
          ...(input.correction_reason ? { reason: input.correction_reason } : {}),
        };
        await tx.upsert(catalogRecordId('catalog_event', operationId))
          .content(event as unknown as Record<string, unknown>);
        for (const alias of aliases) {
          await tx.upsert(catalogRecordId('catalog_alias', `${input.project_id}\0${alias}`)).content({
            project_id: input.project_id,
            alias,
            asset_id: input.asset_id,
            updated_at: committedAt,
          });
        }
        const projectId = new RecordId('project', input.project_id);
        const project = await tx.select<ProjectRecord>(projectId);
        if (project) {
          await tx.update(projectId).merge({
            catalog_generation: Number(project.catalog_generation ?? 0) + 1,
            ...(input.kind === 'project' ? {
              project_profile_asset_id: input.asset_id,
              project_profile_revision_id: revisionId,
              ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
              ...(typeof fields.purpose === 'string' ? { purpose: fields.purpose } : {}),
              ...(Array.isArray(fields.user_constraints)
                ? { user_constraints: fields.user_constraints } : {}),
              ...(Array.isArray(fields.protected_parent_ids)
                ? { protected_parent_ids: fields.protected_parent_ids } : {}),
            } : {}),
            ...(input.kind === 'plan' && input.set_current !== false ? {
              current_plan_asset_id: input.asset_id,
              current_plan_revision_id: revisionId,
            } : {}),
            updated_at: committedAt,
          });
        }
        const job: KnowledgeJobRecord = {
          job_id: indexJobId!,
          job_key: `retrieval_index\0${input.project_id}\0${revisionId}`,
          project_id: input.project_id,
          kind: 'retrieval_index',
          status: 'queued',
          source_hash: revisionId,
          schema_version: 'catalog-record-v1',
          algorithm_version: 'retrieval-v3-item-delta',
          affected_source_ids: [input.asset_id],
          attempts: 0,
          revision: 0,
          created_at: committedAt,
          updated_at: committedAt,
        };
        await tx.upsert(new RecordId('knowledge_job', indexJobId!))
          .content(job as unknown as Record<string, unknown>);
      }
      if (!changed && input.kind === 'plan' && input.set_current !== false) {
        const projectId = new RecordId('project', input.project_id);
        const project = await tx.select<ProjectRecord>(projectId);
        if (project && (project.current_plan_asset_id !== input.asset_id
          || project.current_plan_revision_id !== revisionId)) {
          await tx.update(projectId).merge({
            current_plan_asset_id: input.asset_id,
            current_plan_revision_id: revisionId,
            catalog_generation: Number(project.catalog_generation ?? 0) + 1,
            updated_at: committedAt,
          });
        }
      }
      const receipt: DurableWriteReceipt = {
        project_id: input.project_id,
        record_id: input.asset_id,
        revision: revisionNumber,
        revision_id: revisionId,
        operation_id: operationId,
        idempotency_key: input.idempotency_key,
        durability: 'committed',
        changed,
        applied_this_request: true,
        idempotent_replay: false,
        changed_fields: changedFields,
        ...(currentAsset ? { previous_revision: currentAsset.current_revision } : {}),
        ...(currentAsset ? { previous_revision_id: currentAsset.current_revision_id } : {}),
        stored_fields: [
          ...Object.keys(fields),
          ...(bodyBlobId ? ['body'] : []),
          ...(evidenceIds.length ? ['evidence_ids'] : []),
          ...(artifactReferences.length ? ['artifact_references'] : []),
        ],
        body_bytes_received: submittedBodyBytes ?? 0,
        body_bytes_stored: submittedBodyBytes ?? previous?.body_bytes ?? 0,
        artifact_references_received: input.artifact_references?.length ?? 0,
        artifact_references_stored: artifactReferences.length,
        omitted_fields: [],
        truncated: false,
        index_state: changed ? 'queued' : 'current',
        ...(indexJobId ? { index_job_id: indexJobId } : {}),
        readback: { action: 'get', record_id: input.asset_id },
        request_hash: input.request_hash,
        committed_at: committedAt,
      };
      await tx.upsert(receiptId).content(receipt as unknown as Record<string, unknown>);
      return receipt;
    });
  }

  async getCatalogRecord(
    projectId: string,
    assetOrAliasId: string,
    revisionNumber?: number,
    bodyStart = 0,
    bodyBytes = 64 * 1024,
    artifactStart = 0,
    artifactLimit = 200,
  ): Promise<CatalogRecordReadback | undefined> {
    const db = await this.open();
    const asset = await this.getCatalogAsset(projectId, assetOrAliasId);
    if (!asset) return undefined;
    let revision: CatalogRevisionRecord | undefined;
    if (revisionNumber === undefined) revision = await this.getCatalogRevision(asset.current_revision_id);
    else {
      const [rows] = await db.query<[CatalogRevisionRecord[]]>(
        `SELECT * OMIT id FROM catalog_revision
         WHERE asset_id = $asset_id AND revision = $revision LIMIT 1`,
        { asset_id: asset.asset_id, revision: revisionNumber },
      ).collect();
      revision = rows[0];
    }
    if (!revision) return undefined;
    revision = await this.hydrateArtifactManifest(db, revision);
    const artifactTotal = revision.artifact_references.length;
    const artifactOffset = Math.max(0, Math.min(artifactStart, artifactTotal));
    const artifactEnd = Math.min(artifactTotal, artifactOffset + Math.max(1, artifactLimit));
    revision = {
      ...revision,
      artifact_reference_count: revision.artifact_reference_count ?? artifactTotal,
      artifact_references: revision.artifact_references.slice(artifactOffset, artifactEnd),
    };
    let body: string | undefined;
    let bodySpan: CatalogRecordReadback['body_span'];
    let nextBodyOffset: number | undefined;
    const omittedFields: string[] = [];
    if (revision.body_blob_id) {
      if (bodyBytes === 0) {
        bodySpan = {
          start: Math.max(0, Math.min(bodyStart, revision.body_bytes)),
          end: Math.max(0, Math.min(bodyStart, revision.body_bytes)),
          total_bytes: revision.body_bytes,
        };
        omittedFields.push('body');
      }
    }
    if (revision.body_blob_id && bodyBytes > 0) {
      const blob = await db.select<{
        text?: string;
        storage?: 'chunks';
        byte_length: number;
        chunk_bytes?: number;
      }>(
        catalogRecordId('content_blob', revision.body_blob_id),
      );
      if (blob) {
        const totalBytes = blob.byte_length;
        let start = Math.max(0, Math.min(bodyStart, totalBytes));
        let bytes: Buffer;
        let localStart = start;
        if (blob.storage === 'chunks') {
          const chunkBytes = blob.chunk_bytes ?? 256 * 1024;
          const firstChunk = Math.floor(start / chunkBytes);
          const requestedEnd = Math.max(start, Math.min(start + bodyBytes, totalBytes));
          const lastChunk = Math.floor(Math.max(start, requestedEnd - 1) / chunkBytes);
          const [rows] = await db.query<[Array<{ chunk_index: number; data_base64: string }>]>(
            `SELECT chunk_index, data_base64 FROM content_blob_chunk
             WHERE blob_id = $blob_id AND chunk_index >= $first AND chunk_index <= $last
             ORDER BY chunk_index ASC`,
            { blob_id: revision.body_blob_id, first: firstChunk, last: lastChunk },
          ).collect();
          bytes = Buffer.concat(rows.map((row) => Buffer.from(row.data_base64, 'base64')));
          localStart = start - firstChunk * chunkBytes;
        } else {
          bytes = Buffer.from(blob.text ?? '', 'utf8');
        }
        while (start < totalBytes && (bytes[localStart] & 0xc0) === 0x80) {
          start++;
          localStart++;
        }
        let localEnd = Math.max(localStart, Math.min(localStart + bodyBytes, bytes.length));
        while (localEnd > localStart && start + localEnd - localStart < totalBytes
          && (bytes[localEnd] & 0xc0) === 0x80) localEnd--;
        const end = start + localEnd - localStart;
        body = bytes.subarray(localStart, localEnd).toString('utf8');
        bodySpan = { start, end, total_bytes: totalBytes };
        if (end < totalBytes) nextBodyOffset = end;
      }
    }
    return {
      asset,
      revision,
      ...(body !== undefined ? { body } : {}),
      ...(bodySpan ? { body_span: bodySpan } : {}),
      ...(nextBodyOffset !== undefined ? { next_body_offset: nextBodyOffset } : {}),
      artifact_span: { start: artifactOffset, end: artifactEnd, total: artifactTotal },
      ...(artifactEnd < artifactTotal ? { next_artifact_offset: artifactEnd } : {}),
      ...(omittedFields.length ? { omitted_fields: omittedFields } : {}),
    };
  }

  async listCurrentCatalogRevisions(
    projectId: string,
    kind: CatalogAssetKind,
    limit = 200,
  ): Promise<CatalogRevisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[CatalogRevisionRecord[]]>(
      `SELECT * OMIT id FROM catalog_revision
       WHERE project_id = $project_id AND kind = $kind
         AND revision_id IN (
           SELECT VALUE current_revision_id FROM catalog_asset
           WHERE project_id = $project_id AND kind = $kind AND status = 'active'
         )
       ORDER BY recorded_at ASC LIMIT $limit`,
      { project_id: projectId, kind, limit: Math.min(500, Math.max(1, limit)) },
    ).collect();
    return rows;
  }

  async listCatalogAssets(
    projectId: string,
    options: { kind?: CatalogAssetKind; after?: string; limit?: number } = {},
  ): Promise<CatalogAssetRecord[]> {
    const db = await this.open();
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const [rows] = await db.query<[CatalogAssetRecord[]]>(
      `SELECT * OMIT id FROM catalog_asset
       WHERE project_id = $project_id
         AND ($kind = NONE OR kind = $kind)
         AND ($after = NONE OR asset_id > $after)
       ORDER BY asset_id ASC LIMIT $limit`,
      { project_id: projectId, kind: options.kind, after: options.after, limit },
    ).collect();
    return rows;
  }

  async listCatalogRevisions(projectId: string, assetId: string): Promise<CatalogRevisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[CatalogRevisionRecord[]]>(
      `SELECT * OMIT id FROM catalog_revision
       WHERE project_id = $project_id AND asset_id = $asset_id
       ORDER BY revision ASC`,
      { project_id: projectId, asset_id: assetId },
    ).collect();
    return await Promise.all(rows.map(async (revision) => await this.hydrateArtifactManifest(db, revision)));
  }

  async listCatalogGraphRecords(projectId: string): Promise<{
    assets: CatalogAssetRecord[];
    revisions: CatalogRevisionRecord[];
  }> {
    const db = await this.open();
    const [assets] = await db.query<[CatalogAssetRecord[]]>(
      `SELECT * OMIT id FROM catalog_asset
       WHERE project_id = $project_id ORDER BY asset_id ASC`,
      { project_id: projectId },
    ).collect();
    const [revisions] = await db.query<[CatalogRevisionRecord[]]>(
      `SELECT * OMIT id FROM catalog_revision
       WHERE project_id = $project_id ORDER BY asset_id ASC, revision ASC`,
      { project_id: projectId },
    ).collect();
    return { assets, revisions };
  }

  async putCatalogMigrationJournal(record: Record<string, unknown> & { journal_id: string }): Promise<void> {
    const db = await this.open();
    await db.upsert(catalogRecordId('catalog_migration_journal', record.journal_id)).content(record);
  }

  async listCatalogTimeline(
    projectId: string,
    options: { after?: string; before?: string; limit?: number } = {},
  ): Promise<CatalogTimelineEvent[]> {
    const db = await this.open();
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const [rows] = await db.query<[CatalogTimelineEvent[]]>(
      `SELECT * OMIT id FROM catalog_event
       WHERE project_id = $project_id
         AND ($after = NONE OR recorded_at > $after)
         AND ($before = NONE OR recorded_at <= $before)
       ORDER BY recorded_at ASC, source_sequence ASC, event_id ASC LIMIT $limit`,
      { project_id: projectId, after: options.after, before: options.before, limit },
    ).collect();
    return rows;
  }

  async findCatalogPlanAt(
    projectId: string,
    asOf: string,
  ): Promise<CatalogRecordReadback | undefined> {
    const db = await this.open();
    const [rows] = await db.query<[CatalogRevisionRecord[]]>(
      `SELECT * OMIT id FROM catalog_revision
       WHERE project_id = $project_id AND kind = 'plan'
         AND ((effective_at != NONE AND effective_at <= $as_of)
           OR (effective_at = NONE AND recorded_at <= $as_of))
       LIMIT 10000`,
      { project_id: projectId, as_of: asOf },
    ).collect();
    rows.sort((left, right) => {
      const leftTime = left.effective_at ?? left.recorded_at;
      const rightTime = right.effective_at ?? right.recorded_at;
      return rightTime.localeCompare(leftTime)
        || (right.source_sequence ?? -1) - (left.source_sequence ?? -1)
        || right.recorded_at.localeCompare(left.recorded_at)
        || right.revision_id.localeCompare(left.revision_id);
    });
    const selected = rows[0];
    return selected
      ? await this.getCatalogRecord(projectId, selected.asset_id, selected.revision, 0, 256 * 1024)
      : undefined;
  }

  async listDirtyProjects(): Promise<ProjectRecord[]> {
    return (await this.listProjects()).filter((project) => (
      !!project.graph_dirty_at && project.graph_dirty_at !== project.active_graph_dirty_at
    ));
  }

  async getMemorySession(memoryHandle: string): Promise<MemorySessionRecord | undefined> {
    const db = await this.open();
    const value = await db.select<MemorySessionRecord>(new RecordId('memory_session', memoryHandle));
    return value ? withoutId(value as RecordWithId<MemorySessionRecord>) : undefined;
  }

  async putMemorySession(session: MemorySessionRecord): Promise<MemorySessionRecord> {
    const db = await this.open();
    const value = await db.upsert<MemorySessionRecord>(
      new RecordId('memory_session', session.memory_handle),
    ).content(session as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<MemorySessionRecord>);
  }

  async listIntentRevisions(memoryHandle: string): Promise<IntentRevisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[IntentRevisionRecord[]]>(
      'SELECT intent_revision_id, memory_handle, project_id, revision, intent, source, status, created_at FROM intent_revision WHERE memory_handle = $memory_handle ORDER BY revision ASC',
      { memory_handle: memoryHandle },
    ).collect();
    return rows;
  }

  async putIntentRevision(
    session: MemorySessionRecord,
    revision: IntentRevisionRecord,
  ): Promise<void> {
    const db = await this.open();
    await db.query(
      'BEGIN TRANSACTION; CREATE ONLY $intent_id CONTENT $intent_data; UPSERT $session_id CONTENT $session_data; COMMIT TRANSACTION;',
      {
        intent_id: new RecordId('intent_revision', revision.intent_revision_id),
        intent_data: revision,
        session_id: new RecordId('memory_session', session.memory_handle),
        session_data: session,
      },
    ).collect();
  }

  async listPlans(projectId: string): Promise<PlanRevisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[PlanRevisionRecord[]]>(
      'SELECT plan_revision_id, project_id, revision, title, body, change_reason, parent_revision_id, based_on_experiment_id, created_at FROM plan_revision WHERE project_id = $project_id ORDER BY revision ASC',
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async getPlan(planRevisionId: string): Promise<PlanRevisionRecord | undefined> {
    const db = await this.open();
    const value = await db.select<PlanRevisionRecord>(new RecordId('plan_revision', planRevisionId));
    return value ? withoutId(value as RecordWithId<PlanRevisionRecord>) : undefined;
  }

  async putPlan(project: ProjectRecord, plan: PlanRevisionRecord): Promise<void> {
    const db = await this.open();
    const nextProject = {
      ...project,
      active_plan_revision_id: plan.plan_revision_id,
      updated_at: plan.created_at,
    };
    await this.transaction(db, async (tx) => {
      await tx.create(new RecordId('plan_revision', plan.plan_revision_id))
        .content(plan as unknown as Record<string, unknown>);
      await tx.update(new RecordId('project', project.project_id)).merge({
        active_plan_revision_id: nextProject.active_plan_revision_id,
        updated_at: nextProject.updated_at,
      });
    });
  }

  async getExperiment(experimentId: string): Promise<ExperimentRunRecord | undefined> {
    const db = await this.open();
    const value = await db.select<ExperimentRunRecord>(new RecordId('experiment_run', experimentId));
    return value ? withoutId(value as RecordWithId<ExperimentRunRecord>) : undefined;
  }

  async putExperiment(experiment: ExperimentRunRecord): Promise<ExperimentRunRecord> {
    const db = await this.open();
    const value = await db.upsert<ExperimentRunRecord>(
      new RecordId('experiment_run', experiment.experiment_id),
    ).content(experiment as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<ExperimentRunRecord>);
  }

  async listExperiments(projectId: string): Promise<ExperimentRunRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ExperimentRunRecord[]]>(
      'SELECT experiment_id, project_id, plan_revision_id, name, hypothesis, status, summary, metrics, artifacts, started_at, finished_at FROM experiment_run WHERE project_id = $project_id ORDER BY started_at ASC',
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async putDecision(decision: DecisionRecord): Promise<DecisionRecord> {
    const db = await this.open();
    const value = await db.create<DecisionRecord>(
      new RecordId('decision', decision.decision_id),
    ).content(decision as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<DecisionRecord>);
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | undefined> {
    const db = await this.open();
    const value = await db.select<DecisionRecord>(new RecordId('decision', decisionId));
    return value ? withoutId(value as RecordWithId<DecisionRecord>) : undefined;
  }

  async listDecisions(projectId: string): Promise<DecisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[DecisionRecord[]]>(
      'SELECT decision_id, project_id, plan_revision_id, experiment_id, title, summary, created_at FROM decision WHERE project_id = $project_id ORDER BY created_at ASC',
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async putOntologyTerm(term: OntologyTermRecord): Promise<OntologyTermRecord> {
    const db = await this.open();
    const value = await db.upsert<OntologyTermRecord>(
      new RecordId('ontology_term', term.term_id),
    ).content(term as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<OntologyTermRecord>);
  }

  async getOntologyTerm(termId: string): Promise<OntologyTermRecord | undefined> {
    const db = await this.open();
    const value = await db.select<OntologyTermRecord>(new RecordId('ontology_term', termId));
    return value ? withoutId(value as RecordWithId<OntologyTermRecord>) : undefined;
  }

  async listOntologyTerms(projectId: string): Promise<OntologyTermRecord[]> {
    const db = await this.open();
    const rows = await db.select<OntologyTermRecord>(new Table('ontology_term'));
    return rows.map((row) => withoutId(row as RecordWithId<OntologyTermRecord>))
      .filter((row) => !row.project_id || row.project_id === projectId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  async putOntologyRevision(
    prior: OntologyTermRecord | undefined,
    term: OntologyTermRecord,
  ): Promise<void> {
    const db = await this.open();
    if (!prior) {
      await this.putOntologyTerm(term);
      return;
    }
    await db.query(
      `BEGIN TRANSACTION;
       UPDATE $prior_id CONTENT $prior_data;
       UPSERT $term_id CONTENT $term_data;
       COMMIT TRANSACTION;`,
      {
        prior_id: new RecordId('ontology_term', prior.term_id),
        prior_data: { ...prior, status: 'superseded' },
        term_id: new RecordId('ontology_term', term.term_id),
        term_data: term,
      },
    ).collect();
  }

  async putEntity(entity: EntityRecord): Promise<EntityRecord> {
    const db = await this.open();
    const value = await db.upsert<EntityRecord>(new RecordId('entity', entity.entity_id))
      .content(entity as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<EntityRecord>);
  }

  async getEntity(entityId: string): Promise<EntityRecord | undefined> {
    const db = await this.open();
    const value = await db.select<EntityRecord>(new RecordId('entity', entityId));
    return value ? withoutId(value as RecordWithId<EntityRecord>) : undefined;
  }

  async listEntities(projectId: string): Promise<EntityRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[EntityRecord[]]>(
      `SELECT * OMIT id FROM entity
       WHERE project_id = $project_id ORDER BY canonical_name ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async listEntityAliases(projectId: string, normalizedAlias?: string): Promise<EntityAliasRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[EntityAliasRecord[]]>(
      `SELECT * OMIT id FROM entity_alias
       WHERE project_id = $project_id AND status = 'active'
         AND ($normalized_alias = NONE OR normalized_alias = $normalized_alias)
       ORDER BY alias ASC`,
      { project_id: projectId, normalized_alias: normalizedAlias },
    ).collect();
    return rows;
  }

  async putEntityAlias(alias: EntityAliasRecord): Promise<EntityAliasRecord> {
    const db = await this.open();
    const value = await db.upsert<EntityAliasRecord>(new RecordId('entity_alias', alias.alias_id))
      .content(alias as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<EntityAliasRecord>);
  }

  async putEntityOperation(input: {
    entities: EntityRecord[];
    endedAliases: EntityAliasRecord[];
    aliases: EntityAliasRecord[];
    operation: EntityOperationRecord;
  }): Promise<EntityOperationRecord> {
    const db = await this.open();
    await this.transaction(db, async (tx) => {
      for (const entity of input.entities) {
        await tx.upsert(new RecordId('entity', entity.entity_id))
          .content(entity as unknown as Record<string, unknown>);
      }
      for (const alias of input.endedAliases) {
        await tx.upsert(new RecordId('entity_alias', alias.alias_id))
          .content(alias as unknown as Record<string, unknown>);
      }
      for (const alias of input.aliases) {
        await tx.create(new RecordId('entity_alias', alias.alias_id))
          .content(alias as unknown as Record<string, unknown>);
      }
      await tx.create(new RecordId('entity_operation', input.operation.operation_id))
        .content(input.operation as unknown as Record<string, unknown>);
    });
    return input.operation;
  }

  async entityCounts(projectId: string): Promise<{ entities: number; operations: number }> {
    const db = await this.open();
    const [entities, operations] = await db.query<[
      Array<{ count: number }>, Array<{ count: number }>,
    ]>(
      `SELECT count() AS count FROM entity
       WHERE project_id = $project_id AND status IN ['suggested', 'confirmed'] GROUP ALL;
       SELECT count() AS count FROM entity_operation
       WHERE project_id = $project_id GROUP ALL;`,
      { project_id: projectId },
    ).collect();
    return {
      entities: Number(entities[0]?.count ?? 0),
      operations: Number(operations[0]?.count ?? 0),
    };
  }

  async putEvidence(evidence: EvidenceRecord): Promise<EvidenceRecord> {
    const db = await this.open();
    const value = await db.create<EvidenceRecord>(
      new RecordId('evidence', evidence.evidence_id),
    ).content(evidence as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<EvidenceRecord>);
  }

  async getEvidence(evidenceId: string): Promise<EvidenceRecord | undefined> {
    const db = await this.open();
    const value = await db.select<EvidenceRecord>(new RecordId('evidence', evidenceId));
    return value ? withoutId(value as RecordWithId<EvidenceRecord>) : undefined;
  }

  async listEvidence(projectId: string): Promise<EvidenceRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[EvidenceRecord[]]>(
      `SELECT * OMIT id FROM evidence
       WHERE project_id = $project_id ORDER BY created_at ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async sourceBelongsToProject(
    projectId: string,
    sourceType: EvidenceRecord['source_type'],
    sourceId: string,
  ): Promise<boolean> {
    if (sourceType === 'manual') return true;
    const db = await this.open();
    if (sourceType === 'document') {
      return Boolean(await db.select(new RecordId('project_document', `${projectId}_${sourceId}`)));
    }
    if (sourceType === 'experiment' || sourceType === 'decision') {
      const table = sourceType === 'experiment' ? 'experiment_run' : 'decision';
      const row = await db.select<Record<string, unknown>>(new RecordId(table, sourceId));
      return row?.project_id === projectId;
    }
    const [rows] = await db.query<[Array<{ entry_id: string }>]>(
      `SELECT entry_id FROM project_source_entry
       WHERE project_id = $project_id AND entry_id = $source_id LIMIT 1`,
      { project_id: projectId, source_id: sourceId },
    ).collect();
    return rows.length > 0;
  }

  async putAssertion(assertion: AssertionRecord): Promise<AssertionRecord> {
    const db = await this.open();
    const value = await db.create<AssertionRecord>(
      new RecordId('assertion', assertion.assertion_id),
    ).content(assertion as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<AssertionRecord>);
  }

  async updateAssertion(assertion: AssertionRecord): Promise<AssertionRecord> {
    const db = await this.open();
    const value = await db.upsert<AssertionRecord>(
      new RecordId('assertion', assertion.assertion_id),
    ).content(assertion as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<AssertionRecord>);
  }

  async getAssertion(assertionId: string): Promise<AssertionRecord | undefined> {
    const db = await this.open();
    const value = await db.select<AssertionRecord>(new RecordId('assertion', assertionId));
    return value ? withoutId(value as RecordWithId<AssertionRecord>) : undefined;
  }

  async putAssertionCorrection(
    target: AssertionRecord,
    replacement: AssertionRecord,
    correction: AssertionCorrectionRecord,
  ): Promise<void> {
    const db = await this.open();
    await db.query(
      `BEGIN TRANSACTION;
       UPDATE $target_id CONTENT $target_data;
       CREATE ONLY $replacement_id CONTENT $replacement_data;
       CREATE ONLY $correction_id CONTENT $correction_data;
       COMMIT TRANSACTION;`,
      {
        target_id: new RecordId('assertion', target.assertion_id),
        target_data: target,
        replacement_id: new RecordId('assertion', replacement.assertion_id),
        replacement_data: replacement,
        correction_id: new RecordId('assertion_correction', correction.correction_id),
        correction_data: correction,
      },
    ).collect();
  }

  async assertionCounts(projectId: string): Promise<{ assertions: number; corrections: number }> {
    const db = await this.open();
    const [assertions, corrections] = await db.query<[
      Array<{ count: number }>, Array<{ count: number }>,
    ]>(
      `SELECT count() AS count FROM assertion
       WHERE project_id = $project_id AND status IN ['suggested', 'confirmed'] GROUP ALL;
       SELECT count() AS count FROM assertion_correction
       WHERE project_id = $project_id GROUP ALL;`,
      { project_id: projectId },
    ).collect();
    return {
      assertions: Number(assertions[0]?.count ?? 0),
      corrections: Number(corrections[0]?.count ?? 0),
    };
  }

  async getKnowledgeJob(jobId: string): Promise<KnowledgeJobRecord | undefined> {
    const db = await this.open();
    const value = await db.select<KnowledgeJobRecord>(new RecordId('knowledge_job', jobId));
    return value ? withoutId(value as RecordWithId<KnowledgeJobRecord>) : undefined;
  }

  async getKnowledgeJobByKey(jobKey: string): Promise<KnowledgeJobRecord | undefined> {
    const db = await this.open();
    const [rows] = await db.query<[KnowledgeJobRecord[]]>(
      'SELECT * OMIT id FROM knowledge_job WHERE job_key = $job_key LIMIT 1',
      { job_key: jobKey },
    ).collect();
    return rows[0];
  }

  async putKnowledgeJob(job: KnowledgeJobRecord): Promise<KnowledgeJobRecord> {
    const db = await this.open();
    const value = await db.upsert<KnowledgeJobRecord>(
      new RecordId('knowledge_job', job.job_id),
    ).content(job as unknown as Record<string, unknown>);
    return withoutId(value as RecordWithId<KnowledgeJobRecord>);
  }

  async listPendingKnowledgeJobs(): Promise<KnowledgeJobRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[KnowledgeJobRecord[]]>(
      "SELECT * OMIT id FROM knowledge_job WHERE status IN ['queued', 'running'] ORDER BY created_at ASC",
    ).collect();
    return rows;
  }

  async latestKnowledgeJob(
    projectId: string,
    kind: KnowledgeJobRecord['kind'],
  ): Promise<KnowledgeJobRecord | undefined> {
    const db = await this.open();
    const [rows] = await db.query<[KnowledgeJobRecord[]]>(
      `SELECT * OMIT id FROM knowledge_job
       WHERE project_id = $project_id AND kind = $kind
       ORDER BY updated_at DESC LIMIT 1`,
      { project_id: projectId, kind },
    ).collect();
    return rows[0];
  }

  async markGraphDirty(projectId: string, marker: string): Promise<void> {
    const db = await this.open();
    await db.update(new RecordId('project', projectId)).merge({ graph_dirty_at: marker })
      .retry({ attempts: 5, retryable: isTransactionConflict });
  }

  async currentGraph(projectId: string): Promise<{ projection_id?: string; current: boolean }> {
    const project = await this.getProject(projectId);
    if (!project?.active_graph_projection_id) return { current: false };
    const sourceVersion = project.graph_dirty_at ?? project.updated_at;
    return {
      projection_id: project.active_graph_projection_id,
      current: sourceVersion === project.active_graph_dirty_at,
    };
  }

  async knowledgeJobCounts(projectId: string): Promise<Record<KnowledgeJobStatus, number>> {
    const db = await this.open();
    const [rows] = await db.query<[Array<{
      kind: KnowledgeJobRecord['kind'];
      status: KnowledgeJobStatus;
      updated_at: string;
    }>]>(
      `SELECT kind, status, updated_at FROM knowledge_job
       WHERE project_id = $project_id ORDER BY updated_at DESC`,
      { project_id: projectId },
    ).collect();
    const counts: Record<KnowledgeJobStatus, number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    const current = new Map<KnowledgeJobRecord['kind'], KnowledgeJobStatus>();
    for (const row of rows) if (!current.has(row.kind)) current.set(row.kind, row.status);
    for (const status of current.values()) counts[status]++;
    return counts;
  }

  private async reconcileGraphProjectionStatuses(db: Surreal): Promise<void> {
    const [rows] = await db.query<[Array<{ active_graph_projection_id?: string }>]>(
      `SELECT active_graph_projection_id FROM project
       WHERE (status = NONE OR status = 'active') AND active_graph_projection_id != NONE`,
    ).collect();
    const activeIds = [...new Set(rows
      .map((row) => row.active_graph_projection_id)
      .filter((value): value is string => Boolean(value)))];
    if (activeIds.length) {
      await db.query(
        `UPDATE graph_projection SET status = 'active'
         WHERE projection_id IN $active_ids
           AND (payload_file != NONE OR payload_gzip != NONE)`,
        { active_ids: activeIds },
      ).collect();
      await db.query(
        `UPDATE graph_projection SET status = 'superseded'
         WHERE status = 'active' AND projection_id NOT IN $active_ids`,
        { active_ids: activeIds },
      ).collect();
    } else {
      await db.query(
        `UPDATE graph_projection SET status = 'superseded' WHERE status = 'active'`,
      ).collect();
    }
  }

  private async pruneGraphProjections(db: Surreal): Promise<void> {
    const [projects] = await db.query<[Array<{ active_graph_projection_id?: string }>]>(
      `SELECT active_graph_projection_id FROM project
       WHERE (status = NONE OR status = 'active') AND active_graph_projection_id != NONE`,
    ).collect();
    const activeIds = new Set(projects
      .map((project) => project.active_graph_projection_id)
      .filter((value): value is string => Boolean(value)));
    const [projections] = await db.query<[Array<{
      projection_id: string;
      project_ids?: string[];
      payload_file?: string;
      created_at?: string;
    }>]>(
      `SELECT projection_id, project_ids, payload_file, created_at
       FROM graph_projection ORDER BY created_at DESC`,
    ).collect();
    const retained = new Map<string, number>();
    const graphRoot = resolve(this.root, 'graphs');
    for (const projection of projections) {
      if (activeIds.has(projection.projection_id)) continue;
      const projectIds = projection.project_ids ?? [];
      const keep = Boolean(projection.payload_file)
        && projectIds.some((projectId) => (retained.get(projectId) ?? 0) < 2);
      if (keep) {
        for (const projectId of projectIds) {
          retained.set(projectId, (retained.get(projectId) ?? 0) + 1);
        }
        continue;
      }
      if (projection.payload_file) {
        const payloadPath = resolve(graphRoot, projection.payload_file);
        if (payloadPath.startsWith(`${graphRoot}${sep}`)) await rm(payloadPath, { force: true });
      }
      await db.query(
        'DELETE graph_search_node WHERE projection_id = $projection_id',
        { projection_id: projection.projection_id },
      ).collect();
      await db.delete(new RecordId('graph_projection', projection.projection_id));
    }
  }

  private async replaceGraphSearchNodes(db: Surreal, projection: GraphProjection): Promise<void> {
    await db.query(
      'DELETE graph_search_node WHERE projection_id = $projection_id',
      { projection_id: projection.projection_id },
    ).collect();
    const rows = projection.nodes.filter((node) => (
      node.project_id !== 'shared' && GRAPH_SEARCH_KINDS.has(node.kind)
    )).map((node) => ({
      id: new RecordId('graph_search_node', createHash('sha256')
        .update(`${projection.projection_id}\0${node.node_id}`).digest('hex')),
      projection_id: projection.projection_id,
      project_id: node.project_id,
      node_id: node.node_id,
      kind: node.kind,
      text: `${node.label}\n${node.text?.slice(0, 2_000) ?? ''}\n${node.source_id ?? ''}`,
    }));
    for (let index = 0; index < rows.length; index += 1_000) {
      await db.insert(new Table('graph_search_node'), rows.slice(index, index + 1_000));
    }
  }

  private async readGraphPayload(
    db: Surreal,
    projectionId: string,
    record: Record<string, unknown>,
  ): Promise<GraphArtifact> {
    let compressed: Buffer;
    if (typeof record.payload_file === 'string') {
      compressed = await readFile(resolve(this.root, 'graphs', record.payload_file));
      if (typeof record.payload_sha256 === 'string'
        && createHash('sha256').update(compressed).digest('hex') !== record.payload_sha256) {
        throw new Error('graph payload checksum mismatch');
      }
    } else if (typeof record.payload_gzip === 'string') {
      compressed = Buffer.from(record.payload_gzip, 'base64');
    } else {
      throw new Error('graph payload missing');
    }
    return JSON.parse(gunzipSync(compressed).toString('utf8')) as GraphArtifact;
  }

  async publishGraphProjection(
    projection: GraphProjection,
    analysis: GraphAnalysis,
  ): Promise<{ reused: boolean }> {
    const db = await this.open();
    const projectionId = new RecordId('graph_projection', projection.projection_id);
    const existing = await db.select<Record<string, unknown>>(projectionId);
    const reusable = existing
      ? await this.readGraphPayload(db, projection.projection_id, existing).then(
        () => true,
        () => false,
      )
      : false;
    if (reusable) {
      await this.replaceGraphSearchNodes(db, projection);
      for (const projectId of projection.project_ids) {
        await db.update(new RecordId('project', projectId)).merge({
          active_graph_projection_id: projection.projection_id,
          active_graph_dirty_at: projection.source_versions[projectId],
        });
      }
      await this.reconcileGraphProjectionStatuses(db);
      await this.pruneGraphProjections(db);
      return { reused: true };
    }
    const payload = gzipSync(Buffer.from(JSON.stringify({ projection, analysis })), { level: 1 });
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');
    const payloadFile = `${projection.projection_id}-${payloadSha256}.json.gz`;
    const graphRoot = resolve(this.root, 'graphs');
    const payloadPath = resolve(graphRoot, payloadFile);
    const temporaryPath = `${payloadPath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(graphRoot, { recursive: true });
    let payloadPresent = false;
    try {
      const currentPayload = await readFile(payloadPath);
      payloadPresent = createHash('sha256').update(currentPayload).digest('hex') === payloadSha256;
      if (!payloadPresent) throw new Error('graph payload file checksum mismatch');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (!payloadPresent) {
      try {
        await writeFile(temporaryPath, payload);
        await rename(temporaryPath, payloadPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
    await db.upsert(projectionId).content({
      projection_id: projection.projection_id,
      schema_version: projection.schema_version,
      source_hash: projection.source_hash,
      project_ids: projection.project_ids,
      status: 'indexing',
      node_count: projection.nodes.length,
      edge_count: projection.edges.length,
      engine: analysis.engine,
      payload_file: payloadFile,
      payload_bytes: payload.length,
      payload_sha256: payloadSha256,
      created_at: new Date().toISOString(),
    });
    const activatedAt = new Date().toISOString();
    await this.transaction(db, async (tx) => {
      await tx.update(projectionId).merge({
        status: 'active',
        activated_at: activatedAt,
        elapsed_ms: analysis.elapsed_ms,
        component_count: analysis.component_count,
        strongly_connected_component_count: analysis.strongly_connected_component_count,
        community_count: analysis.community_count,
      });
      for (const projectId of projection.project_ids) {
        await tx.update(new RecordId('project', projectId)).merge({
          active_graph_projection_id: projection.projection_id,
          active_graph_dirty_at: projection.source_versions[projectId],
        });
      }
    });
    await this.replaceGraphSearchNodes(db, projection);
    await this.reconcileGraphProjectionStatuses(db);
    await this.pruneGraphProjections(db);
    return { reused: false };
  }

  async loadGraphArtifact(
    projectionId: string,
    requireActive = true,
  ): Promise<GraphArtifact | undefined> {
    const db = await this.open();
    const value = await db.select<Record<string, unknown>>(
      new RecordId('graph_projection', projectionId),
    );
    if (!value || (requireActive && value.status !== 'active')) return undefined;
    return await this.readGraphPayload(db, projectionId, value);
  }

  async validateGraphArtifact(projectionId: string, requireActive = true): Promise<boolean> {
    const db = await this.open();
    const value = await db.select<Record<string, unknown>>(
      new RecordId('graph_projection', projectionId),
    );
    if (!value || (requireActive && value.status !== 'active')) return false;
    try {
      if (typeof value.payload_file === 'string' && typeof value.payload_sha256 === 'string') {
        const payload = await readFile(resolve(this.root, 'graphs', value.payload_file));
        return createHash('sha256').update(payload).digest('hex') === value.payload_sha256;
      }
      await this.readGraphPayload(db, projectionId, value);
      return true;
    } catch {
      return false;
    }
  }

  async searchGraphSeeds(
    projectIds: string[],
    queries: string[],
    limit: number,
  ): Promise<GraphSearchSeed[]> {
    if (!projectIds.length || !queries.length) return [];
    const db = await this.open();
    const [projects] = await db.query<[Array<{
      project_id: string;
      active_graph_projection_id?: string;
    }>]>(
      `SELECT project_id, active_graph_projection_id FROM project
       WHERE project_id IN $project_ids AND active_graph_projection_id != NONE`,
      { project_ids: projectIds },
    ).collect();
    const active = new Map(projects.flatMap((project) => project.active_graph_projection_id
      ? [[project.project_id, project.active_graph_projection_id] as const]
      : []));
    const projectionIds = [...new Set(active.values())];
    if (!projectionIds.length) return [];
    const ranked = new Map<string, GraphSearchSeed>();
    for (const query of queries) {
      const [rows] = await db.query<[Array<{
        projection_id: string;
        project_id: string;
        node_id: string;
        score: number;
      }>]>(
        `SELECT projection_id, project_id, node_id, search::score(0) AS score
         FROM graph_search_node
         WHERE project_id IN $project_ids AND projection_id IN $projection_ids
           AND text @0@ $query
         ORDER BY score DESC LIMIT $limit`,
        { project_ids: projectIds, projection_ids: projectionIds, query, limit },
      ).collect();
      rows.forEach((row, index) => {
        if (active.get(row.project_id) !== row.projection_id) return;
        const key = `${row.projection_id}\0${row.node_id}`;
        const contribution = 1 / (60 + index + 1);
        const prior = ranked.get(key);
        ranked.set(key, { ...row, score: (prior?.score ?? 0) + contribution });
      });
    }
    return [...ranked.values()].sort((a, b) => b.score - a.score || a.node_id.localeCompare(b.node_id))
      .slice(0, limit);
  }

  async ensureGraphSearchIndexes(projectIds: string[]): Promise<number> {
    if (!projectIds.length) return 0;
    const db = await this.open();
    const [projects] = await db.query<[Array<{ active_graph_projection_id?: string }>]>(
      `SELECT active_graph_projection_id FROM project
       WHERE project_id IN $project_ids AND active_graph_projection_id != NONE`,
      { project_ids: projectIds },
    ).collect();
    const projectionIds = [...new Set(projects.flatMap((project) => (
      project.active_graph_projection_id ? [project.active_graph_projection_id] : []
    )))];
    let indexed = 0;
    for (const projectionId of projectionIds) {
      const [counts] = await db.query<[Array<{ count: number }>]>(
        'SELECT count() AS count FROM graph_search_node WHERE projection_id = $projection_id GROUP ALL',
        { projection_id: projectionId },
      ).collect();
      if (Number(counts[0]?.count ?? 0) > 0) continue;
      const artifact = await this.loadGraphArtifact(projectionId);
      if (!artifact) continue;
      await this.replaceGraphSearchNodes(db, artifact.projection);
      indexed++;
    }
    return indexed;
  }

  async linkedProjectIds(seedProjectIds: string[], scopeProjectIds: string[], limit: number): Promise<string[]> {
    if (!seedProjectIds.length || !scopeProjectIds.length || limit < 1) return [];
    const db = await this.open();
    const [aliases] = await db.query<[Array<{
      project_id: string;
      entity_id: string;
      alias: string;
      normalized_alias: string;
      source: string;
      status: string;
    }>]>(
      `SELECT project_id, entity_id, alias, normalized_alias, source, status
       FROM entity_alias WHERE project_id IN $project_ids AND status = 'active'`,
      { project_ids: scopeProjectIds },
    ).collect();
    const stable = aliases.filter((alias) => alias.source === 'explicit'
      || /^https?:\/\//i.test(alias.alias)
      || /^(?:doi:|arxiv:|pmid:|pmcid:|s2:|scholar:|github:|10\.\d{4,9}\/)/i.test(alias.alias));
    const seedAliases = new Set(stable.filter((alias) => seedProjectIds.includes(alias.project_id))
      .map((alias) => alias.normalized_alias));
    const scores = new Map<string, number>();
    for (const alias of stable) {
      if (seedProjectIds.includes(alias.project_id) || !seedAliases.has(alias.normalized_alias)) continue;
      scores.set(alias.project_id, (scores.get(alias.project_id) ?? 0) + 1);
    }
    return [...scores].sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .slice(0, limit).map(([projectId]) => projectId);
  }

  async searchMemorySeedProjects(
    projectIds: string[],
    queries: string[],
    limit: number,
  ): Promise<string[]> {
    if (!projectIds.length || !queries.length) return [];
    const db = await this.open();
    const [plans, experiments, decisions, intents, entities, assertions] = await db.query<[
      Array<{ project_id: string; title?: string; body?: string }>,
      Array<{ project_id: string; name?: string; hypothesis?: string; summary?: string }>,
      Array<{ project_id: string; title?: string; summary?: string }>,
      Array<{ project_id: string; intent?: string }>,
      Array<{ project_id: string; canonical_name?: string; kind?: string }>,
      Array<{ project_id: string; subject?: string; predicate?: string; object?: string; value?: unknown }>,
    ]>(
      `SELECT project_id, title, body FROM plan_revision WHERE project_id IN $project_ids;
       SELECT project_id, name, hypothesis, summary FROM experiment_run WHERE project_id IN $project_ids;
       SELECT project_id, title, summary FROM decision WHERE project_id IN $project_ids;
       SELECT project_id, intent FROM intent_revision WHERE project_id IN $project_ids;
       SELECT project_id, canonical_name, kind FROM entity WHERE project_id IN $project_ids;
       SELECT project_id, subject, predicate, object, value FROM assertion
       WHERE project_id IN $project_ids AND status IN ['suggested', 'confirmed'];`,
      { project_ids: projectIds },
    ).collect();
    const terms = queries.map((query) => query.toLocaleLowerCase()
      .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((tokens) => tokens.length);
    const scores = new Map<string, number>();
    for (const row of [...plans, ...experiments, ...decisions, ...intents, ...entities, ...assertions]) {
      const text = Object.entries(row).filter(([key]) => key !== 'project_id')
        .map(([, value]) => typeof value === 'string' || typeof value === 'number' ? String(value) : '')
        .join(' ').toLocaleLowerCase();
      const score = Math.max(0, ...terms.map((tokens) => (
        tokens.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0) / tokens.length
      )));
      if (score > 0) scores.set(row.project_id, Math.max(scores.get(row.project_id) ?? 0, score));
    }
    return [...scores].sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .slice(0, limit).map(([projectId]) => projectId);
  }

  async replaceCodeStructure(
    projectId: string,
    snapshotId: string,
    symbols: CodeSymbolRecord[],
    relations: CodeRelationRecord[],
  ): Promise<void> {
    const db = await this.open();
    for (let index = 0; index < symbols.length; index += 1_000) {
      await db.insert(new Table('code_symbol'), symbols.slice(index, index + 1_000).map((symbol) => ({
        id: new RecordId('code_symbol', `${snapshotId}_${symbol.symbol_id}`),
        ...symbol,
        snapshot_id: snapshotId,
      }))).ignore();
    }
    for (let index = 0; index < relations.length; index += 1_000) {
      await db.insert(new Table('code_relation'), relations.slice(index, index + 1_000).map((relation) => ({
        id: new RecordId('code_relation', `${snapshotId}_${relation.relation_id}`),
        ...relation,
        snapshot_id: snapshotId,
      }))).ignore();
    }
    await db.update(new RecordId('project', projectId)).merge({
      active_code_snapshot_id: snapshotId,
      updated_at: new Date().toISOString(),
    });
  }

  async pruneCodeStructure(projectId: string, activeSnapshotId: string): Promise<void> {
    const db = await this.open();
    for (const table of ['code_relation', 'code_symbol']) {
      while (true) {
        const [ids] = await db.query<[RecordId[]]>(
          `SELECT VALUE id FROM ${table}
           WHERE project_id = $project_id AND snapshot_id != $snapshot_id LIMIT 1000`,
          { project_id: projectId, snapshot_id: activeSnapshotId },
        ).collect();
        if (!ids.length) break;
        await db.query(`DELETE ${table} WHERE id IN $ids`, { ids }).collect();
      }
    }
  }

  async listCodeSymbols(projectId: string): Promise<CodeSymbolRecord[]> {
    const db = await this.open();
    const project = await this.getProject(projectId);
    const snapshotId = project?.active_code_snapshot_id ?? project?.active_source_snapshot_id;
    if (!snapshotId) return [];
    const [rows] = await db.query<[CodeSymbolRecord[]]>(
      `SELECT * OMIT id, snapshot_id FROM code_symbol
       WHERE project_id = $project_id AND snapshot_id = $snapshot_id
       ORDER BY source_entry_id ASC, start_line ASC`,
      { project_id: projectId, snapshot_id: snapshotId },
    ).collect();
    return rows;
  }

  async listCodeRelations(projectId: string): Promise<CodeRelationRecord[]> {
    const db = await this.open();
    const project = await this.getProject(projectId);
    const snapshotId = project?.active_code_snapshot_id ?? project?.active_source_snapshot_id;
    if (!snapshotId) return [];
    const [rows] = await db.query<[CodeRelationRecord[]]>(
      `SELECT * OMIT id, snapshot_id FROM code_relation
       WHERE project_id = $project_id AND snapshot_id = $snapshot_id
       ORDER BY source_entry_id ASC, line ASC`,
      { project_id: projectId, snapshot_id: snapshotId },
    ).collect();
    return rows;
  }

  async upsertDocument(data: Record<string, unknown>): Promise<void> {
    const db = await this.open();
    await db.upsert(new RecordId('document', String(data.document_id))).merge(data);
  }

  async upsertMembership(data: Record<string, unknown>): Promise<void> {
    const db = await this.open();
    const id = `${data.project_id}_${data.document_id}`;
    const recordId = new RecordId('project_document', id);
    const existing = await db.select<Record<string, unknown>>(recordId);
    await db.upsert(recordId).merge({
      ...data,
      state: existing?.state === 'lexical_active' ? 'lexical_active' : data.state,
      added_at: existing?.added_at ?? data.added_at,
    });
  }

  async replaceDocumentChunks(
    documentId: string,
    chunkSetId: string,
    chunks: Array<Record<string, unknown> & { chunk_id: string }>,
  ): Promise<void> {
    const db = await this.open();
    for (const chunk of chunks) {
      const { chunk_id, ...data } = chunk;
      await db.upsert(new RecordId('chunk', chunk_id)).content(data);
    }
    await db.query(
      `DELETE chunk WHERE document_id = $document_id
       AND (chunk_set_id = NONE OR chunk_set_id != $chunk_set_id)`,
      { document_id: documentId, chunk_set_id: chunkSetId },
    );
  }

  async stageDocumentChunks(
    chunks: Array<Record<string, unknown> & { chunk_id: string }>,
  ): Promise<void> {
    const db = await this.open();
    for (const chunk of chunks) {
      const { chunk_id, ...data } = chunk;
      await db.upsert(new RecordId('chunk', chunk_id)).content(data);
    }
  }

  async publishDocumentChunkSet(
    document: Record<string, unknown> & { document_id: string },
    membership: Record<string, unknown> & { project_id: string; document_id: string },
    chunkSetId: string,
  ): Promise<void> {
    const db = await this.open();
    await this.transaction(db, async (tx) => {
      const { document_id: documentId, ...documentData } = document;
      await tx.upsert(new RecordId('document', documentId)).merge(documentData);
      const membershipId = new RecordId('project_document', `${membership.project_id}_${membership.document_id}`);
      const existing = await tx.select<Record<string, unknown>>(membershipId);
      await tx.upsert(membershipId).merge({
        ...membership,
        active_chunk_set_id: chunkSetId,
        state: existing?.state === 'lexical_active' ? 'lexical_active' : membership.state,
        added_at: existing?.added_at ?? membership.added_at,
      });
      await tx.query(
        `DELETE chunk WHERE document_id = $document_id
         AND (chunk_set_id = NONE OR chunk_set_id != $chunk_set_id)`,
        { document_id: documentId, chunk_set_id: chunkSetId },
      );
    });
  }

  private exactRows(item: RetrievalIndexItem): Array<Record<string, unknown> & { id: RecordId }> {
    return [...new Set(item.exact_terms)].map((term) => ({
      id: new RecordId('retrieval_exact', createHash('sha256')
        .update(`${item.project_id}\0${item.item_id}\0${term}`).digest('hex')),
      item_id: item.item_id,
      project_id: item.project_id,
      source_family: item.source_family,
      source_id: item.source_id,
      title: item.title,
      url: item.url,
      content_hash: item.content_hash,
      normalized_term: term,
      span_start: item.span_start,
      span_end: item.span_end,
      role: item.role,
    }));
  }

  private vectorRow(
    item: RetrievalIndexItem,
    embeddingModel: string,
    embedding: number[],
  ): Record<string, unknown> & { id: RecordId } {
    return {
      id: new RecordId('retrieval_vector', createHash('sha256')
        .update(`${item.project_id}\0${item.item_id}`).digest('hex')),
      item_id: item.item_id,
      project_id: item.project_id,
      source_family: item.source_family,
      source_id: item.source_id,
      title: item.title,
      url: item.url,
      content_hash: item.content_hash,
      embedding_model: embeddingModel,
      embedding,
      span_start: item.span_start,
      span_end: item.span_end,
      role: item.role,
    };
  }

  async upsertExactItem(item: RetrievalIndexItem): Promise<void> {
    const db = await this.open();
    await db.query(
      'DELETE retrieval_exact WHERE project_id = $project_id AND item_id = $item_id',
      { project_id: item.project_id, item_id: item.item_id },
    ).collect();
    const exact = this.exactRows(item);
    if (exact.length) await db.insert(new Table('retrieval_exact'), exact);
  }

  async upsertVectorItem(
    item: RetrievalIndexItem,
    embeddingModel: string,
    embedding: number[],
  ): Promise<void> {
    const db = await this.open();
    await db.query(
      'DELETE retrieval_vector WHERE project_id = $project_id AND item_id = $item_id',
      { project_id: item.project_id, item_id: item.item_id },
    ).collect();
    await db.insert(new Table('retrieval_vector'), [this.vectorRow(item, embeddingModel, embedding)]);
  }

  async removeRetrievalItem(projectId: string, itemId: string): Promise<void> {
    const db = await this.open();
    await db.query(
      `DELETE retrieval_exact WHERE project_id = $project_id AND item_id = $item_id;
       DELETE retrieval_vector WHERE project_id = $project_id AND item_id = $item_id;`,
      { project_id: projectId, item_id: itemId },
    ).collect();
  }

  async listRetrievalItemStates(
    projectId: string,
    sourceFamily: 'document' | 'code',
  ): Promise<RetrievalItemState[]> {
    const db = await this.open();
    const [rows] = await db.query<[RetrievalItemState[]]>(
      `SELECT * OMIT id FROM retrieval_item
       WHERE project_id = $project_id AND source_family = $source_family`,
      { project_id: projectId, source_family: sourceFamily },
    ).collect();
    return rows;
  }

  async planRetrievalItemDelta(
    projectId: string,
    sourceFamily: 'document' | 'code',
    items: RetrievalIndexItem[],
  ): Promise<RetrievalDeltaPlan> {
    const previousRows = await this.listRetrievalItemStates(projectId, sourceFamily);
    const previous = new Map(previousRows.map((row) => [row.item_id, row]));
    const next = new Map(items.map((item) => [item.item_id, item]));
    const inserted = items.filter((item) => !previous.has(item.item_id));
    const updated = items.filter((item) => {
      const prior = previous.get(item.item_id);
      return prior && stableJson({
        source_id: prior.source_id,
        content_hash: prior.content_hash,
        exact_terms: [...new Set(prior.exact_terms)].sort(),
        text_hash: prior.text_hash,
        span_start: prior.span_start,
        span_end: prior.span_end,
        role: prior.role,
        title: prior.title,
        url: prior.url,
      }) !== stableJson({
        source_id: item.source_id,
        content_hash: item.content_hash,
        exact_terms: [...new Set(item.exact_terms)].sort(),
        text_hash: createHash('sha256').update(item.text).digest('hex'),
        span_start: item.span_start,
        span_end: item.span_end,
        role: item.role,
        title: item.title,
        url: item.url,
      });
    });
    const removed = previousRows.filter((row) => !next.has(row.item_id));
    const changedItems = [...inserted, ...updated];
    return {
      inserted: inserted.length,
      updated: updated.length,
      removed: removed.length,
      unchanged: items.length - inserted.length - updated.length,
      changed_items: changedItems,
      removed_items: removed,
      previous_items: previousRows,
    };
  }

  async commitRetrievalGeneration(
    projectId: string,
    sourceFamily: 'document' | 'code',
    generation: string,
    plan: RetrievalDeltaPlan,
    vectorUpdates: Array<{ item: RetrievalIndexItem; embedding: number[] }> = [],
    embeddingModel?: string,
    pruneVectorItemIds: string[] = [],
  ): Promise<void> {
    if (vectorUpdates.length && !embeddingModel) throw new Error('embedding model is required for vector updates');
    const db = await this.open();
    const previous = new Map(plan.previous_items.map((item) => [item.item_id, item]));
    const updates = new Map(vectorUpdates.map((entry) => [entry.item.item_id, entry]));
    await this.transaction(db, async (tx) => {
      for (const item of plan.changed_items) {
        const prior = previous.get(item.item_id);
        for (const term of prior?.exact_terms ?? []) {
          await tx.delete(new RecordId('retrieval_exact', createHash('sha256')
            .update(`${projectId}\0${item.item_id}\0${term}`).digest('hex')));
        }
        for (const { id, ...row } of this.exactRows(item)) await tx.upsert(id).content(row);

        const textHash = createHash('sha256').update(item.text).digest('hex');
        const vectorUpdate = updates.get(item.item_id);
        const reuseEmbedding = !vectorUpdate && prior?.text_hash === textHash && prior.embedding_model;
        let embeddingHash: string | undefined;
        if (vectorUpdate && embeddingModel) {
          const { id, ...row } = this.vectorRow(item, embeddingModel, vectorUpdate.embedding);
          await tx.upsert(id).content(row);
          embeddingHash = createHash('sha256')
            .update(Buffer.from(new Float32Array(vectorUpdate.embedding).buffer)).digest('hex');
        } else if (reuseEmbedding) {
          const vectorId = new RecordId('retrieval_vector', createHash('sha256')
            .update(`${projectId}\0${item.item_id}`).digest('hex'));
          await tx.update(vectorId).merge({
            source_id: item.source_id,
            title: item.title,
            url: item.url,
            content_hash: item.content_hash,
            span_start: item.span_start,
            span_end: item.span_end,
            role: item.role,
          });
          embeddingHash = prior.embedding_hash;
        } else if (prior?.embedding_model) {
          await tx.delete(new RecordId('retrieval_vector', createHash('sha256')
            .update(`${projectId}\0${item.item_id}`).digest('hex')));
        }

        await tx.upsert(catalogRecordId('retrieval_item', `${projectId}\0${item.item_id}`)).content({
          item_id: item.item_id,
          project_id: projectId,
          source_family: sourceFamily,
          source_id: item.source_id,
          content_hash: item.content_hash,
          exact_terms: [...new Set(item.exact_terms)],
          text_hash: textHash,
          title: item.title,
          url: item.url,
          span_start: item.span_start,
          span_end: item.span_end,
          role: item.role,
          ...((vectorUpdate && embeddingModel) || reuseEmbedding ? {
            embedding_model: vectorUpdate ? embeddingModel : prior?.embedding_model,
            embedding_hash: embeddingHash,
          } : {}),
          generation,
        });
      }
      for (const row of plan.removed_items) {
        for (const term of row.exact_terms) {
          await tx.delete(new RecordId('retrieval_exact', createHash('sha256')
            .update(`${projectId}\0${row.item_id}\0${term}`).digest('hex')));
        }
        await tx.delete(catalogRecordId('retrieval_item', `${projectId}\0${row.item_id}`));
        await tx.delete(new RecordId('retrieval_vector', createHash('sha256')
          .update(`${projectId}\0${row.item_id}`).digest('hex')));
      }
      for (const itemId of pruneVectorItemIds) {
        await tx.delete(new RecordId('retrieval_vector', createHash('sha256')
          .update(`${projectId}\0${itemId}`).digest('hex')));
        await tx.update(catalogRecordId('retrieval_item', `${projectId}\0${itemId}`)).merge({
          embedding_model: null,
          embedding_hash: null,
        });
      }
      await tx.upsert(catalogRecordId('retrieval_generation', `${projectId}\0${sourceFamily}`)).content({
        project_id: projectId,
        source_family: sourceFamily,
        generation,
        counts: {
          inserted: plan.inserted,
          updated: plan.updated,
          removed: plan.removed,
          unchanged: plan.unchanged,
        },
        published_at: new Date().toISOString(),
      });
    });
  }

  async listVectorItemIds(
    projectId: string,
    sourceFamily: 'document' | 'code',
  ): Promise<string[]> {
    const db = await this.open();
    const [rows] = await db.query<[Array<{ item_id: string }>]>(
      'SELECT item_id FROM retrieval_vector WHERE project_id = $project_id AND source_family = $source_family',
      { project_id: projectId, source_family: sourceFamily },
    ).collect();
    return rows.map((row) => row.item_id);
  }

  async publishRetrievalGeneration(
    projectId: string,
    sourceFamily: 'document' | 'code',
    generation: string,
    counts: RetrievalDeltaResult,
  ): Promise<void> {
    const db = await this.open();
    await db.upsert(catalogRecordId('retrieval_generation', `${projectId}\0${sourceFamily}`)).content({
      project_id: projectId,
      source_family: sourceFamily,
      generation,
      counts,
      published_at: new Date().toISOString(),
    });
  }

  async replaceExactItems(
    projectId: string,
    sourceFamily: 'document' | 'code',
    items: RetrievalIndexItem[],
  ): Promise<void> {
    const db = await this.open();
    await db.query(
      'DELETE retrieval_exact WHERE project_id = $project_id AND source_family = $source_family',
      { project_id: projectId, source_family: sourceFamily },
    ).collect();
    const exact = items.flatMap((item) => this.exactRows(item));
    for (let index = 0; index < exact.length; index += 250) {
      await db.insert(new Table('retrieval_exact'), exact.slice(index, index + 250));
    }
  }

  async replaceVectorItems(
    projectId: string,
    sourceFamily: 'document' | 'code',
    items: RetrievalIndexItem[],
    embeddingModel: string,
    embeddings: number[][],
  ): Promise<void> {
    if (items.length !== embeddings.length) throw new Error('retrieval item/vector count mismatch');
    const db = await this.open();
    await db.query(
      'DELETE retrieval_vector WHERE project_id = $project_id AND source_family = $source_family',
      { project_id: projectId, source_family: sourceFamily },
    ).collect();
    for (let index = 0; index < items.length; index += 100) {
      const rows = items.slice(index, index + 100).map((item, offset) => (
        this.vectorRow(item, embeddingModel, embeddings[index + offset])
      ));
      await db.insert(new Table('retrieval_vector'), rows);
    }
  }

  async cachedEmbeddings(cacheKeys: string[]): Promise<Map<string, number[]>> {
    if (!cacheKeys.length) return new Map();
    const db = await this.open();
    const rows: Array<{ cache_key: string; embedding: number[] }> = [];
    for (let index = 0; index < cacheKeys.length; index += 500) {
      const [batch] = await db.query<[Array<{ cache_key: string; embedding: number[] }>]>(
        'SELECT cache_key, embedding FROM embedding_cache WHERE cache_key IN $cache_keys',
        { cache_keys: cacheKeys.slice(index, index + 500) },
      ).collect();
      rows.push(...batch);
    }
    return new Map(rows.map((row) => [row.cache_key, row.embedding]));
  }

  async putCachedEmbeddings(rows: Array<{ cache_key: string; embedding: number[] }>): Promise<void> {
    if (!rows.length) return;
    const db = await this.open();
    for (let index = 0; index < rows.length; index += 100) {
      const batch = rows.slice(index, index + 100).map((row) => ({
        id: new RecordId('embedding_cache', row.cache_key),
        ...row,
      }));
      await db.insert(new Table('embedding_cache'), batch).ignore();
    }
  }

  async createSearchEvent(data: Record<string, unknown>): Promise<void> {
    const db = await this.open();
    await db.create(new RecordId('search_event', String(data.search_event_id))).content(data);
  }

  async listRecentSearchEvents(projectId: string, limit = 50): Promise<SearchEventRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[SearchEventRecord[]]>(
      `SELECT * OMIT id FROM search_event
       WHERE project_id = $project_id ORDER BY observed_at DESC LIMIT $limit`,
      { project_id: projectId, limit },
    ).collect();
    return rows;
  }

  async createMetadataObservation(data: Record<string, unknown>): Promise<void> {
    const db = await this.open();
    await db.create(
      new RecordId('metadata_observation', String(data.metadata_observation_id)),
    ).content(data);
  }

  async getSourceSnapshot(snapshotId: string): Promise<ProjectSourceSnapshot | undefined> {
    const db = await this.open();
    const value = await db.select<ProjectSourceSnapshot>(
      new RecordId('project_source_snapshot', snapshotId),
    );
    return value ? withoutId(value as RecordWithId<ProjectSourceSnapshot>) : undefined;
  }

  async listProjectSourceSnapshots(projectId: string): Promise<ProjectSourceSnapshot[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectSourceSnapshot[]]>(
      `SELECT * OMIT id FROM project_source_snapshot
       WHERE project_id = $project_id AND status = 'active' ORDER BY created_at ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async putSourceSnapshot(input: {
    project: ProjectRecord;
    snapshot: ProjectSourceSnapshot;
    entries: Array<Record<string, unknown> & { entry_id: string }>;
    bodies: Array<{ content_hash: string; text: string }>;
  }): Promise<{ reused: boolean; added: number; modified: number; removed: number }> {
    const db = await this.open();
    const snapshotId = new RecordId('project_source_snapshot', input.snapshot.snapshot_id);
    const existingSnapshot = await this.getSourceSnapshot(input.snapshot.snapshot_id);
    if (existingSnapshot && input.project.active_source_snapshot_id === input.snapshot.snapshot_id) {
      return {
        reused: true,
        added: 0,
        modified: 0,
        removed: 0,
      };
    }
    const [current] = await db.query<[Array<Record<string, unknown> & { entry_id: string }>]>(
      'SELECT * OMIT id FROM project_source_entry WHERE project_id = $project_id AND active = true',
      { project_id: input.project.project_id },
    ).collect();
    const before = new Map(current.map((entry) => [entry.entry_id, entry]));
    const after = new Map(input.entries.map((entry) => [entry.entry_id, { ...entry, active: true }]));
    const provisionalAdded = [...after.values()].filter((entry) => !before.has(entry.entry_id));
    const provisionalRemoved = [...before.values()].filter((entry) => !after.has(entry.entry_id));
    const uniqueByContentHash = (
      entries: Array<Record<string, unknown> & { entry_id: string }>,
    ): Map<string, Record<string, unknown> & { entry_id: string }> => {
      const grouped = new Map<string, Array<Record<string, unknown> & { entry_id: string }>>();
      for (const entry of entries) {
        const hash = typeof entry.content_hash === 'string' ? entry.content_hash : undefined;
        if (!hash) continue;
        grouped.set(hash, [...(grouped.get(hash) ?? []), entry]);
      }
      return new Map([...grouped].flatMap(([hash, values]) => values.length === 1
        ? [[hash, values[0]]]
        : []));
    };
    const addedByHash = uniqueByContentHash(provisionalAdded);
    const removedByHash = uniqueByContentHash(provisionalRemoved);
    const movedFrom = new Map<string, Record<string, unknown> & { entry_id: string }>();
    const movedTo = new Map<string, Record<string, unknown> & { entry_id: string }>();
    for (const [hash, addedEntry] of addedByHash) {
      const removedEntry = removedByHash.get(hash);
      if (!removedEntry) continue;
      const oldRoot = String(removedEntry.root ?? '');
      const oldPath = String(removedEntry.path ?? '');
      const oldLocation = oldRoot ? `${oldRoot}/${oldPath}` : oldPath;
      addedEntry.aliases = [...new Set([
        ...((Array.isArray(addedEntry.aliases) ? addedEntry.aliases : []) as string[]),
        oldPath,
        oldLocation,
      ].filter(Boolean))];
      addedEntry.historical_locations = [...new Set([
        ...((Array.isArray(addedEntry.historical_locations)
          ? addedEntry.historical_locations : []) as string[]),
        oldLocation,
      ].filter(Boolean))];
      addedEntry.moved_from_entry_ids = [...new Set([
        ...((Array.isArray(addedEntry.moved_from_entry_ids)
          ? addedEntry.moved_from_entry_ids : []) as string[]),
        removedEntry.entry_id,
      ])];
      movedFrom.set(addedEntry.entry_id, removedEntry);
      movedTo.set(removedEntry.entry_id, addedEntry);
    }
    const signature = (entry: Record<string, unknown>): string => JSON.stringify({
      root: entry.root,
      path: entry.path,
      size: entry.size,
      modified_ms: entry.content_hash ? undefined : entry.modified_ms,
      kind: entry.kind,
      tracked: entry.tracked,
      entry_type: entry.entry_type,
      searchable: entry.searchable,
      sensitive: Boolean(entry.sensitive),
      unreadable: Boolean(entry.unreadable),
      content_hash: entry.content_hash,
      experiment_key: entry.experiment_key,
      role: entry.role,
      aliases: entry.aliases,
      historical_locations: entry.historical_locations,
      moved_from_entry_ids: entry.moved_from_entry_ids,
    });
    const added = [...after.values()].filter((entry) => !before.has(entry.entry_id));
    const modified = [...after.values()].filter((entry) => {
      const previous = before.get(entry.entry_id);
      return previous && signature(previous) !== signature(entry);
    });
    const removed = [...before.values()].filter((entry) => !after.has(entry.entry_id));
    const pendingSnapshot = {
      ...input.snapshot,
      ...(input.project.active_source_snapshot_id
        ? { parent_snapshot_id: input.project.active_source_snapshot_id }
        : {}),
      added_count: added.length,
      modified_count: modified.length,
      removed_count: removed.length,
    };
    if (!existingSnapshot) {
      await db.create(snapshotId).content(pendingSnapshot as unknown as Record<string, unknown>);
    }
    for (let index = 0; index < input.bodies.length; index += 250) {
      const batch = input.bodies.slice(index, index + 250).map((body) => ({
        id: new RecordId('source_body', body.content_hash),
        ...body,
      }));
      await db.insert(new Table('source_body'), batch).ignore();
    }
    const activatedAt = new Date().toISOString();
    const project = {
      ...input.project,
      active_source_snapshot_id: input.snapshot.snapshot_id,
      updated_at: activatedAt,
    };
    await this.transaction(db, async (tx) => {
      for (let index = 0; index < added.length; index += 200) {
        const batch = added.slice(index, index + 200).map((entry) => ({
          id: new RecordId('project_source_entry', `${input.project.project_id}_${entry.entry_id}`),
          ...entry,
          updated_snapshot_id: input.snapshot.snapshot_id,
        }));
        await tx.insert(new Table('project_source_entry'), batch);
      }
      for (const entry of modified) {
        await tx.upsert(new RecordId(
          'project_source_entry', `${input.project.project_id}_${entry.entry_id}`,
        )).content({ ...entry, updated_snapshot_id: input.snapshot.snapshot_id });
      }
      for (const entry of removed) {
        await tx.delete(new RecordId(
          'project_source_entry', `${input.project.project_id}_${entry.entry_id}`,
        ));
      }
      const changes: Array<{
        change: 'added' | 'modified' | 'removed';
        entry: Record<string, unknown> & { entry_id: string };
        before?: Record<string, unknown> & { entry_id: string };
      }> = [
        ...added.map((entry) => ({ change: 'added' as const, entry })),
        ...modified.map((entry) => ({
          change: 'modified' as const,
          entry,
          before: before.get(entry.entry_id),
        })),
        ...removed.map((entry) => ({ change: 'removed' as const, entry })),
      ];
      for (let index = 0; index < changes.length; index += 200) {
        const batch = changes.slice(index, index + 200).map((change) => ({
          id: new RecordId(
            'project_source_change',
            `${input.snapshot.snapshot_id}_${change.entry.entry_id}`,
          ),
          project_id: input.project.project_id,
          snapshot_id: input.snapshot.snapshot_id,
          entry_id: change.entry.entry_id,
          change: change.change,
          entry: change.entry,
          ...(change.before ? { before: change.before } : {}),
          ...(movedFrom.has(change.entry.entry_id)
            ? { moved_from_entry_id: movedFrom.get(change.entry.entry_id)!.entry_id }
            : {}),
          ...(movedTo.has(change.entry.entry_id)
            ? { moved_to_entry_id: movedTo.get(change.entry.entry_id)!.entry_id }
            : {}),
        }));
        await tx.insert(new Table('project_source_change'), batch).ignore();
      }
      await tx.update(snapshotId).merge({ status: 'active', activated_at: activatedAt });
      await tx.upsert(new RecordId('project', input.project.project_id)).content(project);
    });
    return { reused: false, added: added.length, modified: modified.length, removed: removed.length };
  }

  async listProjectSourceEntries(projectId: string): Promise<ProjectSourceEntryRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectSourceEntryRecord[]]>(
      `SELECT entry_id, project_id, root, path, kind, entry_type, searchable,
        size, modified_ms, tracked, sensitive, unreadable,
        content_hash, experiment_key, role, aliases, historical_locations,
        moved_from_entry_ids, updated_snapshot_id
       FROM project_source_entry
       WHERE project_id = $project_id AND active = true ORDER BY root ASC, path ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async getProjectSourceRecord(
    projectId: string,
    entryId: string,
    bodyStart = 0,
    bodyBytes = 64 * 1024,
  ): Promise<SourceRecordReadback | undefined> {
    const db = await this.open();
    const selected = await db.select<ProjectSourceEntryRecord & { active?: boolean }>(
      new RecordId('project_source_entry', `${projectId}_${entryId}`),
    );
    if (!selected || selected.project_id !== projectId || selected.active !== true) return undefined;
    const { active: _active, ...entry } = selected;
    if (!entry.content_hash || !entry.searchable || entry.sensitive) return { source: true, entry };
    if (bodyBytes === 0) {
      const start = Math.max(0, Math.min(bodyStart, entry.size));
      return {
        source: true,
        entry,
        body_span: { start, end: start, total_bytes: entry.size },
        omitted_fields: ['body'],
      };
    }
    const [bodies] = await db.query<[Array<{ text: string }>]>(
      'SELECT text FROM source_body WHERE content_hash = $content_hash LIMIT 1',
      { content_hash: entry.content_hash },
    ).collect();
    if (!bodies[0]) return { source: true, entry };
    const page = utf8Page(bodies[0].text, bodyStart, bodyBytes);
    return {
      source: true,
      entry,
      body: page.body,
      body_span: page.span,
      ...(page.next !== undefined ? { next_body_offset: page.next } : {}),
    };
  }

  async listCodeSourceEntries(projectId: string): Promise<CodeSourceManifestEntry[]> {
    const db = await this.open();
    const [entries] = await db.query<[CodeSourceManifestEntry[]]>(
      `SELECT entry_id, path, root, tracked, size, content_hash FROM project_source_entry
       WHERE project_id = $project_id AND active = true AND searchable = true
         AND kind = 'source' AND content_hash != NONE`,
      { project_id: projectId },
    ).collect();
    const vendor = /(^|\/)(?:vendor|vendors|third_party|third-party|external|node_modules|llama[^/]*src)(\/|$)/i;
    entries.sort((a, b) => {
      const priority = (entry: typeof a): number => (
        entry.tracked || entry.root === 'repo'
          ? 0
          : vendor.test(entry.path.replace(/\\/g, '/')) ? 2 : 1
      );
      return priority(a) - priority(b) || a.path.localeCompare(b.path)
        || a.entry_id.localeCompare(b.entry_id);
    });
    return entries;
  }

  async loadCodeSourceBodies(entries: CodeSourceManifestEntry[]): Promise<Array<{
    source_entry_id: string;
    path: string;
    text: string;
    root: string;
    tracked: boolean;
  }>> {
    const db = await this.open();
    const hashes = [...new Set(entries.map((entry) => entry.content_hash))];
    const bodies: Array<{ content_hash: string; text: string }> = [];
    for (let index = 0; index < hashes.length; index += 500) {
      const [batch] = await db.query<[Array<{ content_hash: string; text: string }>]>(
        `SELECT content_hash, text FROM source_body WHERE content_hash IN $hashes`,
        { hashes: hashes.slice(index, index + 500) },
      ).collect();
      bodies.push(...batch);
    }
    const texts = new Map(bodies.map((body) => [body.content_hash, body.text]));
    return entries.flatMap((entry) => {
      const text = texts.get(entry.content_hash);
      return text === undefined ? [] : [{
        source_entry_id: entry.entry_id,
        path: entry.path,
        text,
        root: entry.root,
        tracked: entry.tracked,
      }];
    });
  }

  async listCodeSourceBodies(projectId: string): Promise<{
    sources: Array<{
      source_entry_id: string;
      path: string;
      text: string;
      root: string;
      tracked: boolean;
    }>;
    deferred: number;
  }> {
    const entries = await this.listCodeSourceEntries(projectId);
    const sources = await this.loadCodeSourceBodies(entries);
    return { sources, deferred: entries.length - sources.length };
  }

  async listProjectSourceBodies(projectId: string): Promise<Array<{
    entry_id: string;
    path: string;
    root: string;
    content_hash: string;
    text: string;
    role?: ProjectSourceEntryRecord['role'];
    aliases?: string[];
  }>> {
    const db = await this.open();
    const [entries] = await db.query<[Array<{
      entry_id: string;
      path: string;
      root: string;
      content_hash: string;
      role?: ProjectSourceEntryRecord['role'];
      aliases?: string[];
    }>]>(
      `SELECT entry_id, path, root, content_hash, role, aliases FROM project_source_entry
       WHERE project_id = $project_id AND active = true AND searchable = true
         AND content_hash != NONE ORDER BY root ASC, path ASC`,
      { project_id: projectId },
    ).collect();
    const hashes = [...new Set(entries.map((entry) => entry.content_hash))];
    const bodies: Array<{ content_hash: string; text: string }> = [];
    for (let index = 0; index < hashes.length; index += 500) {
      const [batch] = await db.query<[Array<{ content_hash: string; text: string }>]>(
        'SELECT content_hash, text FROM source_body WHERE content_hash IN $hashes',
        { hashes: hashes.slice(index, index + 500) },
      ).collect();
      bodies.push(...batch);
    }
    const texts = new Map(bodies.map((body) => [body.content_hash, body.text]));
    return entries.flatMap((entry) => {
      const text = texts.get(entry.content_hash);
      return text === undefined ? [] : [{ ...entry, text }];
    });
  }

  async listProjectDocuments(projectId: string): Promise<ProjectDocumentRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectDocumentRecord[]]>(
      `SELECT project_id, document_id, state,
        (SELECT VALUE title FROM ONLY type::record('document', $parent.document_id)) AS title,
        (SELECT VALUE canonical_url FROM ONLY type::record('document', $parent.document_id)) AS url,
        (SELECT VALUE scholar_id FROM ONLY type::record('document', $parent.document_id)) AS scholar_id
       FROM project_document WHERE project_id = $project_id ORDER BY document_id ASC`,
      { project_id: projectId },
    ).collect();
    const documentIds = rows.map((row) => row.document_id);
    const [chunks] = documentIds.length
      ? await db.query<[Array<{ document_id: string; chunk_index: number; text: string }>]>(
        `SELECT document_id, chunk_index, text FROM chunk
         WHERE document_id IN $document_ids AND (
           chunk_set_id IN (
             SELECT VALUE active_chunk_set_id FROM project_document
             WHERE project_id = $project_id AND active_chunk_set_id != NONE
           ) OR document_id IN (
             SELECT VALUE document_id FROM project_document
             WHERE project_id = $project_id AND active_chunk_set_id = NONE
           )
         ) ORDER BY document_id ASC, chunk_index ASC`,
        { project_id: projectId, document_ids: documentIds },
      ).collect()
      : [[]];
    const firstText = new Map<string, string>();
    for (const chunk of chunks) {
      if (!firstText.has(chunk.document_id)) firstText.set(chunk.document_id, chunk.text);
    }
    return rows.map((row) => ({ ...row, text: firstText.get(row.document_id) }));
  }

  async getProjectDocumentRecord(
    projectId: string,
    documentId: string,
    bodyStart = 0,
    bodyBytes = 64 * 1024,
  ): Promise<DocumentRecordReadback | undefined> {
    const db = await this.open();
    const membership = await db.select<{
      project_id: string;
      document_id: string;
      state: 'lexical_active' | 'metadata_archive';
      active_chunk_set_id?: string;
    }>(new RecordId('project_document', `${projectId}_${documentId}`));
    if (!membership || membership.project_id !== projectId || membership.document_id !== documentId) {
      return undefined;
    }
    const document = await db.select<{
      title?: string;
      canonical_url?: string;
      scholar_id?: string;
    }>(new RecordId('document', documentId));
    if (!document) return undefined;
    const record: ProjectDocumentRecord = {
      project_id: projectId,
      document_id: documentId,
      state: membership.state,
      title: document.title ?? documentId,
      url: document.canonical_url ?? '',
      ...(document.scholar_id ? { scholar_id: document.scholar_id } : {}),
    };
    if (membership.state !== 'lexical_active') return { document: true, record };
    const [chunks] = membership.active_chunk_set_id
      ? await db.query<[Array<{ chunk_index: number; text: string }>]>(
        `SELECT chunk_index, text FROM chunk
         WHERE document_id = $document_id AND chunk_set_id = $chunk_set_id
         ORDER BY chunk_index ASC`,
        { document_id: documentId, chunk_set_id: membership.active_chunk_set_id },
      ).collect()
      : await db.query<[Array<{ chunk_index: number; text: string }>]>(
        `SELECT chunk_index, text FROM chunk
         WHERE document_id = $document_id AND chunk_set_id = NONE
         ORDER BY chunk_index ASC`,
        { document_id: documentId },
      ).collect();
    if (!chunks.length) return { document: true, record };
    if (bodyBytes === 0) {
      const totalBytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, 'utf8'), 0);
      const start = Math.max(0, Math.min(bodyStart, totalBytes));
      return {
        document: true,
        record,
        body_span: { start, end: start, total_bytes: totalBytes },
        omitted_fields: ['body'],
      };
    }
    const page = utf8Page(chunks.map((chunk) => chunk.text).join(''), bodyStart, bodyBytes);
    return {
      document: true,
      record,
      body: page.body,
      body_span: page.span,
      ...(page.next !== undefined ? { next_body_offset: page.next } : {}),
    };
  }

  async listProjectDocumentChunks(projectId: string): Promise<ProjectDocumentChunkRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectDocumentChunkRecord[]]>(
      `SELECT document_id, chunk_index, title, url, text, content_hash FROM chunk
       WHERE document_id IN (
         SELECT VALUE document_id FROM project_document
         WHERE project_id = $project_id AND state = 'lexical_active'
       ) AND (
         chunk_set_id IN (
           SELECT VALUE active_chunk_set_id FROM project_document
           WHERE project_id = $project_id AND active_chunk_set_id != NONE
         ) OR document_id IN (
           SELECT VALUE document_id FROM project_document
           WHERE project_id = $project_id AND active_chunk_set_id = NONE
         )
       )
       ORDER BY document_id ASC, chunk_index ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async listProjectSessions(projectId: string): Promise<MemorySessionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[MemorySessionRecord[]]>(
      `SELECT * OMIT id FROM memory_session
       WHERE project_id = $project_id ORDER BY created_at ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async listProjectIntents(projectId: string): Promise<IntentRevisionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[IntentRevisionRecord[]]>(
      `SELECT * OMIT id FROM intent_revision
       WHERE project_id = $project_id ORDER BY created_at ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async listAssertions(projectId: string): Promise<AssertionRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[AssertionRecord[]]>(
      `SELECT * OMIT id FROM assertion
       WHERE project_id = $project_id AND status IN ['suggested', 'confirmed']
       ORDER BY recorded_at ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
  }

  async findAssertion(input: {
    projectId: string;
    subject: string;
    predicate: string;
    object?: string;
    value?: string | number | boolean | null;
  }): Promise<AssertionRecord | undefined> {
    const db = await this.open();
    const [rows] = await db.query<[AssertionRecord[]]>(
      `SELECT * OMIT id FROM assertion
       WHERE project_id = $project_id AND subject = $subject AND predicate = $predicate
         AND object = $object AND value = $value
         AND status IN ['suggested', 'confirmed'] LIMIT 1`,
      {
        project_id: input.projectId,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        value: input.value,
      },
    ).collect();
    return rows[0];
  }

  private async hydrateRetrieval(
    references: RetrievalReference[],
    retrievalFamily: 'exact' | 'vector',
  ): Promise<LocalSearchHit[]> {
    if (!references.length) return [];
    const db = await this.open();
    const documentReferences = references.filter((row) => row.source_family === 'document');
    const documentIds = [...new Set(documentReferences.map((row) => row.source_id))];
    const documentHashes = [...new Set(documentReferences.map((row) => row.content_hash))];
    const sourceIds = [...new Set(references
      .filter((row) => row.source_family === 'code').map((row) => row.source_id))];
    const projectIds = [...new Set(references.map((row) => row.project_id))];
    const [documentRows] = documentIds.length
      ? await db.query<[Array<{ document_id: string; text: string; content_hash: string }>]>(
        `SELECT document_id, text, content_hash FROM chunk
         WHERE document_id IN $document_ids AND content_hash IN $content_hashes`,
        { document_ids: documentIds, content_hashes: documentHashes },
      ).collect()
      : [[]];
    const [documentMetadata] = documentIds.length
      ? await db.query<[Array<{
        document_id: string;
        kind?: string;
        updated_at?: string;
        catalog_asset_id?: string;
        catalog_revision_id?: string;
      }>]>(
        `SELECT document_id, kind, updated_at, catalog_asset_id, catalog_revision_id
         FROM document WHERE document_id IN $document_ids`,
        { document_ids: documentIds },
      ).collect()
      : [[]];
    const [sourceEntries] = sourceIds.length
      ? await db.query<[Array<{
        entry_id: string;
        project_id: string;
        root: string;
        path: string;
        content_hash: string;
        role?: ProjectDocumentRole;
      }>]>(
        `SELECT entry_id, project_id, root, path, content_hash, role FROM project_source_entry
         WHERE project_id IN $project_ids AND entry_id IN $source_ids
           AND active = true AND searchable = true`,
        { project_ids: projectIds, source_ids: sourceIds },
      ).collect()
      : [[]];
    const hashes = [...new Set(sourceEntries.map((row) => row.content_hash))];
    const [sourceBodies] = hashes.length
      ? await db.query<[Array<{ content_hash: string; text: string }>]>(
        'SELECT content_hash, text FROM source_body WHERE content_hash IN $hashes',
        { hashes },
      ).collect()
      : [[]];
    const documents = new Map(documentRows.map((row) => [
      `${row.document_id}\0${row.content_hash}`,
      row,
    ]));
    const metadata = new Map(documentMetadata.map((row) => [row.document_id, row]));
    const entries = new Map(sourceEntries.map((row) => [`${row.project_id}\0${row.entry_id}`, row]));
    const bodies = new Map(sourceBodies.map((row) => [row.content_hash, row.text]));
    return references.flatMap<LocalSearchHit>((reference) => {
      if (reference.source_family === 'document') {
        const row = documents.get(`${reference.source_id}\0${reference.content_hash}`);
        if (!row) return [];
        const document = metadata.get(reference.source_id);
        const recordId = document?.catalog_asset_id ?? reference.source_id;
        return [{
          document_id: reference.source_id,
          record_id: recordId,
          body_handle: recordId,
          ...(document?.catalog_revision_id ? { revision_id: document.catalog_revision_id } : {}),
          index_freshness: 'current' as const,
          title: reference.title,
          url: reference.url,
          description: row.text.slice(0, 500),
          content: row.text,
          score: reference.score,
          project_ids: [reference.project_id],
          source_family: 'document' as const,
          retrieval_family: retrievalFamily,
          kind: document?.kind,
          recorded_at: document?.updated_at,
        }];
      }
      const entry = entries.get(`${reference.project_id}\0${reference.source_id}`);
      if (!entry || entry.content_hash !== reference.content_hash) return [];
      const text = bodies.get(entry.content_hash);
      if (!text) return [];
      const start = Math.max(0, Math.min(reference.span_start ?? 0, text.length));
      const end = Math.max(start, Math.min(reference.span_end ?? text.length, text.length));
      const matched = text.slice(start, end);
      return [{
        document_id: `source-${entry.content_hash.slice(0, 24)}`,
        record_id: entry.entry_id,
        body_handle: entry.entry_id,
        source_span: { start, end },
        index_freshness: 'current' as const,
        title: `${entry.root}/${entry.path}`,
        url: reference.url,
        description: matched.slice(0, 500),
        content: matched,
        score: reference.score,
        project_ids: [reference.project_id],
        source_family: 'code' as const,
        retrieval_family: retrievalFamily,
        kind: 'source',
        role: entry.role ?? reference.role as ProjectDocumentRole | undefined,
      }];
    }).filter((row, index, rows) => rows.findIndex((candidate) => (
      candidate.source_family === row.source_family
      && candidate.document_id === row.document_id
      && candidate.project_ids[0] === row.project_ids[0]
    )) === index);
  }

  async searchProjectExact(
    projectId: string,
    normalizedQuery: string,
    limit: number,
  ): Promise<LocalSearchHit[]> {
    const db = await this.open();
    const candidateLimit = Math.min(100, Math.max(limit * 4, limit));
    const [rows] = await db.query<[RetrievalReference[]]>(
      `SELECT item_id, project_id, source_family, source_id, title, url, content_hash,
         span_start, span_end, role,
         1 AS score FROM retrieval_exact
       WHERE project_id = $project_id AND normalized_term = $normalized_query
       ORDER BY title ASC LIMIT $limit`,
      { project_id: projectId, normalized_query: normalizedQuery, limit: candidateLimit },
    ).collect();
    const distinct = rows.filter((row, index) => rows.findIndex((candidate) => (
      candidate.project_id === row.project_id
      && candidate.source_family === row.source_family
      && candidate.source_id === row.source_id
    )) === index).slice(0, limit);
    return await this.hydrateRetrieval(distinct, 'exact');
  }

  async searchProjectVector(
    projectId: string,
    embeddingModel: string,
    embedding: number[],
    limit: number,
  ): Promise<LocalSearchHit[]> {
    const db = await this.open();
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    if (this.vectorBackend === 'exhaustive') {
      const ranked: Array<RetrievalReference & { embedding?: number[] }> = [];
      const pageSize = 500;
      const maxRows = 100_000;
      for (let offset = 0; offset < maxRows; offset += pageSize) {
        const [page] = await db.query<[Array<Omit<RetrievalReference, 'score'> & { embedding: number[] }>]>(
          `SELECT item_id, project_id, source_family, source_id, title, url, content_hash,
             span_start, span_end, role, embedding
           FROM retrieval_vector
           WHERE project_id = $project_id AND embedding_model = $embedding_model
           ORDER BY item_id ASC LIMIT $page_size START $offset`,
          { project_id: projectId, embedding_model: embeddingModel, page_size: pageSize, offset },
        ).collect();
        for (const row of page) ranked.push({ ...row, score: cosineSimilarity(row.embedding, embedding) });
        if (page.length < pageSize) break;
      }
      const references = ranked.sort((left, right) => (
        stableVectorScore(right.score) - stableVectorScore(left.score)
          || left.item_id.localeCompare(right.item_id)
      ))
        .filter((row, index, values) => values.findIndex((candidate) => (
          candidate.project_id === row.project_id
          && candidate.source_family === row.source_family
          && candidate.source_id === row.source_id
        )) === index)
        .slice(0, cappedLimit)
        .map(({ embedding: _embedding, ...row }) => row);
      return await this.hydrateRetrieval(references, 'vector');
    }
    type KnnRow = Omit<RetrievalReference, 'score'> & { distance: number };
    const queryKnn = async (queryLimit: number): Promise<KnnRow[]> => {
      const rawLimit = Math.min(100, Math.max(queryLimit * 4, queryLimit));
      const [rows] = await db.query<[KnnRow[]]>(
        `SELECT item_id, project_id, source_family, source_id, title, url, content_hash,
           span_start, span_end, role,
           vector::distance::knn() AS distance
         FROM retrieval_vector
         WHERE project_id = $project_id AND embedding_model = $embedding_model
           AND embedding <|${rawLimit}, ${HNSW_SEARCH_EF}|> $embedding
         ORDER BY distance ASC, item_id ASC LIMIT $limit`,
        { project_id: projectId, embedding_model: embeddingModel, embedding, limit: rawLimit },
      ).collect();
      return rows.sort((left, right) => (
        stableVectorScore(left.distance) - stableVectorScore(right.distance)
          || left.item_id.localeCompare(right.item_id)
      )).filter((row, index, values) => values.findIndex((candidate) => (
        candidate.project_id === row.project_id
        && candidate.source_family === row.source_family
        && candidate.source_id === row.source_id
      )) === index).slice(0, queryLimit);
    };
    const pageLimit = Math.min(cappedLimit, 10);
    const pageRows = await queryKnn(pageLimit);
    const expandedRows = cappedLimit > pageLimit ? await queryKnn(cappedLimit) : [];
    const rows = [...pageRows, ...expandedRows].filter((row, index, values) => values.findIndex((candidate) => (
      candidate.project_id === row.project_id
      && candidate.source_family === row.source_family
      && candidate.source_id === row.source_id
    )) === index).slice(0, cappedLimit);
    const references = rows.map((row) => ({
      ...row,
      score: 1 - Number(row.distance),
    }));
    return await this.hydrateRetrieval(references, 'vector');
  }

  private async searchProjectSources(
    projectId: string,
    snapshotId: string | undefined,
    query: string,
    limit: number,
  ): Promise<LocalSearchHit[]> {
    if (!snapshotId) return [];
    const db = await this.open();
    const candidateLimit = Math.min(Math.max(limit * 20, 100), 500);
    const [rows] = await db.query<[Array<{
      content_hash: string;
      text: string;
      score: number;
    }>]>(
      `SELECT content_hash, text, search::score(0) AS score
       FROM source_body
       WHERE text @0@ $query
       ORDER BY score DESC, content_hash ASC LIMIT $limit`,
      { query, limit: candidateLimit },
    ).collect();
    if (!rows.length) return [];
    const hashes = rows.map((row) => row.content_hash);
    const [entries] = await db.query<[Array<{
      entry_id: string;
      root: string;
      path: string;
      content_hash: string;
      role?: ProjectDocumentRole;
    }>]>(
      `SELECT entry_id, root, path, content_hash, role FROM project_source_entry
       WHERE project_id = $project_id
         AND active = true AND searchable = true AND content_hash IN $hashes
       ORDER BY path ASC`,
      { project_id: projectId, hashes },
    ).collect();
    const firstPath = new Map<string, {
      entry_id: string; root: string; path: string; role?: ProjectDocumentRole;
    }>();
    for (const entry of entries) {
      if (!firstPath.has(entry.content_hash)) firstPath.set(entry.content_hash, entry);
    }
    return rows.flatMap((row) => {
      const entry = firstPath.get(row.content_hash);
      if (!entry) return [];
      return [{
        document_id: `source-${row.content_hash.slice(0, 24)}`,
        record_id: entry.entry_id,
        body_handle: entry.entry_id,
        source_span: { start: 0, end: row.text.length },
        index_freshness: 'current' as const,
        title: `${entry.root}/${entry.path}`,
        url: `surf://projects/${projectId}/files/${entry.entry_id}`,
        description: row.text.slice(0, 500),
        content: row.text,
        score: Number(row.score),
        project_ids: [projectId],
        source_family: 'code' as const,
        retrieval_family: 'bm25' as const,
        kind: 'source',
        role: entry.role,
      }];
    }).slice(0, limit);
  }

  async searchProjectBm25(projectId: string, query: string, limit: number): Promise<LocalSearchHit[]> {
    const db = await this.open();
    const project = await this.getProject(projectId);
    const [rows] = await db.query<[Array<{
      document_id: string;
      chunk_index: number;
      title: string;
      url: string;
      text: string;
      score: number;
    }>]>(
      `SELECT document_id, chunk_index, title, url, text, search::score(0) AS score
       FROM chunk
       WHERE text @0@ $query
         AND document_id IN (
           SELECT VALUE document_id FROM project_document
           WHERE project_id = $project_id AND state = 'lexical_active'
         )
         AND (
           chunk_set_id IN (
             SELECT VALUE active_chunk_set_id FROM project_document
             WHERE project_id = $project_id AND active_chunk_set_id != NONE
           ) OR document_id IN (
             SELECT VALUE document_id FROM project_document
             WHERE project_id = $project_id AND active_chunk_set_id = NONE
           )
         )
       ORDER BY score DESC, document_id ASC, chunk_index ASC LIMIT $chunk_limit`,
      { project_id: projectId, query, chunk_limit: Math.min(100, limit * 4) },
    ).collect();
    const documentIds = [...new Set(rows.map((row) => row.document_id))];
    const [documentMetadata] = documentIds.length
      ? await db.query<[Array<{
        document_id: string;
        kind?: string;
        updated_at?: string;
        catalog_asset_id?: string;
        catalog_revision_id?: string;
      }>]>(
        `SELECT document_id, kind, updated_at, catalog_asset_id, catalog_revision_id
         FROM document WHERE document_id IN $document_ids`,
        { document_ids: documentIds },
      ).collect()
      : [[]];
    const metadata = new Map(documentMetadata.map((row) => [row.document_id, row]));
    const documents = rows.filter((row, index) => (
      rows.findIndex((candidate) => candidate.document_id === row.document_id) === index
    )).map((row) => ({
      document_id: row.document_id,
      record_id: metadata.get(row.document_id)?.catalog_asset_id ?? row.document_id,
      body_handle: metadata.get(row.document_id)?.catalog_asset_id ?? row.document_id,
      ...(metadata.get(row.document_id)?.catalog_revision_id
        ? { revision_id: metadata.get(row.document_id)!.catalog_revision_id }
        : {}),
      index_freshness: 'current' as const,
      title: row.title,
      url: row.url,
      description: row.text.slice(0, 500),
      content: row.text,
      score: Number(row.score),
      project_ids: [projectId],
      source_family: 'document' as const,
      retrieval_family: 'bm25' as const,
      kind: metadata.get(row.document_id)?.kind,
      recorded_at: metadata.get(row.document_id)?.updated_at,
    }));
    const sources = await this.searchProjectSources(
      projectId,
      project?.active_source_snapshot_id,
      query,
      limit,
    );
    const fused = [...documents.map((row, index) => ({ row, score: 1 / (60 + index + 1) })),
      ...sources.map((row, index) => ({ row, score: 1 / (60 + index + 1) }))];
    return fused.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title))
      .slice(0, limit)
      .map(({ row }) => row);
  }

  async searchProject(projectId: string, query: string, limit: number): Promise<LocalSearchHit[]> {
    return await this.searchProjectBm25(projectId, query, limit);
  }

  async counts(projectId: string): Promise<{
    searchEvents: number;
    documents: number;
    citationObservations: number;
    sourceEntries: number;
    sessions: number;
    plans: number;
    experiments: number;
    decisions: number;
  }> {
    const db = await this.open();
    const [events, documents, citations, sources, sessions, plans, experiments, decisions] = await db.query<[
      Array<{ count: number }>, Array<{ count: number }>, Array<{ count: number }>,
      Array<{ count: number }>, Array<{ count: number }>, Array<{ count: number }>,
      Array<{ count: number }>, Array<{ count: number }>,
    ]>(
      `SELECT count() AS count FROM search_event WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM project_document WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM metadata_observation
       WHERE project_id = $project_id AND kind = 'citation_count' GROUP ALL;
       SELECT count() AS count FROM project_source_entry
       WHERE project_id = $project_id AND active = true GROUP ALL;
       SELECT count() AS count FROM memory_session WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM plan_revision WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM experiment_run WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM decision WHERE project_id = $project_id GROUP ALL;`,
      { project_id: projectId },
    ).collect();
    return {
      searchEvents: Number(events[0]?.count ?? 0),
      documents: Number(documents[0]?.count ?? 0),
      citationObservations: Number(citations[0]?.count ?? 0),
      sourceEntries: Number(sources[0]?.count ?? 0),
      sessions: Number(sessions[0]?.count ?? 0),
      plans: Number(plans[0]?.count ?? 0),
      experiments: Number(experiments[0]?.count ?? 0),
      decisions: Number(decisions[0]?.count ?? 0),
    };
  }
}

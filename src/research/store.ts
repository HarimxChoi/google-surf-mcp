import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { RecordId, Table, type Surreal, type SurrealTransaction } from 'surrealdb';
import { isRetryableTransactionError, isTransactionConflict } from './errors.js';
import type {
  AssertionCorrectionRecord, AssertionRecord, CodeRelationRecord, CodeSymbolRecord,
  DecisionRecord, EvidenceRecord,
  EntityAliasRecord, EntityOperationRecord, EntityRecord, ExperimentRunRecord,
  GraphAnalysis, GraphArtifact, GraphProjection, IntentRevisionRecord,
  KnowledgeJobRecord, KnowledgeJobStatus,
  LocalSearchHit, MemorySessionRecord, OntologyTermRecord, PlanRevisionRecord,
  ProjectDocumentChunkRecord, ProjectDocumentRecord, ProjectRecord,
  ProjectSourceEntryRecord, ProjectSourceSnapshot,
  RetrievalIndexItem, SearchEventRecord,
} from './contracts.js';

const SCHEMA = `
DEFINE TABLE IF NOT EXISTS project SCHEMALESS;
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
  DEFINE TABLE IF NOT EXISTS embedding_cache SCHEMALESS;
DEFINE ANALYZER IF NOT EXISTS research_text TOKENIZERS blank,class,camel FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS chunk_text ON TABLE chunk FIELDS text FULLTEXT ANALYZER research_text BM25;
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
  DEFINE INDEX IF NOT EXISTS retrieval_vector_embedding ON TABLE retrieval_vector FIELDS embedding HNSW DIMENSION 384 TYPE F32 DIST COSINE;
  DEFINE INDEX IF NOT EXISTS embedding_cache_key ON TABLE embedding_cache FIELDS cache_key UNIQUE;
`;

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
}

function withoutId<T extends object>(record: RecordWithId<T>): T {
  const { id: _id, ...value } = record;
  return value as T;
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
    private readonly queryTimeoutMs = 30_000,
  ) {}

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
    const connect = db.connect(this.endpoint, { namespace: 'google_surf', database: 'research' });
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
        active_plan_revision_id, active_source_snapshot_id, active_code_snapshot_id,
        active_graph_projection_id,
        graph_dirty_at, active_graph_dirty_at
       FROM project WHERE status = NONE OR status = 'active' ORDER BY updated_at DESC`,
    ).collect();
    return rows;
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

  async putPlan(project: ProjectRecord, plan: PlanRevisionRecord): Promise<void> {
    const db = await this.open();
    const nextProject = {
      ...project,
      active_plan_revision_id: plan.plan_revision_id,
      updated_at: plan.created_at,
    };
    await db.query(
      'BEGIN TRANSACTION; CREATE ONLY $plan_id CONTENT $plan; UPSERT $project_id CONTENT $project; COMMIT TRANSACTION;',
      {
        plan_id: new RecordId('plan_revision', plan.plan_revision_id),
        plan,
        project_id: new RecordId('project', project.project_id),
        project: nextProject,
      },
    ).collect();
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
    await db.update(new RecordId('project', projectId)).merge({ graph_dirty_at: marker });
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
        content_hash, experiment_key, updated_snapshot_id
       FROM project_source_entry
       WHERE project_id = $project_id AND active = true ORDER BY root ASC, path ASC`,
      { project_id: projectId },
    ).collect();
    return rows;
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
  }>> {
    const db = await this.open();
    const [entries] = await db.query<[Array<{
      entry_id: string;
      path: string;
      root: string;
      content_hash: string;
    }>]>(
      `SELECT entry_id, path, root, content_hash FROM project_source_entry
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
         WHERE document_id IN $document_ids ORDER BY document_id ASC, chunk_index ASC`,
        { document_ids: documentIds },
      ).collect()
      : [[]];
    const firstText = new Map<string, string>();
    for (const chunk of chunks) {
      if (!firstText.has(chunk.document_id)) firstText.set(chunk.document_id, chunk.text);
    }
    return rows.map((row) => ({ ...row, text: firstText.get(row.document_id) }));
  }

  async listProjectDocumentChunks(projectId: string): Promise<ProjectDocumentChunkRecord[]> {
    const db = await this.open();
    const [rows] = await db.query<[ProjectDocumentChunkRecord[]]>(
      `SELECT document_id, chunk_index, title, url, text, content_hash FROM chunk
       WHERE document_id IN (
         SELECT VALUE document_id FROM project_document
         WHERE project_id = $project_id AND state = 'lexical_active'
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
    const [sourceEntries] = sourceIds.length
      ? await db.query<[Array<{
        entry_id: string;
        project_id: string;
        root: string;
        path: string;
        content_hash: string;
      }>]>(
        `SELECT entry_id, project_id, root, path, content_hash FROM project_source_entry
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
    const entries = new Map(sourceEntries.map((row) => [`${row.project_id}\0${row.entry_id}`, row]));
    const bodies = new Map(sourceBodies.map((row) => [row.content_hash, row.text]));
    return references.flatMap<LocalSearchHit>((reference) => {
      if (reference.source_family === 'document') {
        const row = documents.get(`${reference.source_id}\0${reference.content_hash}`);
        if (!row) return [];
        return [{
          document_id: reference.source_id,
          title: reference.title,
          url: reference.url,
          description: row.text.slice(0, 500),
          content: row.text,
          score: reference.score,
          project_ids: [reference.project_id],
          source_family: 'document' as const,
          retrieval_family: retrievalFamily,
        }];
      }
      const entry = entries.get(`${reference.project_id}\0${reference.source_id}`);
      if (!entry || entry.content_hash !== reference.content_hash) return [];
      const text = bodies.get(entry.content_hash);
      if (!text) return [];
      return [{
        document_id: `source-${entry.content_hash.slice(0, 24)}`,
        title: `${entry.root}/${entry.path}`,
        url: reference.url,
        description: text.slice(0, 500),
        content: text,
        score: reference.score,
        project_ids: [reference.project_id],
        source_family: 'code' as const,
        retrieval_family: retrievalFamily,
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
    const [rows] = await db.query<[Array<Omit<RetrievalReference, 'score'> & { distance: number }>]>(
      `SELECT item_id, project_id, source_family, source_id, title, url, content_hash,
         vector::distance::knn() AS distance
       FROM retrieval_vector
       WHERE project_id = $project_id AND embedding_model = $embedding_model
         AND embedding <|${cappedLimit}, 100|> $embedding
       ORDER BY distance ASC LIMIT $limit`,
      { project_id: projectId, embedding_model: embeddingModel, embedding, limit: cappedLimit },
    ).collect();
    const references = rows.map((row) => ({
      ...row,
      score: 1 - Number(row.distance),
    })).filter((row, index, values) => values.findIndex((candidate) => (
      candidate.project_id === row.project_id
      && candidate.source_family === row.source_family
      && candidate.source_id === row.source_id
    )) === index).slice(0, cappedLimit);
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
       ORDER BY score DESC LIMIT $limit`,
      { query, limit: candidateLimit },
    ).collect();
    if (!rows.length) return [];
    const hashes = rows.map((row) => row.content_hash);
    const [entries] = await db.query<[Array<{
      entry_id: string;
      root: string;
      path: string;
      content_hash: string;
    }>]>(
      `SELECT entry_id, root, path, content_hash FROM project_source_entry
       WHERE project_id = $project_id
         AND active = true AND searchable = true AND content_hash IN $hashes
       ORDER BY path ASC`,
      { project_id: projectId, hashes },
    ).collect();
    const firstPath = new Map<string, { entry_id: string; root: string; path: string }>();
    for (const entry of entries) {
      if (!firstPath.has(entry.content_hash)) firstPath.set(entry.content_hash, entry);
    }
    return rows.flatMap((row) => {
      const entry = firstPath.get(row.content_hash);
      if (!entry) return [];
      return [{
        document_id: `source-${row.content_hash.slice(0, 24)}`,
        title: `${entry.root}/${entry.path}`,
        url: `surf://projects/${projectId}/files/${entry.entry_id}`,
        description: row.text.slice(0, 500),
        content: row.text,
        score: Number(row.score),
        project_ids: [projectId],
        source_family: 'code' as const,
        retrieval_family: 'bm25' as const,
      }];
    }).slice(0, limit);
  }

  async searchProjectBm25(projectId: string, query: string, limit: number): Promise<LocalSearchHit[]> {
    const db = await this.open();
    const project = await this.getProject(projectId);
    const [rows] = await db.query<[Array<{
      document_id: string;
      title: string;
      url: string;
      text: string;
      score: number;
    }>]>(
      `SELECT document_id, title, url, text, search::score(0) AS score
       FROM chunk
       WHERE text @0@ $query
         AND document_id IN (
           SELECT VALUE document_id FROM project_document
           WHERE project_id = $project_id AND state = 'lexical_active'
         )
       ORDER BY score DESC LIMIT $chunk_limit`,
      { project_id: projectId, query, chunk_limit: Math.min(100, limit * 4) },
    ).collect();
    const documents = rows.filter((row, index) => (
      rows.findIndex((candidate) => candidate.document_id === row.document_id) === index
    )).map((row) => ({
      document_id: row.document_id,
      title: row.title,
      url: row.url,
      description: row.text.slice(0, 500),
      content: row.text,
      score: Number(row.score),
      project_ids: [projectId],
      source_family: 'document' as const,
      retrieval_family: 'bm25' as const,
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
  }> {
    const db = await this.open();
    const [events, documents, citations, sources, sessions] = await db.query<[
      Array<{ count: number }>, Array<{ count: number }>, Array<{ count: number }>,
      Array<{ count: number }>, Array<{ count: number }>,
    ]>(
      `SELECT count() AS count FROM search_event WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM project_document WHERE project_id = $project_id GROUP ALL;
       SELECT count() AS count FROM metadata_observation
       WHERE project_id = $project_id AND kind = 'citation_count' GROUP ALL;
       SELECT count() AS count FROM project_source_entry
       WHERE project_id = $project_id AND active = true GROUP ALL;
       SELECT count() AS count FROM memory_session WHERE project_id = $project_id GROUP ALL;`,
      { project_id: projectId },
    ).collect();
    return {
      searchEvents: Number(events[0]?.count ?? 0),
      documents: Number(documents[0]?.count ?? 0),
      citationObservations: Number(citations[0]?.count ?? 0),
      sourceEntries: Number(sources[0]?.count ?? 0),
      sessions: Number(sessions[0]?.count ?? 0),
    };
  }
}

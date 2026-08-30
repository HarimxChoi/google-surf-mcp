import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fenceUntrustedContent } from '../response.js';
import { MAX_RESEARCH_CAPTURE_CHARS } from '../searchLimits.js';
import type {
  AssertionCorrectionRecord, AssertionRecord, AssertionValue, CaptureResult, DecisionRecord,
  EntityAliasRecord, EntityLinkCandidate, EntityOperationRecord, EntityRecord, EvidenceRecord,
  ExperimentRunRecord, ExperimentStatus, GraphAnalysis, GraphArtifact, GraphProjection,
  IntentRevisionRecord,
  KnowledgeJobRecord, KnowledgeJobStatus, KnowledgeJobSummary, LocalSearchFamilies, LocalSearchHit,
  MemorySessionRecord,
  OntologyTermRecord, PlanRevisionRecord, ProjectDetail, ProjectIndexResult,
  ProjectForgetPreview, ProjectRecord, RecordForgetPreview, ResearchReceipt, RetrievalIndexItem,
  ResearchSearchContext, SearchEventRecord,
} from './contracts.js';
import { runCodeStructureBatchStream, type CodeSourceInput } from './codeStructure.js';
import { cosineSimilarity, LocalEmbeddingModel, type EmbeddingProvider } from './dense.js';
import { aliasId, entityId, normalizeEntityName, rankEntityCandidates } from './entities.js';
import { buildGraphProjection, type ProjectGraphSource } from './graphProjection.js';
import { isRetrievalGraphEdge, rankGraphProjection, runGraphSidecar } from './graphSidecar.js';
import { exportInteractiveGraphVisualization } from './interactiveVisualization.js';
import { searchableByPolicy } from './inventory.js';
import {
  decideRepository, GitHubClient, parseGitHubRepositoryUrl, selectedRepositoryPaths,
  type RepositoryClient, type RepositoryDecision, type RepositoryReadMode,
} from './github.js';
import { inventoryProject, type ProjectRootInput } from './projectInventory.js';
import { ResearchStore, type CodeSourceManifestEntry } from './store.js';
import {
  exportGraphVisualization, exportNeo4jVisualization,
  type GraphVisualizationFormat, type GraphVisualizationView,
} from './visualization.js';

export interface ResearchServiceOptions {
  enabled: boolean;
  root: string;
  endpoint?: string;
  vectorModel?: string;
  embeddingProvider?: EmbeddingProvider;
  repositoryAuto?: boolean;
  repositoryMaxSourceBytes?: number;
  repositoryMaxSourceFiles?: number;
  repositoryClient?: RepositoryClient;
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
  plan_revision_id?: string;
  experiment_id?: string;
}

interface PlanInput {
  project_id: string;
  title: string;
  body: string;
  change_reason?: string;
  based_on_experiment_id?: string;
}

interface ExperimentStartInput {
  project_id: string;
  name: string;
  hypothesis: string;
  plan_revision_id?: string;
  artifacts?: string[];
}

interface ExperimentFinishInput {
  project_id: string;
  experiment_id: string;
  status: Exclude<ExperimentStatus, 'running'>;
  summary: string;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts?: string[];
}

interface ProjectIndexInput {
  project_id: string;
  roots: ProjectRootInput[];
  git_root?: string;
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

const GRAPH_ALGORITHM_VERSION = 'graphology-v9-typed-retrieval-louvain';
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

function eventQueries(event: SearchEventRecord): string[] {
  return [...new Set([event.query, ...(event.queries ?? [])]
    .filter((query): query is string => !!query?.trim()))];
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

export class ResearchService {
  private readonly store: ResearchStore;
  private readonly planLocks = new Map<string, Promise<unknown>>();
  private readonly graphCache = new Map<string, GraphProjection>();
  private readonly graphArtifacts = new Map<string, GraphArtifact>();
  private readonly backgroundJobs = new Set<Promise<unknown>>();
  private readonly graphTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly embeddings: EmbeddingProvider;
  private readonly repositoryClient: RepositoryClient;
  private readonly repositoryJobs = new Set<string>();
  private recoveredDirtyProjects = false;
  private state: 'disabled' | 'idle' | 'ready' | 'unavailable';

  constructor(private readonly options: ResearchServiceOptions) {
    this.store = new ResearchStore(options.root, options.endpoint);
    this.embeddings = options.embeddingProvider ?? new LocalEmbeddingModel(options.vectorModel);
    this.repositoryClient = options.repositoryClient ?? new GitHubClient();
    this.state = options.enabled ? 'idle' : 'disabled';
  }

  private rememberGraphProjection(key: string, projection: GraphProjection): GraphProjection {
    this.graphCache.delete(key);
    this.graphCache.set(key, projection);
    while (this.graphCache.size > 4) {
      const oldest = this.graphCache.keys().next().value;
      if (oldest === undefined) break;
      this.graphCache.delete(oldest);
    }
    return projection;
  }

  private rememberGraphArtifact(projectionId: string, artifact: GraphArtifact): GraphArtifact {
    this.graphArtifacts.delete(projectionId);
    this.graphArtifacts.set(projectionId, artifact);
    while (this.graphArtifacts.size > 3) {
      const oldest = this.graphArtifacts.keys().next().value;
      if (oldest === undefined) break;
      this.graphArtifacts.delete(oldest);
    }
    return artifact;
  }

  status(): {
    enabled: boolean;
    state: string;
    root: string;
    vector: 'off' | 'on';
    external_sync: 'off';
    graph_projection_cache: number;
    graph_artifact_cache: number;
  } {
    return {
      enabled: this.options.enabled,
      state: this.state,
      root: this.options.root,
      vector: this.embeddings.enabled() ? 'on' : 'off',
      external_sync: 'off',
      graph_projection_cache: this.graphCache.size,
      graph_artifact_cache: this.graphArtifacts.size,
    };
  }

  async probe(): Promise<ReturnType<ResearchService['status']>> {
    if (this.options.enabled) await this.ready();
    return this.status();
  }

  async close(): Promise<void> {
    for (const timer of this.graphTimers.values()) clearTimeout(timer);
    this.graphTimers.clear();
    await this.waitForIdle();
    await this.store.close();
    await this.embeddings.dispose?.();
    this.recoveredDirtyProjects = false;
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
        for (const project of await this.store.listDirtyProjects()) {
          this.scheduleGraph(project.project_id);
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

  async indexProject(input: ProjectIndexInput): Promise<ProjectIndexResult> {
    const projectId = cleanProjectId(input.project_id);
    return await this.locked('db-write', async () => await this.indexProjectLocked({
      ...input,
      project_id: projectId,
    }));
  }

  private async indexProjectLocked(input: ProjectIndexInput): Promise<ProjectIndexResult> {
    const project = await this.ensureProject(input.project_id);
    const inventory = await inventoryProject({
      roots: input.roots,
      ...(input.git_root ? { git_root: input.git_root } : {}),
    });
    const searchable = inventory.records.filter((record) => record.text !== undefined
      && searchableByPolicy('structured', record.kind, record.tracked));
    const bodies = new Map<string, string>();
    for (const record of searchable) {
      if (record.content_hash && record.text !== undefined) bodies.set(record.content_hash, record.text);
    }
    const now = new Date().toISOString();
    const activeSnapshot = project.active_source_snapshot_id
      ? await this.store.getSourceSnapshot(project.active_source_snapshot_id)
      : undefined;
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
      unique_body_count: bodies.size,
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
    if (job.status === 'failed') {
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
        })),
        bodies: [...bodies].map(([content_hash, text]) => ({ content_hash, text })),
      });
      const exactSourceItems: RetrievalIndexItem[] = searchable.flatMap((record) => {
        if (!record.content_hash || record.text === undefined) return [];
        const name = basename(record.path);
        const extension = extname(name);
        return [{
          item_id: `source:${record.id}`,
          project_id: project.project_id,
          source_family: 'code',
          source_id: record.id,
          title: `${record.root}/${record.path}`,
          url: `surf://projects/${project.project_id}/files/${record.id}`,
          content_hash: record.content_hash,
          exact_terms: exactTerms(
            `${record.root}/${record.path}`,
            record.path,
            name,
            extension ? name.slice(0, -extension.length) : name,
          ),
          text: `${record.root}/${record.path}\n${record.text}`,
        }];
      });
      await this.store.replaceExactItems(project.project_id, 'code', exactSourceItems);
      if (job.status === 'running') {
        job = await this.transitionKnowledgeJob({
          project_id: project.project_id,
          job_id: job.job_id,
          status: 'done',
          result_digest: snapshotId,
        });
      }
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
    if (!write.reused) await this.invalidateGraph(project.project_id, false);
    this.schedule(async () => {
      await this.materializeCodeStructure(project.project_id, snapshotId);
      await this.materializeRetrievalIndex(project.project_id, 'code');
      await this.materializeGraph([project.project_id]);
    });
    return {
      project_id: project.project_id,
      snapshot_id: snapshotId,
      inventory_digest: inventory.digest,
      policy: 'structured',
      file_count: inventory.records.length,
      collection_count: snapshot.collection_count,
      searchable_file_count: searchable.length,
      unique_body_count: bodies.size,
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
        created_at: new Date().toISOString(),
      };
      await this.store.putPlan(project, plan);
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
      status: 'running',
      ...(input.artifacts?.length ? { artifacts: input.artifacts.slice(0, 50) } : {}),
      started_at: new Date().toISOString(),
    };
    const stored = await this.store.putExperiment(experiment);
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
      ...(input.metrics ? { metrics: input.metrics } : {}),
      ...(input.artifacts?.length
        ? { artifacts: [...(experiment.artifacts ?? []), ...input.artifacts].slice(0, 100) }
        : {}),
      finished_at: new Date().toISOString(),
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
      created_at: new Date().toISOString(),
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
    const schemaVersion = cleanText(input.schema_version, 'schema_version', 100);
    const algorithmVersion = cleanText(input.algorithm_version, 'algorithm_version', 100);
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
    const job = await this.store.getKnowledgeJob(input.job_id);
    if (!job || job.project_id !== project.project_id) {
      throw new Error('job_id must belong to the project');
    }
    const allowed: Record<KnowledgeJobStatus, KnowledgeJobStatus[]> = {
      queued: ['running'],
      running: ['done', 'failed'],
      done: ['queued'],
      failed: ['queued'],
    };
    if (!allowed[job.status].includes(input.status)) {
      throw new Error(`invalid job transition: ${job.status} -> ${input.status}`);
    }
    return await this.store.putKnowledgeJob({
      ...job,
      status: input.status,
      attempts: input.status === 'running' ? job.attempts + 1 : job.attempts,
      ...(input.result_digest
        ? { result_digest: cleanText(input.result_digest, 'result_digest', 200) }
        : {}),
      ...(input.result_counts ? { result_counts: input.result_counts } : {}),
      ...(input.error ? { error: cleanText(input.error, 'error', 2_000) } : {}),
      updated_at: new Date().toISOString(),
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
    const sourceItems: RetrievalIndexItem[] = sources.map((source) => {
      const name = basename(source.path);
      const extension = extname(name);
      return {
        item_id: `source:${source.entry_id}`,
        project_id: projectId,
        source_family: 'code',
        source_id: source.entry_id,
        title: `${source.root}/${source.path}`,
        url: `surf://projects/${projectId}/files/${source.entry_id}`,
        content_hash: source.content_hash,
        exact_terms: exactTerms(
          `${source.root}/${source.path}`,
          source.path,
          name,
          extension ? name.slice(0, -extension.length) : name,
          ...(symbolNames.get(source.entry_id) ?? []),
        ),
        text: `${source.root}/${source.path}\n${source.text}`,
      };
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
    })))).digest('hex');
    await this.store.replaceExactItems(projectId, sourceFamily, items);
    const model = this.embeddings.modelId();
    if (!model) return undefined;
    const identity = {
      project_id: projectId,
      kind: 'retrieval_index' as const,
      source_hash: digest,
      schema_version: `retrieval-v1-${sourceFamily}-${this.embeddings.dimensions()}`,
      algorithm_version: `${RETRIEVAL_ALGORITHM_VERSION}:${sourceFamily}:${model}`,
    };
    let job = await this.queueKnowledgeJob({
      ...identity,
      affected_source_ids: items.map((item) => item.source_id),
    });
    if (job.status === 'done') return job;
    if (job.status === 'running') {
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'failed',
        error: 'interrupted before completion',
      });
    }
    if (job.status === 'failed') {
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
      const cacheKeys = items.map((item) => createHash('sha256')
        .update(`${model}\0${item.text.slice(0, 4_000)}`).digest('hex'));
      const cached = await this.store.cachedEmbeddings(cacheKeys);
      const missing = items.map((item, index) => ({ item, index, cache_key: cacheKeys[index] }))
        .filter((row) => !cached.has(row.cache_key));
      const generated = await this.embeddings.embedPassages(missing.map((row) => row.item.text));
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
      })))).digest('hex');
      if (currentDigest !== digest) throw new Error('retrieval source superseded');
      await this.store.replaceVectorItems(projectId, sourceFamily, items, model, vectors);
      job = await this.transitionKnowledgeJob({
        project_id: projectId,
        job_id: job.job_id,
        status: 'done',
        result_digest: digest,
        result_counts: {
          retrieval_documents: sourceFamily === 'document' ? items.length : 0,
          retrieval_sources: sourceFamily === 'code' ? items.length : 0,
          retrieval_vectors: vectors.length,
          retrieval_vectors_reused: vectors.length - missing.length,
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
        if (current.status === 'failed') {
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
        const loaded = { count: 0 };
        const structure = await runCodeStructureBatchStream(
          this.codeSourceBatches(projectId, entries, loaded),
        );
        const deferred = entries.length - loaded.count;
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
        aliases, ontologyTerms, evidence, assertions, symbols, codeRelations,
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
      if (job.status === 'failed') {
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
    if (job.status === 'failed') {
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
      const analysis = await runGraphSidecar(projection);
      const analysisMs = Date.now() - analysisStarted;
      const publishStarted = Date.now();
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
  ): Promise<LocalSearchHit[]> {
    const current = await this.store.currentGraph(project.project_id);
    if (!current.current || !current.projection_id) return [];
    const artifact = this.graphArtifacts.get(current.projection_id)
      ?? await this.store.loadGraphArtifact(current.projection_id);
    if (!artifact) return [];
    this.rememberGraphArtifact(current.projection_id, artifact);
    return this.graphSearchHits(
      artifact.projection,
      query,
      limit,
      new Set([project.project_id]),
      artifact.analysis.pagerank,
    );
  }

  private graphSearchHits(
    projection: GraphProjection,
    query: string,
    limit: number,
    projectIds: Set<string>,
    pagerank: Record<string, number> = {},
  ): LocalSearchHit[] {
    return rankGraphProjection(projection, query, limit * 5)
      .filter(({ node }) => projectIds.has(node.project_id))
      .slice(0, limit)
      .map(({ node, score }) => ({
        document_id: node.source_id ?? node.node_id,
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
      }));
  }

  private async searchCombinedGraph(
    projects: ProjectRecord[],
    query: string,
    limit: number,
  ): Promise<LocalSearchHit[]> {
    const projectIds = projects.map((project) => project.project_id);
    const projection = await this.exportGraphProjection(projectIds);
    return this.graphSearchHits(projection, query, limit, new Set(projectIds));
  }

  async searchFamilies(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
  ): Promise<LocalSearchFamilies> {
    const projectIds = [...new Set([projectIdValue, ...includeProjectIds])];
    const projects = await Promise.all(projectIds.map((projectId) => this.ensureProject(projectId)));
    const cleanedQuery = cleanText(query, 'query', 400);
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const [exactGroups, bm25Groups, graphGroups, queryVector] = await Promise.all([
      Promise.all(projects.map((project) => this.store.searchProjectExact(
        project.project_id,
        normalizeEntityName(cleanedQuery),
        cappedLimit,
      ))),
      Promise.all(projects.map((project) => (
        this.store.searchProjectBm25(project.project_id, cleanedQuery, cappedLimit)
      ))),
      projects.length > 1
        ? this.searchCombinedGraph(projects, cleanedQuery, cappedLimit).then((rows) => [rows])
        : Promise.all(projects.map((project) => (
          this.searchMaterializedGraph(project, cleanedQuery, cappedLimit)
        ))),
      this.embeddings.enabled()
        ? this.embeddings.embedQuery(cleanedQuery).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const model = this.embeddings.modelId();
    const vectorGroups = queryVector && model
      ? await Promise.all(projects.map((project) => this.store.searchProjectVector(
        project.project_id,
        model,
        queryVector,
        cappedLimit,
      ).catch(() => [])))
      : [];
    return {
      exact: fuseRankedGroups(exactGroups, cappedLimit, 'exact'),
      bm25: fuseRankedGroups(bm25Groups, cappedLimit, 'bm25'),
      vector: fuseRankedGroups(vectorGroups, cappedLimit, 'vector'),
      graph: fuseRankedGroups(graphGroups, cappedLimit, 'graph'),
    };
  }

  async search(
    projectIdValue: string,
    query: string,
    limit: number,
    includeProjectIds: string[] = [],
  ): Promise<LocalSearchHit[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 20);
    const candidateLimit = Math.min(40, cappedLimit * 3);
    const cleanedQuery = cleanText(query, 'query', 400);
    const families = await this.searchFamilies(
      projectIdValue,
      cleanedQuery,
      candidateLimit,
      includeProjectIds,
    );
    const fused = fuseRankedGroups(Object.values(families), candidateLimit);
    return await this.rerankCandidates(cleanedQuery, fused, cappedLimit);
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
  }>(query: string, rows: T[], limit: number): Promise<T[]> {
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
        this.embeddings.embedQuery(query),
        this.embeddings.embedPassages(working.map((row) => (
          `${row.title}\n${row.description ?? ''}\n${row.content?.slice(0, 1_200) ?? ''}`
        ))),
      ]);
      const semantic = working.map((row, index) => ({
        row,
        index,
        similarity: cosineSimilarity(queryVector, passageVectors[index]),
      })).sort((a, b) => b.similarity - a.similarity || a.index - b.index);
      const semanticRank = new Map(semantic.map((entry, index) => [entry.index, index]));
      const ranked = working.map((row, index) => ({
        row,
        index,
        score: (row._rrf_score ?? row.score ?? 1 / (60 + index + 1))
          + 0.1 / (60 + semanticRank.get(index)! + 1),
      })).sort((a, b) => b.score - a.score || a.index - b.index);
      const selected = ranked.slice(0, cappedLimit);
      const fresh = ranked.filter((entry) => entry.row.fresh_web);
      const freshFloor = Math.min(fresh.length, cappedLimit >= 10 ? 2 : 1);
      const selectedFresh = selected.filter((entry) => entry.row.fresh_web).length;
      for (let index = selectedFresh; index < freshFloor; index++) {
        const candidate = fresh.find((entry) => !selected.includes(entry));
        const replace = [...selected].reverse().findIndex((entry) => !entry.row.fresh_web);
        if (!candidate || replace < 0) break;
        selected.splice(selected.length - 1 - replace, 1, candidate);
      }
      return visible(selected.sort((a, b) => b.score - a.score || a.index - b.index)
        .map((entry) => entry.row));
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
    const families = await this.searchFamilies(projectIdValue, query, limit, includeProjectIds);
    return fuseRankedGroups(Object.values(families), Math.min(Math.max(limit, 1), 20));
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
          await this.store.replaceDocumentChunks(id, chunkSetId, chunks.map((chunk) => ({
            chunk_id: `${id}_${chunkSetId.slice(0, 16)}_${chunk.chunk_index}`,
            document_id: id,
            chunk_set_id: chunkSetId,
            chunk_index: chunk.chunk_index,
            title: row.title.slice(0, 1_000),
            url: row.url,
            text: chunk.text,
            content_hash: chunk.content_hash,
            updated_at: now,
          })));
          for (const chunk of chunks) {
            await this.store.upsertExactItem({
              item_id: `document:${id}:${chunk.chunk_index}`,
              project_id: project.project_id,
              source_family: 'document',
              source_id: id,
              title: row.title.slice(0, 1_000),
              url: row.url,
              content_hash: chunk.content_hash,
              exact_terms: exactTerms(row.title, row.url, row.scholar_id),
              text: chunk.text,
            });
          }
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

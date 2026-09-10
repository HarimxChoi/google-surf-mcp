import type { CallToolResult } from '../response.js';
import { formatToolResponse } from '../response.js';
import { compactRankedResults } from './integration.js';
import type {
  ArtifactReference, AssertionValue, CatalogAccessTier, CatalogAssetKind, CatalogWriteOperation,
  ExperimentStatus, ProjectDocumentRole,
  ResearchSearchFilters,
} from './contracts.js';
import { isTransactionConflict } from './errors.js';
import { ResearchService } from './service.js';

export interface ProjectMemorySearchInput {
  project_id?: string;
  include_project_ids?: string[];
  all_projects?: boolean;
  query?: string;
  query_variants?: string[];
  limit?: number;
  queries?: Array<{ id: string; query: string; query_variants?: string[]; limit?: number }>;
  response_budget_bytes?: number;
  request_id?: string;
  response_deadline_ms?: number;
  filters?: ResearchSearchFilters;
}

export interface ProjectMemoryInput extends ProjectMemorySearchInput {
  action: 'create' | 'project_update' | 'show' | 'search' | 'record' | 'record_batch' | 'get' | 'get_batch'
    | 'context' | 'timeline' | 'diff' | 'sync' | 'job_status' | 'job_wait' | 'job_cancel'
    | 'query_status' | 'query_cancel' | 'verify'
    | 'current' | 'snapshot' | 'snapshot_import' | 'snapshot_rollback'
    | 'doctor' | 'rebuild' | 'export' | 'forget';
  detail_level?: 'summary' | 'full';
  export_format?: 'dot' | 'd3' | 'html' | 'neo4j';
  export_view?: 'graph' | 'ontology' | 'lineage';
  name?: string;
  record_type?: 'session' | 'plan' | 'experiment' | 'decision' | 'ontology' | 'correction';
  memory_handle?: string;
  intent?: string;
  title?: string;
  body?: string;
  body_path?: string;
  change_reason?: string;
  based_on_experiment_id?: string;
  experiment_id?: string;
  hypothesis?: string;
  plan_revision_id?: string;
  status?: ExperimentStatus;
  summary?: string;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts?: string[];
  roots?: Array<{
    label: string;
    path: string;
    role?: ProjectDocumentRole;
    manifest?: Array<{ path: string; role: ProjectDocumentRole; aliases?: string[] }>;
  }>;
  changed_paths?: Array<{ root: string; path: string }>;
  removed_paths?: Array<{ root: string; path: string }>;
  git_root?: string;
  forget_mode?: 'preview' | 'apply' | 'restore';
  confirm_token?: string;
  target_id?: string;
  replacement?: AssertionValue;
  correction_kind?: 'assertion' | 'entity_merge' | 'entity_split';
  source_ids?: string[];
  aliases?: string[];
  ontology_kind?: 'entity_type' | 'relation';
  version?: number;
  supersedes_term_id?: string;
  reason?: string;
  evidence_ids?: string[];
  valid_from?: string;
  valid_to?: string;
  operation?: CatalogWriteOperation;
  asset_kind?: CatalogAssetKind;
  asset_id?: string;
  record_id?: string;
  record_ids?: string[];
  records?: Array<{
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
  }>;
  expected_revision?: number;
  idempotency_key?: string;
  fields?: Record<string, unknown>;
  artifact_references?: ArtifactReference[];
  protected?: boolean;
  access_tier?: CatalogAccessTier;
  set_current?: boolean;
  missing_fields?: string[];
  effective_at?: string;
  source_sequence?: number;
  source_reference?: string;
  correction_reason?: string;
  revision?: number;
  from_revision?: number;
  to_revision?: number;
  body_offset?: number;
  body_bytes?: number;
  artifact_offset?: number;
  artifact_limit?: number;
  budget_bytes?: number;
  since_revision?: number;
  after?: string;
  before?: string;
  as_of?: string;
  job_id?: string;
  after_revision?: number;
  wait_timeout_ms?: number;
  cancel_reason?: string;
  verification_level?: 'declared' | 'present' | 'hash_verified' | 'restore_tested' | 'replayed';
  root_mode?: 'merge' | 'replace' | 'remove';
  snapshot_path?: string;
  dry_run?: boolean;
  purpose?: string;
  user_constraints?: string[];
  protected_parent_ids?: string[];
}

function toolError(error: unknown): CallToolResult {
  return formatToolResponse(null, {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    retryable: isTransactionConflict(error),
  });
}

function requireProject(input: ProjectMemoryInput): string {
  if (!input.project_id) throw new Error('project_id required');
  return input.project_id;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function budgetRankedResults<T extends { description?: string }>(
  rows: T[],
  budgetBytes: number,
): { rows: T[]; bytes: number; omitted: number; truncated: boolean } {
  const selected: T[] = [];
  for (const source of rows) {
    let row = { ...source };
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...row, description: undefined }), 'utf8') + 2;
    const used = Buffer.byteLength(JSON.stringify(selected), 'utf8');
    const available = budgetBytes - used - baseBytes;
    if (available <= 0) continue;
    if (row.description) row = { ...row, description: utf8Prefix(row.description, available) };
    if (Buffer.byteLength(JSON.stringify([...selected, row]), 'utf8') <= budgetBytes) selected.push(row);
  }
  const bytes = Buffer.byteLength(JSON.stringify(selected), 'utf8');
  return {
    rows: selected,
    bytes,
    omitted: rows.length - selected.length,
    truncated: selected.length < rows.length
      || selected.some((row, index) => row.description !== rows[index]?.description),
  };
}

export async function projectMemorySearchTool(
  input: ProjectMemorySearchInput,
  service: ResearchService,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    if (!input.query && !input.queries?.length) throw new Error('query or queries required');
    if (input.query && input.queries?.length) throw new Error('query and queries cannot be combined');
    if ((input.query_variants?.length ?? 0) > 19) throw new Error('query_variants accepts at most 19 entries');
    if (input.all_projects && (input.project_id || input.include_project_ids?.length)) {
      throw new Error('all_projects cannot be combined with project_id or include_project_ids');
    }
    if (!input.all_projects && !input.project_id) {
      throw new Error('project_id or all_projects=true required');
    }
    const scope = input.all_projects
      ? (await service.listProjects())
        .filter((project) => project.status !== 'forgotten' && project.project_id !== 'inbox')
        .map((project) => project.project_id)
        .sort()
      : [input.project_id!, ...[...new Set(input.include_project_ids ?? [])]
        .filter((projectId) => projectId !== input.project_id)
        .sort()];
    if (!scope.length) throw new Error('project_id or all_projects=true required');
    const started = Date.now();
    if (input.queries?.length) {
      if (input.request_id || input.response_deadline_ms) {
        throw new Error('request_id and response_deadline_ms apply to one query; use separate IDs for grouped queries');
      }
      const groups = await service.searchGrouped(scope[0], input.queries, scope.slice(1), signal, input.filters);
      const resultBudget = input.response_budget_bytes ?? 12_000;
      const groupBudget = Math.max(1, Math.floor(resultBudget / groups.length));
      const compactGroups = groups.map((group) => {
        const compact = compactRankedResults(group.query, group.results.map((hit) => ({
          title: hit.title,
          url: hit.url,
          description: hit.description,
          content: hit.content,
          document_id: hit.document_id,
          record_id: hit.record_id,
          revision_id: hit.revision_id,
          body_handle: hit.body_handle,
          source_span: hit.source_span,
          index_freshness: hit.index_freshness,
          project_ids: hit.project_ids,
          source_family: hit.source_family,
          retrieval_families: hit.retrieval_families
            ?? (hit.retrieval_family ? [hit.retrieval_family] : []),
          score: hit.score,
        })));
        const budgeted = budgetRankedResults(compact, groupBudget);
        return {
          id: group.id,
          query: group.query,
          results: budgeted.rows,
          omitted_results: budgeted.omitted,
          truncated: budgeted.truncated,
          result_bytes: budgeted.bytes,
          degraded_lanes: group.degraded_lanes,
          timings: group.timings,
          request_id: group.request_id,
          candidate_counts: group.candidate_counts,
        };
      });
      return formatToolResponse({
        groups: compactGroups,
        elapsed_ms: Date.now() - started,
        meta: {
          provider: 'local',
          project_ids: scope,
          grouped: true,
          query_count: compactGroups.length,
          query_execution: 'single_broker_request',
          response_budget_bytes: resultBudget,
          response_result_bytes: compactGroups.reduce((sum, group) => sum + group.result_bytes, 0),
          omitted_results: compactGroups.reduce((sum, group) => sum + group.omitted_results, 0),
          live_web_used: false,
          browser_used: false,
        },
        memory: `Projects: ${scope.length} | Independent queries: ${compactGroups.length} | Live web: no | Status: ready`,
      });
    }
    const searched = await service.searchBatch(
      scope[0],
      input.query!,
      input.query_variants ?? [],
      input.limit ?? 10,
      scope.slice(1),
      signal,
      input.filters,
      true,
      false,
      input.request_id,
      input.response_deadline_ms,
    );
    const hits = searched.results;
    const compact = compactRankedResults(input.query!, hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      description: hit.description,
      content: hit.content,
      document_id: hit.document_id,
      record_id: hit.record_id,
      revision_id: hit.revision_id,
      body_handle: hit.body_handle,
      source_span: hit.source_span,
      index_freshness: hit.index_freshness,
      project_ids: hit.project_ids,
      source_family: hit.source_family,
      retrieval_families: hit.retrieval_families
        ?? (hit.retrieval_family ? [hit.retrieval_family] : []),
      score: hit.score,
    })));
    const resultBudget = input.response_budget_bytes ?? 12_000;
    const budgeted = budgetRankedResults(compact, resultBudget);
    const results = budgeted.rows;
    const vectorEnabled = service.status().vector === 'on';
    return formatToolResponse({
      query: input.query,
      results,
      elapsed_ms: Date.now() - started,
      meta: {
        provider: 'local',
        project_ids: scope,
        retrieval_lanes: ['exact', 'bm25', ...(vectorEnabled ? ['vector'] : []), 'graph'],
        fusion: 'rrf',
        reranker: searched.partial ? 'not_completed' : vectorEnabled ? 'local_vector' : 'rrf_only',
        response_format: 'ranked_summaries',
        response_budget_bytes: resultBudget,
        response_result_bytes: budgeted.bytes,
        omitted_results: budgeted.omitted,
        truncated: budgeted.truncated,
        live_web_used: false,
        browser_used: false,
        searchapi_used: false,
        captured: false,
        query_count: searched.queries.length,
        query_variants: searched.queries.slice(1),
        query_execution: 'single_broker_request',
        graph_project_count: searched.graph_project_count,
        degraded_lanes: searched.degraded_lanes,
        partial: searched.partial || searched.degraded_lanes.length > 0,
        completed_lanes: searched.completed_lanes,
        ...(searched.incomplete_reason ? { incomplete_reason: searched.incomplete_reason } : {}),
        timings: searched.timings,
        request_id: searched.request_id,
        candidate_counts: searched.candidate_counts,
      },
      memory: `Projects: ${scope.length} | Queries: ${searched.queries.length} | Local RAG: ${results.length} results | Live web: no | Status: ${searched.partial || searched.degraded_lanes.length ? `partial (${searched.degraded_lanes.join(', ') || 'cancelled after completed lanes'})` : 'ready'}`,
    });
  } catch (error) {
    return toolError(error);
  }
}

export async function projectMemoryTool(
  input: ProjectMemoryInput,
  service: ResearchService,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    if (input.action === 'create') {
      if (!input.name) throw new Error('name required');
      let project = await service.createProject(input.name, input.project_id);
      if (input.purpose !== undefined || input.user_constraints !== undefined
        || input.protected_parent_ids !== undefined) {
        project = await service.updateProjectContext({
          project_id: project.project_id,
          purpose: input.purpose,
          user_constraints: input.user_constraints,
          protected_parent_ids: input.protected_parent_ids,
        });
      }
      return formatToolResponse({
        project,
        memory: `Project: ${project.name} | Status: ready`,
      });
    }

    if (input.action === 'project_update') {
      const projectId = requireProject(input);
      if (input.expected_revision === undefined || !input.idempotency_key) {
        throw new Error('project_update requires expected_revision and idempotency_key');
      }
      const updated = await service.updateProjectProfile({
        project_id: projectId,
        name: input.name,
        purpose: input.purpose,
        user_constraints: input.user_constraints,
        protected_parent_ids: input.protected_parent_ids,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
      });
      return formatToolResponse({
        ...updated,
        memory: `Project: ${updated.project.name} | Profile: v${updated.receipt.revision} | Status: committed`,
      });
    }

    if (input.action === 'doctor') {
      const doctor = await service.passiveStatus();
      const adapterMemory = process.memoryUsage();
      const separateAdapter = doctor.process.pid !== process.pid;
      return formatToolResponse({
        doctor: {
          ...doctor,
          adapter_process: separateAdapter ? {
            pid: process.pid,
            parent_pid: process.ppid,
            rss_bytes: adapterMemory.rss,
            heap_used_bytes: adapterMemory.heapUsed,
          } : null,
          observed_worker_rss_bytes: doctor.process.rss_bytes
            + (separateAdapter ? adapterMemory.rss : 0),
          private_bytes_note: 'Current private bytes are not exposed portably by Node.js and are not inferred from RSS.',
        },
        memory: 'Research doctor: passive | Database/model opened: no',
      });
    }

    if (input.action === 'query_status' || input.action === 'query_cancel') {
      if (!input.request_id) throw new Error('request_id required');
      const query = input.action === 'query_status'
        ? await service.queryStatus(input.request_id)
        : await service.cancelQuery(input.request_id, input.cancel_reason);
      return formatToolResponse({
        query_status: query,
        memory: `Query: ${query.request_id} | Phase: ${query.phase} | Status: ${query.status}`,
      });
    }

    if (input.action === 'get') {
      const projectId = requireProject(input);
      const recordId = input.record_id ?? input.target_id;
      if (!recordId) throw new Error('record_id required');
      const record = await service.getCatalogRecord(
        projectId,
        recordId,
        input.revision,
        input.body_offset,
        input.body_bytes,
        input.artifact_offset,
        input.artifact_limit,
      );
      return formatToolResponse({
        record,
        memory: `Project: ${projectId} | Exact record: ${recordId} | Status: ready`,
      });
    }

    if (input.action === 'get_batch') {
      const projectId = requireProject(input);
      if (!input.record_ids?.length) throw new Error('record_ids required');
      const records = await service.getCatalogRecords(projectId, input.record_ids, {
        body_offset: input.body_offset,
        body_bytes: input.body_bytes,
        artifact_offset: input.artifact_offset,
        artifact_limit: input.artifact_limit,
      });
      return formatToolResponse({
        records,
        memory: `Project: ${projectId} | Exact records: ${records.length} | Status: ready`,
      });
    }

    if (input.action === 'context') {
      const projectId = requireProject(input);
      const context = await service.projectContext(
        projectId,
        input.budget_bytes,
        input.since_revision,
        input.as_of,
      );
      return formatToolResponse({
        context,
        memory: `Project: ${projectId} | Current context | Status: ready`,
      });
    }

    if (input.action === 'current') {
      const projectId = requireProject(input);
      const current = await service.materializeCurrentView(projectId);
      return formatToolResponse({
        current,
        memory: `Project: ${projectId} | CURRENT view: generation ${current.catalog_generation} | Status: ready`,
      });
    }

    if (input.action === 'timeline') {
      const projectId = requireProject(input);
      const timeline = await service.catalogTimeline(projectId, {
        after: input.after,
        before: input.before,
        limit: input.limit,
      });
      return formatToolResponse({
        timeline,
        memory: `Project: ${projectId} | Timeline: ${timeline.events.length} events | Status: ready`,
      });
    }

    if (input.action === 'diff') {
      const projectId = requireProject(input);
      const recordId = input.record_id ?? input.target_id;
      if (!recordId || input.from_revision === undefined) {
        throw new Error('record_id and from_revision required');
      }
      const diff = await service.catalogDiff(projectId, recordId, input.from_revision, input.to_revision);
      return formatToolResponse({
        diff,
        memory: `Project: ${projectId} | Record diff: ${recordId} | Status: ready`,
      });
    }

    if (input.action === 'job_status' || input.action === 'job_wait' || input.action === 'job_cancel') {
      const projectId = requireProject(input);
      if (!input.job_id) throw new Error('job_id required');
      const job = input.action === 'job_status'
        ? await service.jobStatus(projectId, input.job_id)
        : input.action === 'job_cancel'
          ? await service.cancelJob(projectId, input.job_id, input.cancel_reason)
          : await service.waitForJob(
          projectId,
          input.job_id,
          input.after_revision,
          input.wait_timeout_ms,
        );
      return formatToolResponse({
        job,
        memory: `Project: ${projectId} | Job: ${input.job_id} | Status: ready`,
      });
    }

    if (input.action === 'verify') {
      const projectId = requireProject(input);
      const recordId = input.record_id ?? input.target_id;
      if (!recordId) throw new Error('record_id required');
      const verification = await service.verifyCatalogRecord(
        projectId,
        recordId,
        input.verification_level,
      );
      return formatToolResponse({
        verification,
        memory: `Project: ${projectId} | Verification: ${recordId} | Status: ready`,
      });
    }

    if (input.action === 'snapshot') {
      const projectId = requireProject(input);
      const snapshot = await service.exportCatalogSnapshot(projectId);
      return formatToolResponse({
        snapshot,
        memory: `Project: ${projectId} | Catalog snapshot: ${snapshot.record_count} records | Status: ready`,
      });
    }

    if (input.action === 'snapshot_import' || input.action === 'snapshot_rollback') {
      const projectId = requireProject(input);
      if (!input.snapshot_path) throw new Error('snapshot_path required');
      const imported = await service.importCatalogSnapshot({
        project_id: projectId,
        path: input.snapshot_path,
        expected_generation: input.expected_revision,
        dry_run: input.dry_run,
        rollback: input.action === 'snapshot_rollback',
      });
      return formatToolResponse({
        imported,
        memory: `Project: ${projectId} | Catalog ${input.action === 'snapshot_rollback' ? 'rollback' : 'import'}: ${input.dry_run === false ? 'applied' : 'preview'} | Status: ready`,
      });
    }

    if (input.action === 'record_batch') {
      const projectId = requireProject(input);
      if (!input.records?.length) throw new Error('records required');
      if (input.records.length > 100) throw new Error('records accepts at most 100 entries');
      const results: Array<{ index: number; receipt?: unknown; error?: string }> = [];
      for (let index = 0; index < input.records.length; index++) {
        try {
          results.push({
            index,
            receipt: await service.writeCatalogRecord({ ...input.records[index], project_id: projectId }),
          });
        } catch (error) {
          results.push({ index, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const committed = results.filter((result) => result.receipt).length;
      return formatToolResponse({
        results,
        committed,
        failed: results.length - committed,
        partial: committed !== results.length,
        memory: `Project: ${projectId} | Durable writes: ${committed}/${results.length} | Status: ${committed === results.length ? 'committed' : 'partial'}`,
      });
    }

    if (input.action === 'show') {
      if (!input.project_id) {
        const projects = await service.listProjects();
        return formatToolResponse({
          projects,
          memory: `Projects: ${projects.length} | Status: ready`,
        });
      }
      if (input.target_id) {
        try {
          const assertion = await service.getAssertion(input.project_id, input.target_id);
          return formatToolResponse({
            assertion,
            memory: `Project: ${input.project_id} | Record: assertion ${assertion.status} | Status: ready`,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'assertion not found in project') {
            throw error;
          }
          const entity = await service.getEntity(input.project_id, input.target_id);
          return formatToolResponse({
            entity,
            memory: `Project: ${input.project_id} | Entity: ${entity.canonical_name} | Status: ready`,
          });
        }
      }
      if (input.name) {
        const entities = await service.linkEntity(input.project_id, input.name);
        return formatToolResponse({
          entities,
          memory: `Project: ${input.project_id} | Entity candidates: ${entities.length} | Status: ready`,
        });
      }
      const detail = await service.getProjectSummary(input.project_id);
      return formatToolResponse({
        ...detail,
        ...(input.detail_level === 'full' ? {
          full_detail_omitted: true,
          next: 'Use project_memory_search for relevant record bodies or target_id for one assertion or entity.',
        } : {}),
        memory: `Project: ${detail.project.name} | Sources: ${detail.document_count + detail.source_entry_count} | Records: plans ${detail.plan_count}, experiments ${detail.experiment_count}, decisions ${detail.decision_count}, assertions ${detail.assertion_count}, entities ${detail.entity_count} | Sessions: ${detail.session_count} | Status: ready`,
      });
    }

    if (input.action === 'search') {
      return await projectMemorySearchTool(input, service, signal);
    }

    if (input.action === 'export') {
      const visualization = await service.exportVisualization({
        project_id: input.project_id,
        include_project_ids: input.include_project_ids,
        all_projects: input.all_projects,
        format: input.export_format ?? 'd3',
        view: input.export_view ?? 'graph',
      });
      return formatToolResponse({
        visualization,
        memory: `Projects: ${visualization.project_ids.length} | Graph export: ${visualization.format}, ${visualization.node_count} nodes, ${visualization.edge_count} edges | Status: ready`,
      });
    }

    const projectId = requireProject(input);
    if (input.action === 'forget') {
      const mode = input.forget_mode ?? 'preview';
      if (input.target_id) {
        if (mode === 'restore') {
          const assertion = await service.restoreAssertion(projectId, input.target_id);
          return formatToolResponse({
            assertion,
            memory: `Project: ${projectId} | Restored: assertion 1 | Status: ready`,
          });
        }
        if (mode === 'apply') {
          if (!input.confirm_token) throw new Error('confirm_token required');
          const assertion = await service.forgetAssertion(
            projectId,
            input.target_id,
            input.confirm_token,
          );
          return formatToolResponse({
            assertion,
            memory: `Project: ${projectId} | Deleted: assertion 1, reversible | Status: ready`,
          });
        }
        const preview = await service.previewForgetAssertion(projectId, input.target_id);
        return formatToolResponse({
          forget: preview,
          memory: `Project: ${projectId} | Delete preview: assertion 1, evidence ${preview.evidence} retained | Status: confirmation required`,
        });
      }
      if (mode === 'restore') {
        const project = await service.restoreProject(projectId);
        return formatToolResponse({
          project,
          memory: `Project: ${project.name} | Restore: complete | Status: ready`,
        });
      }
      if (mode === 'apply') {
        if (!input.confirm_token) throw new Error('confirm_token required');
        const project = await service.forgetProject(projectId, input.confirm_token);
        return formatToolResponse({
          project,
          memory: `Project: ${project.name} | Delete: reversible | Status: ready`,
        });
      }
      const preview = await service.previewForgetProject(projectId);
      return formatToolResponse({
        forget: preview,
        memory: `Project: ${preview.name} | Delete preview: sources ${preview.documents + preview.source_entries}, records ${preview.records}, sessions ${preview.sessions} | Status: confirmation required`,
      });
    }

    if (input.action === 'rebuild' || input.action === 'sync') {
      if (!input.roots?.length && !input.changed_paths?.length && !input.removed_paths?.length) {
        const derived = await service.rebuildDerivedState(projectId);
        return formatToolResponse({
          index: derived,
          memory: `Project: ${projectId} | Rebuild: code ${derived.code_sources}, deferred ${derived.code_sources_deferred}, graph | Status: ready`,
        });
      }
      const index = await service.indexProject({
        project_id: projectId,
        roots: input.roots,
        git_root: input.git_root,
        root_mode: input.root_mode,
        changed_paths: input.changed_paths,
        removed_paths: input.removed_paths,
      });
      return formatToolResponse({ index, memory: `${index.summary} | Status: ready` });
    }

    if (input.asset_kind || input.operation || input.idempotency_key) {
      if (!input.asset_kind || !input.operation || !input.idempotency_key) {
        throw new Error('asset_kind, operation and idempotency_key required for typed record writes');
      }
      const receipt = await service.writeCatalogRecord({
        project_id: projectId,
        kind: input.asset_kind,
        operation: input.operation,
        asset_id: input.asset_id ?? input.record_id,
        expected_revision: input.expected_revision,
        idempotency_key: input.idempotency_key,
        body: input.body,
        body_path: input.body_path,
        fields: input.fields,
        evidence_ids: input.evidence_ids,
        artifact_references: input.artifact_references,
        aliases: input.aliases,
        protected: input.protected,
        access_tier: input.access_tier,
        set_current: input.set_current,
        missing_fields: input.missing_fields,
        effective_at: input.effective_at,
        source_sequence: input.source_sequence,
        source_reference: input.source_reference,
        correction_reason: input.correction_reason,
      });
      return formatToolResponse({
        receipt,
        memory: `Project: ${projectId} | Durable record: ${receipt.record_id} v${receipt.revision} | Status: committed`,
      });
    }

    if (!input.record_type) throw new Error('record_type required');
    if (input.record_type === 'session') {
      if (!input.intent) throw new Error('intent required');
      const recorded = await service.recordSessionIntent({
        project_id: projectId,
        memory_handle: input.memory_handle,
        intent: input.intent,
      });
      return formatToolResponse({
        record: {
          record_type: 'session',
          record_id: recorded.intent.intent_revision_id,
          project_id: projectId,
          revision: recorded.intent.revision,
          status: recorded.intent.status,
        },
        memory_handle: recorded.session.memory_handle,
        memory: `Project: ${projectId} | Session: ${recorded.intent.intent.slice(0, 40)} | Record: session intent v${recorded.intent.revision} | Status: ready`,
      });
    }

    if (input.record_type === 'plan') {
      if (!input.title || !input.body) throw new Error('title and body required');
      const detail = await service.getProjectSummary(projectId);
      const plan = await service.createPlan({
        project_id: projectId,
        title: input.title,
        body: input.body,
        change_reason: input.change_reason,
        based_on_experiment_id: input.based_on_experiment_id,
        effective_at: input.effective_at,
        source_sequence: input.source_sequence,
        source_reference: input.source_reference,
        missing_fields: input.missing_fields,
        idempotency_key: input.idempotency_key,
      }, detail.plan_count > 0);
      return formatToolResponse({
        record: {
          record_type: 'plan',
          record_id: plan.plan_revision_id,
          project_id: projectId,
          revision: plan.revision,
        },
        memory: `Project: ${detail.project.name} | Record: plan v${plan.revision} | Status: ready`,
      });
    }

    if (input.record_type === 'experiment') {
      if (input.status && input.status !== 'running') {
        if (!input.experiment_id || !input.summary) {
          throw new Error('experiment_id and summary required');
        }
        const experiment = await service.finishExperiment({
          project_id: projectId,
          experiment_id: input.experiment_id,
          status: input.status,
          summary: input.summary,
          body: input.body,
          metrics: input.metrics,
          artifacts: input.artifacts,
          effective_at: input.effective_at,
          source_sequence: input.source_sequence,
          source_reference: input.source_reference,
          missing_fields: input.missing_fields,
          idempotency_key: input.idempotency_key,
        });
        return formatToolResponse({
          record: {
            record_type: 'experiment',
            record_id: experiment.experiment_id,
            project_id: projectId,
            status: experiment.status,
          },
          memory: `Project: ${projectId} | Record: experiment ${experiment.name} ${experiment.status} | Status: ready`,
        });
      }
      if (!input.title || !input.hypothesis) throw new Error('title and hypothesis required');
      const experiment = await service.startExperiment({
        project_id: projectId,
        name: input.title,
        hypothesis: input.hypothesis,
        body: input.body,
        plan_revision_id: input.plan_revision_id,
        artifacts: input.artifacts,
        effective_at: input.effective_at,
        source_sequence: input.source_sequence,
        source_reference: input.source_reference,
        missing_fields: input.missing_fields,
        idempotency_key: input.idempotency_key,
      });
      return formatToolResponse({
        record: {
          record_type: 'experiment',
          record_id: experiment.experiment_id,
          project_id: projectId,
          status: experiment.status,
        },
        memory: `Project: ${projectId} | Record: experiment ${experiment.name} started | Status: ready`,
      });
    }

    if (input.record_type === 'ontology') {
      if (!input.name || !input.ontology_kind) throw new Error('name and ontology_kind required');
      const term = await service.recordOntologyTerm({
        project_id: projectId,
        kind: input.ontology_kind,
        name: input.name,
        aliases: input.aliases,
        version: input.version,
        supersedes_term_id: input.supersedes_term_id,
      });
      return formatToolResponse({
        record: {
          record_type: 'ontology',
          record_id: term.term_id,
          project_id: projectId,
          kind: term.kind,
          name: term.name,
          version: term.version,
          status: term.status,
        },
        memory: `Project: ${projectId} | Record: ontology ${term.name} v${term.version} | Status: ready`,
      });
    }

    if (input.record_type === 'correction') {
      const correctionKind = input.correction_kind ?? 'assertion';
      if (correctionKind === 'entity_merge') {
        if (!input.target_id || !input.source_ids?.length || !input.reason) {
          throw new Error('target_id, source_ids and reason required');
        }
        const merged = await service.mergeEntities({
          project_id: projectId,
          target_entity_id: input.target_id,
          source_entity_ids: input.source_ids,
          reason: input.reason,
        });
        return formatToolResponse({
          record: {
            record_type: 'entity_merge',
            record_id: merged.operation.operation_id,
            project_id: projectId,
            entity_id: merged.entity.entity_id,
            status: merged.entity.status,
          },
          memory: `Project: ${projectId} | Record: entity merge ${input.source_ids.length} | Status: ready`,
        });
      }
      if (correctionKind === 'entity_split') {
        if (!input.target_id || typeof input.replacement !== 'string'
          || !input.aliases?.length || !input.reason) {
          throw new Error('target_id, replacement, aliases and reason required');
        }
        const split = await service.splitEntity({
          project_id: projectId,
          source_entity_id: input.target_id,
          target_name: input.replacement,
          aliases: input.aliases,
          reason: input.reason,
        });
        return formatToolResponse({
          record: {
            record_type: 'entity_split',
            record_id: split.operation.operation_id,
            project_id: projectId,
            entity_id: split.entity.entity_id,
            status: split.entity.status,
          },
          memory: `Project: ${projectId} | Record: entity split 1 | Status: ready`,
        });
      }
      if (!input.target_id || input.replacement === undefined || !input.reason) {
        throw new Error('target_id, replacement and reason required');
      }
      const corrected = await service.correctAssertion({
        project_id: projectId,
        target_assertion_id: input.target_id,
        replacement: input.replacement,
        reason: input.reason,
        evidence_ids: input.evidence_ids,
        valid_from: input.valid_from,
        valid_to: input.valid_to,
      });
      return formatToolResponse({
        record: {
          record_type: 'correction',
          record_id: corrected.correction.correction_id,
          project_id: projectId,
          assertion_id: corrected.assertion.assertion_id,
          status: corrected.assertion.status,
        },
        memory: `Project: ${projectId} | Record: assertion correction 1 | Status: ready`,
      });
    }

    if (!input.title || !input.summary) throw new Error('title and summary required');
    const decision = await service.recordDecision({
      project_id: projectId,
      title: input.title,
      summary: input.summary,
      body: input.body,
      plan_revision_id: input.plan_revision_id,
      experiment_id: input.experiment_id,
      effective_at: input.effective_at,
      source_sequence: input.source_sequence,
      source_reference: input.source_reference,
      missing_fields: input.missing_fields,
      idempotency_key: input.idempotency_key,
    });
    return formatToolResponse({
      record: {
        record_type: 'decision',
        record_id: decision.decision_id,
        project_id: projectId,
      },
      memory: `Project: ${projectId} | Record: decision ${decision.title} | Status: ready`,
    });
  } catch (error) {
    return toolError(error);
  }
}

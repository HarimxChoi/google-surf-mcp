import type { CallToolResult } from '../response.js';
import { formatToolResponse } from '../response.js';
import { compactRankedResults } from './integration.js';
import type { AssertionValue, ExperimentStatus } from './contracts.js';
import { isTransactionConflict } from './errors.js';
import { ResearchService } from './service.js';

export interface ProjectMemorySearchInput {
  project_id?: string;
  include_project_ids?: string[];
  all_projects?: boolean;
  query?: string;
  query_variants?: string[];
  limit?: number;
}

export interface ProjectMemoryInput extends ProjectMemorySearchInput {
  action: 'create' | 'show' | 'search' | 'record' | 'rebuild' | 'export' | 'forget';
  detail_level?: 'summary' | 'full';
  export_format?: 'dot' | 'd3' | 'html' | 'neo4j';
  export_view?: 'graph' | 'ontology' | 'lineage';
  name?: string;
  record_type?: 'session' | 'plan' | 'experiment' | 'decision' | 'ontology' | 'correction';
  memory_handle?: string;
  intent?: string;
  title?: string;
  body?: string;
  change_reason?: string;
  based_on_experiment_id?: string;
  experiment_id?: string;
  hypothesis?: string;
  plan_revision_id?: string;
  status?: ExperimentStatus;
  summary?: string;
  metrics?: Record<string, string | number | boolean | null>;
  artifacts?: string[];
  roots?: Array<{ label: string; path: string }>;
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

export async function projectMemorySearchTool(
  input: ProjectMemorySearchInput,
  service: ResearchService,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  try {
    if (!input.query) throw new Error('query required');
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
    const searched = await service.searchBatch(
      scope[0],
      input.query,
      input.query_variants ?? [],
      input.limit ?? 10,
      scope.slice(1),
      signal,
    );
    const hits = searched.results;
    const results = compactRankedResults(input.query, hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      description: hit.description,
      content: hit.content,
      document_id: hit.document_id,
      project_ids: hit.project_ids,
      source_family: hit.source_family,
      retrieval_families: hit.retrieval_families
        ?? (hit.retrieval_family ? [hit.retrieval_family] : []),
      score: hit.score,
    })));
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
        reranker: vectorEnabled ? 'local_vector' : 'rrf_only',
        response_format: 'ranked_summaries',
        live_web_used: false,
        browser_used: false,
        searchapi_used: false,
        captured: false,
        query_count: searched.queries.length,
        query_variants: searched.queries.slice(1),
        query_execution: 'single_broker_request',
        graph_project_count: searched.graph_project_count,
        timings: searched.timings,
      },
      memory: `Projects: ${scope.length} | Queries: ${searched.queries.length} | Local RAG: ${results.length} results | Live web: no | Status: ready`,
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
      const project = await service.createProject(input.name, input.project_id);
      return formatToolResponse({
        project,
        memory: `Project: ${project.name} | Status: ready`,
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

    if (input.action === 'rebuild') {
      if (!input.roots?.length) {
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
      });
      return formatToolResponse({ index, memory: `${index.summary} | Status: ready` });
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
          metrics: input.metrics,
          artifacts: input.artifacts,
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
        plan_revision_id: input.plan_revision_id,
        artifacts: input.artifacts,
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
      plan_revision_id: input.plan_revision_id,
      experiment_id: input.experiment_id,
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

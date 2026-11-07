import type { CallToolResult } from '../response.js';
import { formatToolResponse } from '../response.js';
import type {
  LocalSearchFamilies, LocalSearchHit, ResearchReceipt, ResearchSearchContext, RetrievalMode,
} from './contracts.js';
import {
  attachReceipt, attachRetrievalMode, fuseLocalFamilies, fuseParallelResponse,
  fuseSearchResponse, localSearchResponse,
} from './integration.js';
import { ResearchService } from './service.js';

interface SearchArgs {
  query: string;
  limit: number;
  project_id?: string;
  include_project_ids?: string[];
  memory_handle?: string;
  session_id?: string;
  session_intent?: string;
  extract_mode?: 'none' | 'abstract' | 'full';
  retrieval_mode: RetrievalMode;
}

interface ParallelArgs {
  queries: string[];
  limit: number;
  project_id?: string;
  include_project_ids?: string[];
  memory_handle?: string;
  session_id?: string;
  session_intent?: string;
  extract_mode?: 'none' | 'abstract' | 'full';
  retrieval_mode: RetrievalMode;
}

type RankedCandidate = {
  title: string;
  url: string;
  description?: string;
  content?: string;
  fresh_web?: boolean;
  [key: string]: unknown;
};

function rows(result: CallToolResult): RankedCandidate[] {
  return result.isError || !Array.isArray(result.structuredContent?.results)
    ? []
    : result.structuredContent.results as RankedCandidate[];
}

function withRowsAndRepositoryDecisions(
  result: CallToolResult,
  nextRows: RankedCandidate[],
  decisions: unknown[],
): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  const meta = result.structuredContent.meta && typeof result.structuredContent.meta === 'object'
    ? result.structuredContent.meta as Record<string, unknown>
    : {};
  return formatToolResponse({
    ...result.structuredContent,
    results: nextRows,
    meta: { ...meta, ...(decisions.length ? { repository_ingest: decisions } : {}) },
  });
}

function resultKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function attachResearchContext(
  result: CallToolResult,
  context: ResearchSearchContext | undefined,
): CallToolResult {
  if (!context || result.isError || !result.structuredContent) return result;
  return formatToolResponse({ ...result.structuredContent, research_context: context });
}

function withWarnings(result: CallToolResult, warnings: Set<string>): CallToolResult {
  if (!warnings.size || !result.structuredContent) return result;
  const data = { ...result.structuredContent, meta: {
    ...result.structuredContent.meta as Record<string, unknown>, research_degraded: [...warnings],
    ...(warnings.has('capture') ? { memory_storage: 'not_confirmed' } : {}),
  } };
  return result.isError ? { ...result, structuredContent: data } : formatToolResponse(data);
}

function needsExpandedLive(
  liveRows: RankedCandidate[],
  local: LocalSearchFamilies | undefined,
  requestedLimit: number,
): boolean {
  if (requestedLimit >= 20) return false;
  const minimum = Math.min(requestedLimit, 5);
  if (liveRows.length < minimum) return true;
  if (!local) return false;
  const localKeys = new Set([
    ...local.exact, ...local.bm25, ...local.vector, ...local.graph,
  ].map((row) => resultKey(row.url)));
  const novel = liveRows.filter((row) => !localKeys.has(resultKey(row.url))).length;
  return novel < Math.min(2, requestedLimit);
}

function degradedSources(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value?.error) || (Array.isArray(value?.degraded_reasons) && value.degraded_reasons.length > 0);
}

async function rerankResponse(
  service: ResearchService,
  query: string,
  result: CallToolResult,
  limit: number,
): Promise<CallToolResult> {
  if (result.isError || !result.structuredContent) return result;
  const candidates = rows(result);
  const ranked = await service.rerankCandidates(query, candidates, limit);
  const meta = result.structuredContent.meta && typeof result.structuredContent.meta === 'object'
    ? result.structuredContent.meta as Record<string, unknown>
    : {};
  return formatToolResponse({
    ...result.structuredContent,
    results: ranked,
    meta: { ...meta, reranker: 'rrf_vector_tiebreak', response_format: 'ranked_candidates' },
  });
}

async function captureReceipt(
  service: ResearchService,
  tool: 'search' | 'search_parallel' | 'scholar_search' | 'extract',
  args: {
    project_id?: string;
    memory_handle?: string;
    session_id?: string;
    session_intent?: string;
    query?: string;
    queries?: string[];
  },
  result: CallToolResult,
  warnings: Set<string>,
): Promise<ResearchReceipt | undefined> {
  if (result.isError || !result.structuredContent) return undefined;
  return await service.capture({
    tool,
    project_id: args.project_id,
    memory_handle: args.memory_handle,
    session_id: args.session_id,
    session_intent: args.session_intent,
    query: args.query,
    queries: args.queries,
    payload: result.structuredContent,
  }).catch(() => { warnings.add('capture'); return undefined; });
}

async function finishLocalSearch(
  service: ResearchService,
  args: SearchArgs,
  hits: LocalSearchHit[],
  warnings: Set<string>,
): Promise<CallToolResult> {
  const ranked = await service.rerankCandidates(args.query, hits, args.limit);
  const includeContent = args.extract_mode === 'abstract' || args.extract_mode === 'full';
  const visible = localSearchResponse(args.query, ranked, includeContent);
  const captureSource = localSearchResponse(args.query, ranked, true);
  const receipt = await captureReceipt(service, 'search', args, captureSource, warnings);
  return withWarnings(attachRetrievalMode(receipt ? attachReceipt(visible, receipt) : visible, args.retrieval_mode), warnings);
}

export async function runSearchWithResearch(
  args: SearchArgs,
  service: ResearchService,
  runLive: (limit?: number) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const warnings = new Set<string>();
  const contextPromise = args.project_id
    ? service.researchSearchContext(args.project_id, [args.query]).catch(() => { warnings.add('context'); return undefined; })
    : Promise.resolve(undefined);
  const localPromise = args.project_id && args.retrieval_mode === 'hybrid'
    ? service.searchFamilies(
      args.project_id,
      args.query,
      args.limit,
      args.include_project_ids,
    ).catch(() => { warnings.add('local_retrieval'); return undefined; })
    : Promise.resolve(undefined);
  let live = await runLive(args.limit);
  const local = await localPromise;
  const context = await contextPromise;
  let rounds = 1;
  if (!live.isError && !degradedSources(live.structuredContent?.meta as Record<string, unknown> | undefined)
    && needsExpandedLive(rows(live), local, args.limit)) {
    const expanded = await runLive(Math.min(20, Math.max(10, args.limit * 2)));
    if (!expanded.isError && rows(expanded).length >= rows(live).length) live = expanded;
    rounds = 2;
  }
  if (!live.isError) {
    const prepared = await service.prepareRepositoryResults(
      args.project_id,
      args.extract_mode ?? 'none',
      rows(live),
    ).catch(() => { warnings.add('repository_ingest'); return undefined; });
    if (prepared) live = withRowsAndRepositoryDecisions(live, prepared.rows, prepared.decisions);
  }
  const localRows = local ? fuseLocalFamilies(local, args.limit) : [];
  if (live.isError && localRows.length) {
    return attachResearchContext(await finishLocalSearch(service, args, localRows, warnings), context);
  }
  const includeContent = args.extract_mode === 'abstract' || args.extract_mode === 'full';
  const candidateLimit = Math.min(40, Math.max(args.limit, args.limit * 3));
  const fused = localRows.length
    ? fuseSearchResponse(live, local!, candidateLimit, includeContent)
    : live;
  const result = await rerankResponse(service, args.query, fused, args.limit);
  const receipt = await captureReceipt(service, 'search', args, live, warnings);
  const withMode = attachRetrievalMode(
    receipt ? attachReceipt(result, receipt) : result,
    args.retrieval_mode,
  );
  if (withMode.isError || !withMode.structuredContent) return withWarnings(withMode, warnings);
  const meta = withMode.structuredContent.meta as Record<string, unknown> | undefined;
  return withWarnings(attachResearchContext(formatToolResponse({
    ...withMode.structuredContent,
    meta: { ...meta, research_rounds: rounds },
  }), context), warnings);
}

function parallelLocalResponse(
  args: ParallelArgs,
  local: Map<string, LocalSearchHit[]>,
  includeContent: boolean,
  compact = false,
): CallToolResult {
  const results = args.queries.map((query) => ({
    query,
    results: localSearchResponse(
      query,
      local.get(query) ?? [],
      includeContent,
      compact,
    )
      .structuredContent?.results ?? [],
    provider: 'local',
  }));
  return formatToolResponse({
    results,
    elapsed_ms: 0,
    meta: { provider: 'local', fusion: 'family_rrf' },
  });
}

async function finishLocalParallel(
  service: ResearchService,
  args: ParallelArgs,
  local: Map<string, LocalSearchFamilies>,
  warnings: Set<string>,
): Promise<CallToolResult> {
  const ranked = new Map(await Promise.all([...local].map(async ([query, families]) => [
    query,
    await service.rerankCandidates(query, fuseLocalFamilies(families, args.limit), args.limit),
  ] as const)));
  const includeContent = args.extract_mode === 'abstract' || args.extract_mode === 'full';
  const visible = parallelLocalResponse(args, ranked, includeContent);
  const receipt = await captureReceipt(
    service,
    'search_parallel',
    args,
    parallelLocalResponse(args, ranked, true),
    warnings,
  );
  return withWarnings(attachRetrievalMode(receipt ? attachReceipt(visible, receipt) : visible, args.retrieval_mode), warnings);
}

export async function runParallelWithResearch(
  args: ParallelArgs,
  service: ResearchService,
  runLive: (limit?: number) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const warnings = new Set<string>();
  const contextPromise = args.project_id
    ? service.researchSearchContext(args.project_id, args.queries).catch(() => { warnings.add('context'); return undefined; })
    : Promise.resolve(undefined);
  const loadLocal = async () => new Map(await Promise.all(args.queries.map(async (query) => [
    query,
    await service.searchFamilies(args.project_id!, query, args.limit, args.include_project_ids),
  ] as const)));
  const localPromise = args.project_id && args.retrieval_mode === 'hybrid'
    ? loadLocal().catch(() => { warnings.add('local_retrieval'); return new Map<string, LocalSearchFamilies>(); })
    : Promise.resolve(new Map<string, LocalSearchFamilies>());
  let live = await runLive(args.limit);
  const local = await localPromise;
  const context = await contextPromise;
  const liveGroups = Array.isArray(live.structuredContent?.results)
    ? live.structuredContent.results as Array<Record<string, unknown>>
    : [];
  const expand = !live.isError && !liveGroups.some(degradedSources) && liveGroups.some((group) => {
    const query = String(group.query ?? '');
    const groupRows = Array.isArray(group.results) ? group.results as RankedCandidate[] : [];
    return needsExpandedLive(groupRows, local.get(query), args.limit);
  });
  if (expand) {
    const expanded = await runLive(Math.min(20, Math.max(10, args.limit * 2)));
    if (!expanded.isError) live = expanded;
  }
  if (!live.isError && Array.isArray(live.structuredContent?.results)) {
    const groups = live.structuredContent.results as Array<Record<string, unknown>>;
    const preparedGroups: Array<Record<string, unknown>> = [];
    const decisions: unknown[] = [];
    let queued = false;
    for (const group of groups) {
      const groupRows = Array.isArray(group.results) ? group.results as RankedCandidate[] : [];
      const prepared: {
        rows: RankedCandidate[];
        decisions: unknown[];
        queued: boolean;
      } | undefined = await service.prepareRepositoryResults(
        args.project_id,
        args.extract_mode ?? 'none',
        groupRows,
        !queued,
      ).catch(() => { warnings.add('repository_ingest'); return undefined; });
      if (!prepared) {
        preparedGroups.push(group);
        continue;
      }
      queued ||= prepared.queued;
      decisions.push(...prepared.decisions);
      preparedGroups.push({ ...group, results: prepared.rows });
    }
    const meta = live.structuredContent.meta as Record<string, unknown> | undefined;
    live = formatToolResponse({
      ...live.structuredContent,
      results: preparedGroups,
      meta: { ...meta, ...(decisions.length ? { repository_ingest: decisions } : {}) },
    });
  }
  if (live.isError && local.size) {
    return attachResearchContext(await finishLocalParallel(service, args, local, warnings), context);
  }
  const includeContent = args.extract_mode === 'abstract' || args.extract_mode === 'full';
  const candidateLimit = Math.min(40, Math.max(args.limit, args.limit * 3));
  let result = local.size
    ? fuseParallelResponse(live, local, candidateLimit, includeContent)
    : live;
  if (!result.isError && Array.isArray(result.structuredContent?.results)) {
    const groups = await Promise.all((result.structuredContent.results as Array<Record<string, unknown>>)
      .map(async (group) => {
        const query = String(group.query ?? '');
        const candidates = Array.isArray(group.results) ? group.results as RankedCandidate[] : [];
        const ranked = await service.rerankCandidates(query, candidates, args.limit);
        return { ...group, results: ranked };
      }));
    const meta = result.structuredContent.meta as Record<string, unknown> | undefined;
    result = formatToolResponse({
      ...result.structuredContent,
      results: groups,
      meta: {
        ...meta,
        reranker: 'rrf_vector_tiebreak',
        research_rounds: expand ? 2 : 1,
        response_format: 'ranked_candidates',
      },
    });
  }
  const receipt = await captureReceipt(service, 'search_parallel', args, live, warnings);
  return withWarnings(attachResearchContext(
    attachRetrievalMode(receipt ? attachReceipt(result, receipt) : result, args.retrieval_mode),
    context,
  ), warnings);
}

export async function captureOnly(
  service: ResearchService,
  tool: 'scholar_search' | 'extract',
  args: {
    project_id?: string;
    memory_handle?: string;
    session_id?: string;
    session_intent?: string;
    query?: string;
  },
  result: CallToolResult,
): Promise<CallToolResult> {
  const warnings = new Set<string>();
  const context = tool === 'scholar_search' && args.project_id && args.query
    ? await service.researchSearchContext(args.project_id, [args.query]).catch(() => { warnings.add('context'); return undefined; })
    : undefined;
  const receipt = await captureReceipt(service, tool, args, result, warnings);
  return withWarnings(attachResearchContext(receipt ? attachReceipt(result, receipt) : result, context), warnings);
}

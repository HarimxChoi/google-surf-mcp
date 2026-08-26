import type { CallToolResult } from '../response.js';
import { formatToolResponse } from '../response.js';
import type { SearchResult } from '../types.js';
import type {
  LocalSearchFamilies, LocalSearchHit, ResearchReceipt, RetrievalMode,
} from './contracts.js';

type SearchRow = SearchResult & {
  document_id?: string;
  source_family?: 'live' | 'document' | 'code' | 'graph';
  content?: string;
  fresh_web?: boolean;
  _rrf_score?: number;
};

type LocalInput = LocalSearchHit[] | LocalSearchFamilies;

function familyRows(families: LocalSearchFamilies): LocalSearchHit[][] {
  return [families.exact, families.bm25, families.vector, families.graph];
}

function key(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function attachReceipt(result: CallToolResult, receipt: ResearchReceipt): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  return formatToolResponse({
    ...result.structuredContent,
    memory: receipt.summary,
    ...(receipt.memory_handle ? { memory_handle: receipt.memory_handle } : {}),
  });
}

export function attachRetrievalMode(
  result: CallToolResult,
  retrievalMode: RetrievalMode,
): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  const meta = asObject(result.structuredContent.meta);
  return formatToolResponse({
    ...result.structuredContent,
    meta: { ...meta, retrieval_mode: retrievalMode },
  });
}

export function localSearchResponse(
  query: string,
  hits: LocalSearchHit[],
  includeContent = false,
): CallToolResult {
  const results = hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    description: hit.description,
    document_id: hit.document_id,
    source_family: hit.source_family,
    ...(includeContent ? { content: hit.content } : {}),
  }));
  return formatToolResponse({ query, results, elapsed_ms: 0, meta: { provider: 'local', fusion: 'family_rrf' } });
}

export function fuseLocalFamilies(families: LocalSearchFamilies, limit: number): LocalSearchHit[] {
  const ranked = new Map<string, { row: LocalSearchHit; score: number; order: number }>();
  let order = 0;
  for (const rows of familyRows(families)) {
    rows.forEach((row, index) => {
      const id = key(row.url);
      const score = 1 / (60 + index + 1);
      const existing = ranked.get(id);
      if (existing) existing.score += score;
      else ranked.set(id, { row, score, order: order++ });
    });
  }
  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ row, score }) => ({ ...row, score }));
}

function localFamilies(local: LocalInput): LocalSearchFamilies {
  if (!Array.isArray(local)) return local;
  return {
    exact: local.filter((row) => row.retrieval_family === 'exact'),
    bm25: local.filter((row) => !row.retrieval_family || row.retrieval_family === 'bm25'),
    vector: local.filter((row) => row.retrieval_family === 'vector'),
    graph: local.filter((row) => row.retrieval_family === 'graph'),
  };
}

export function fuseSearchResponse(
  liveResult: CallToolResult,
  local: LocalInput,
  limit: number,
  includeContent = false,
): CallToolResult {
  if (liveResult.isError || !liveResult.structuredContent) return liveResult;
  const live = Array.isArray(liveResult.structuredContent.results)
    ? liveResult.structuredContent.results as SearchResult[]
    : [];
  const ranked = new Map<string, { row: SearchRow; score: number; order: number }>();
  let order = 0;

  const add = (row: SearchRow, rank: number, family: 'live' | 'document' | 'code' | 'graph') => {
    const id = key(row.url);
    const contribution = 1 / (60 + rank);
    const existing = ranked.get(id);
    if (!existing) {
      ranked.set(id, {
        row: { ...row, source_family: family },
        score: contribution,
        order: order++,
      });
      return;
    }
    existing.score += contribution;
    if (family === 'live') {
      existing.row = { ...existing.row, ...row, source_family: 'live' };
    }
  };

  live.forEach((row, index) => add(row, index + 1, 'live'));
  const families = localFamilies(local);
  for (const rows of familyRows(families)) {
    rows.forEach((hit, index) => add({
      title: hit.title,
      url: hit.url,
      description: hit.description,
      document_id: hit.document_id,
      ...(includeContent ? { content: hit.content } : {}),
    }, index + 1, hit.source_family));
  }

  const localKeys = new Set(familyRows(families).flat().map((row) => key(row.url)));
  const novelLive = new Set(live.map((row) => key(row.url)).filter((id) => !localKeys.has(id)));
  for (const [id, entry] of ranked) if (novelLive.has(id)) entry.row.fresh_web = true;
  const sorted = [...ranked.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order);
  const selected = sorted.slice(0, limit);
  const novelFloor = Math.min(novelLive.size, limit >= 10 ? 2 : 1);
  const selectedNovel = selected.filter(([id]) => novelLive.has(id)).length;
  if (selectedNovel < novelFloor) {
    const missing = sorted.filter(([id]) => novelLive.has(id)
      && !selected.some(([selectedId]) => selectedId === id));
    for (let index = selectedNovel; index < novelFloor && missing.length; index++) {
      const replacement = [...selected].reverse().findIndex(([id]) => !novelLive.has(id));
      if (replacement < 0) break;
      selected.splice(selected.length - 1 - replacement, 1, missing.shift()!);
    }
    selected.sort((a, b) => b[1].score - a[1].score || a[1].order - b[1].order);
  }
  const results = selected.map(([, entry]) => ({ ...entry.row, _rrf_score: entry.score }));
  const meta = asObject(liveResult.structuredContent.meta);
  return formatToolResponse({
    ...liveResult.structuredContent,
    results,
    meta: {
      ...meta,
      fusion: 'family_rrf',
      retrieval_lanes: ['live', 'exact', 'bm25', 'vector', 'graph'],
      live_novel_floor: novelFloor,
    },
  });
}

export function fuseParallelResponse(
  liveResult: CallToolResult,
  localByQuery: Map<string, LocalInput>,
  limit: number,
  includeContent = false,
): CallToolResult {
  if (liveResult.isError || !liveResult.structuredContent) return liveResult;
  const groups = Array.isArray(liveResult.structuredContent.results)
    ? liveResult.structuredContent.results as Array<Record<string, unknown>>
    : [];
  const results = groups.map((group) => {
    const query = String(group.query ?? '');
    const wrapped = formatToolResponse({ results: Array.isArray(group.results) ? group.results : [] });
    const fused = fuseSearchResponse(wrapped, localByQuery.get(query) ?? [], limit, includeContent);
    return { ...group, results: fused.structuredContent?.results ?? [] };
  });
  const meta = asObject(liveResult.structuredContent.meta);
  return formatToolResponse({
    ...liveResult.structuredContent,
    results,
    meta: {
      ...meta,
      fusion: 'family_rrf',
      retrieval_lanes: ['live', 'exact', 'bm25', 'vector', 'graph'],
    },
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

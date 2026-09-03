import type { CallToolResult } from './response.js';
import { formatToolResponse } from './response.js';

type SearchRow = {
  title?: unknown;
  description?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

const RRF_K = 5;
const PROVIDER_WEIGHT = 1;
const BM25_WEIGHT = 0.5;

function terms(value: unknown): string[] {
  return String(value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function bm25Scores(query: string, rows: SearchRow[]): number[] {
  const queryTerms = [...new Set(terms(query))];
  if (!queryTerms.length || !rows.length) return rows.map(() => 0);
  const documents = rows.map((row) => [
    ...terms(row.title), ...terms(row.title), ...terms(row.title),
    ...terms(row.description), ...terms(row.content),
  ]);
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0)
    / Math.max(documents.length, 1);
  const documentFrequency = new Map(queryTerms.map((term) => [
    term,
    documents.filter((document) => document.includes(term)).length,
  ]));
  return documents.map((document, index) => {
    const frequencies = new Map<string, number>();
    for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const normalization = frequency + 1.2 * (
        1 - 0.75 + 0.75 * document.length / Math.max(averageLength, 1)
      );
      score += idf * frequency * 2.2 / normalization;
    }
    const phrase = query.trim().toLocaleLowerCase();
    if (phrase && String(rows[index].title ?? '').toLocaleLowerCase().includes(phrase)) score += 2;
    return score;
  });
}

export function rerankLiveRows(query: string, rows: SearchRow[]): SearchRow[] {
  const lexicalScores = bm25Scores(query, rows);
  if (!lexicalScores.some((score) => score > 0)) return rows;
  const lexicalOrder = lexicalScores
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const lexicalRank = new Map(lexicalOrder.map((entry, index) => [entry.index, index + 1]));
  return rows
    .map((row, index) => ({
      row,
      index,
      score: PROVIDER_WEIGHT / (RRF_K + index + 1)
        + (lexicalRank.has(index) ? BM25_WEIGHT / (RRF_K + lexicalRank.get(index)!) : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}

export function rerankLiveResponse(result: CallToolResult, parallel = false): CallToolResult {
  if (result.isError || !result.structuredContent || !Array.isArray(result.structuredContent.results)) {
    return result;
  }
  const data = result.structuredContent;
  const sourceResults = data.results as unknown[];
  const results = parallel
    ? sourceResults.map((value: unknown) => {
      const group = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const rows = Array.isArray(group.results) ? group.results as SearchRow[] : [];
      return { ...group, results: rerankLiveRows(String(group.query ?? ''), rows) };
    })
    : rerankLiveRows(String(data.query ?? ''), sourceResults as SearchRow[]);
  const meta = data.meta && typeof data.meta === 'object' ? data.meta as Record<string, unknown> : {};
  return formatToolResponse({
    ...data,
    results,
    meta: { ...meta, reranker: 'provider_bm25_rrf' },
  });
}

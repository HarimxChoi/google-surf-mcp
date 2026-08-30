import { z } from 'zod';

export const MIN_SEARCH_EXTRACT_LIMIT = 1;
export const DEFAULT_SEARCH_EXTRACT_LIMIT = 5;
export const MAX_SEARCH_EXTRACT_LIMIT = 10;
export const DEFAULT_PARALLEL_EXTRACT_LIMIT = 12;
export const MAX_PARALLEL_EXTRACT_LIMIT = 20;
export const MAX_FULL_EXTRACT_LIMIT = 10;
export const MAX_RESEARCH_CAPTURE_CHARS = 1_000_000;
export const SUMMARY_RESPONSE_CHARS = 1_500;

export type SearchExtractScope = 'search' | 'parallel';
export type SearchExtractMode = 'none' | 'abstract' | 'full';

function maximum(scope: SearchExtractScope, mode: SearchExtractMode): number {
  if (mode === 'full') return MAX_FULL_EXTRACT_LIMIT;
  return scope === 'parallel' ? MAX_PARALLEL_EXTRACT_LIMIT : MAX_SEARCH_EXTRACT_LIMIT;
}

function defaultLimit(scope: SearchExtractScope, mode: SearchExtractMode): number {
  if (mode === 'full') return MAX_FULL_EXTRACT_LIMIT;
  return scope === 'parallel' ? DEFAULT_PARALLEL_EXTRACT_LIMIT : DEFAULT_SEARCH_EXTRACT_LIMIT;
}

function extractLimitError(value: unknown, scope: SearchExtractScope, mode: SearchExtractMode): string {
  const max = maximum(scope, mode);
  return `extract_limit must be an integer between ${MIN_SEARCH_EXTRACT_LIMIT} and ${max} for ${mode} ${scope}; received ${String(value)}. Use a value from 1 to ${max} and extract remaining_urls without repeating the search.`;
}

function extractLimitValue(max: number, scope: SearchExtractScope, mode: SearchExtractMode) {
  return z.number({ error: (issue) => extractLimitError(issue.input, scope, mode) })
    .int({ error: (issue) => extractLimitError(issue.input, scope, mode) })
    .min(MIN_SEARCH_EXTRACT_LIMIT, { error: (issue) => extractLimitError(issue.input, scope, mode) })
    .max(max, { error: (issue) => extractLimitError(issue.input, scope, mode) });
}

export function searchExtractLimitSchema() {
  return extractLimitValue(MAX_SEARCH_EXTRACT_LIMIT, 'search', 'abstract')
    .default(DEFAULT_SEARCH_EXTRACT_LIMIT);
}

export function parallelExtractLimitSchema() {
  return extractLimitValue(MAX_PARALLEL_EXTRACT_LIMIT, 'parallel', 'abstract').optional();
}

export function parseSearchExtractLimit(
  value: number | undefined,
  scope: SearchExtractScope = 'search',
  mode: SearchExtractMode = 'abstract',
): number {
  return extractLimitValue(maximum(scope, mode), scope, mode)
    .parse(value ?? defaultLimit(scope, mode));
}

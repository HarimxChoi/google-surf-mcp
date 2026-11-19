import { isDeepStrictEqual } from 'node:util';
import type { AssertionContext, LiteralAnswerInput } from './contracts.js';

export const ASSERTION_CONTEXT_FIELDS = ['conditions', 'assumptions', 'condition_expression', 'method',
  'source_observed_at', 'source_as_of', 'source_snapshot_id', 'publication_before', 'count_unit',
  'candidate_scope', 'event_kind', 'media'] as const satisfies readonly (keyof AssertionContext)[];

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`context.${field} requires a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

export function cleanAssertionContext(input?: AssertionContext): AssertionContext | undefined {
  if (!input) return undefined;
  const result: AssertionContext = {};
  for (const key of ['conditions', 'assumptions'] as const) {
    const values = input[key];
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length > 20 || values.some(value => typeof value !== 'string'
        || !value.trim() || value.length > 500)) throw new Error(`context.${key} requires at most 20 nonempty strings of at most 500 characters`);
      result[key] = [...new Set(values.map(value => value.trim()))];
    }
  }
  for (const key of ['condition_expression', 'method', 'source_snapshot_id', 'count_unit', 'event_kind'] as const) {
    if (input[key] !== undefined) result[key] = boundedText(input[key], key, key === 'condition_expression' ? 1000 : 500);
  }
  for (const key of ['source_observed_at', 'source_as_of', 'publication_before'] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || !Number.isFinite(Date.parse(value))) throw new Error(`context.${key} requires a full ISO datetime with timezone`);
      result[key] = new Date(value).toISOString();
    }
  }
  if (input.candidate_scope !== undefined) {
    const { universe, coverage, limit_per_source: limit } = input.candidate_scope;
    if (!['complete', 'window', 'unknown'].includes(coverage)) throw new Error('invalid candidate_scope.coverage');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || coverage !== 'window')) {
      throw new Error('candidate_scope.limit_per_source requires window coverage and a positive integer');
    }
    result.candidate_scope = { universe: boundedText(universe, 'candidate_scope.universe', 500), coverage,
      ...(limit === undefined ? {} : { limit_per_source: limit }) };
  }
  if (input.media !== undefined) {
    const { start_seconds: start, end_seconds: end, speaker_label: speaker, speaker_attribution: attribution } = input.media;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error('context.media requires finite 0 <= start_seconds <= end_seconds');
    }
    if (speaker !== undefined && (typeof speaker !== 'string' || !speaker.trim() || speaker.length > 200)) {
      throw new Error('context.media.speaker_label requires a nonempty string of at most 200 characters');
    }
    if (attribution !== undefined && !['unverified', 'identified_in_source', 'independently_correlated'].includes(attribution)) {
      throw new Error('invalid context.media.speaker_attribution');
    }
    result.media = { start_seconds: start, end_seconds: end, ...(speaker ? { speaker_label: speaker.trim() } : {}),
      ...(attribution ? { speaker_attribution: attribution } : {}) };
  }
  return Object.keys(result).length ? result : undefined;
}

export function matchesAssertionContext(context: AssertionContext | undefined, filter: AssertionContext): boolean {
  return ASSERTION_CONTEXT_FIELDS.every(field => filter[field] === undefined
    || isDeepStrictEqual(context?.[field], filter[field]));
}

export function renderLiteralAnswer(quote: string, transforms: LiteralAnswerInput['transforms'] = []): string {
  if (transforms.length > 3) throw new Error('answer transforms accepts at most 3 operations');
  let answer = quote;
  for (const transform of transforms) {
    if (transform === 'trim') answer = answer.trim();
    else if (transform === 'collapse_whitespace') answer = answer.replace(/\s+/gu, ' ');
    else if (transform === 'strip_punctuation') {
      // A dash joining words marks a word boundary even when punctuation is excluded.
      answer = answer.replace(/(?<=[\p{L}\p{M}])\p{Pd}+(?=\p{L})/gu, ' ').replace(/\p{P}/gu, '');
    }
    else throw new Error(`unsupported literal transform: ${transform}`);
  }
  return answer;
}

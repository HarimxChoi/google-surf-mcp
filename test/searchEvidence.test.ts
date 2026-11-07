import { describe, expect, it } from 'vitest';
import { formatToolResponse } from '../src/response.js';
import { attachSearchEvidence } from '../src/searchEvidence.js';

describe('search evidence availability', () => {
  it('keeps independent subquestions and reports gaps without claiming answerability', () => {
    const result = attachSearchEvidence(formatToolResponse({ results: [
      { query: 'setup', results: [{ url: 'https://example.org/setup', extraction_quality: 'full_text' }] },
      { query: 'limits', results: [], degraded_reasons: ['redirect_resolution_failed:2'] },
      { query: 'cost', results: [] },
      { query: 'compatibility', results: [{ url: 'https://example.org/compatibility' }] },
    ] }), 'Compare setup, limits, cost and compatibility', true);
    expect(result.structuredContent?.meta).toMatchObject({ evidence: {
      answerability: 'not_assessed',
      questions: [
        { query_index: 0, status: 'sources_found', extracted_count: 1, next_step: 'inspect_evidence' },
        { query_index: 1, status: 'degraded', next_step: 'resolve_sources' },
        { query_index: 2, status: 'empty', next_step: 'reformulate_query' },
        { query_index: 3, next_step: 'read_sources' },
      ],
    } });
  });

  it('preserves errors and reports single-query degradation', () => {
    const error = formatToolResponse(null, { code: 'INTERNAL', message: 'failed', retryable: false });
    expect(attachSearchEvidence(error)).toBe(error);
    const result = attachSearchEvidence(formatToolResponse({ results: [], meta: { degraded_reasons: ['timeout'] } }));
    expect(result.structuredContent?.meta).toMatchObject({ evidence: { questions: [{ status: 'degraded' }] } });
    const unread = attachSearchEvidence(formatToolResponse({ results: [{ url: 'https://example.org', extract_error: 'timeout' }] }));
    expect(unread.structuredContent?.meta).toMatchObject({ evidence: { questions: [{ extraction_failed_count: 1, next_step: 'retry_read' }] } });
  });

  it('keeps lexical overlap separate from truth and does not loop on blocking pages', () => {
    const result = attachSearchEvidence(formatToolResponse({ query: 'constraint', results: [
      { url: 'https://example.org', content: 'constraint', extraction_quality: 'blocked', quality_reason: 'challenge_page' },
    ] }));
    expect(result.structuredContent?.meta).toMatchObject({ evidence: {
      answerability: 'not_assessed', semantic_assessment: 'host_required',
      questions: [{ lexical_matches: 0, quality_issues: ['blocked'], next_step: 'resolve_sources' }],
    } });
  });

  it('resolves duplicate references when computing availability', () => {
    const out = attachSearchEvidence(formatToolResponse({ results: [
      { query: 'writer', results: [{ url: 'https://example.org', description: 'Only one writer.', captured_hash: 'h' }] },
      { query: 'writer', results: [{ url: 'https://example.org', description: '', evidence_ref: 'https://example.org', captured_hash: 'h' }] },
    ] }), undefined, true);
    const questions = ((out.structuredContent!.meta as any).evidence.questions);
    expect(questions[1].lexical_matches).toBe(questions[0].lexical_matches);
  });
});

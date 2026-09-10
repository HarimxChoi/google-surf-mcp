import { describe, expect, it } from 'vitest';
import { formatRerankedOutput, rerankOutput } from '../src/outputRerank.js';

describe('stateless output reranking', () => {
  it('promotes a relevant late block through exact and BM25 RRF', () => {
    const result = rerankOutput('warpquant terminal result perplexity', [
      { message: 'GPU is running' },
      { message: 'directory listing' },
      { experiment: 'warpquant', terminal_result: 'done', perplexity: 8.42 },
    ]);

    expect(result.results[0].text).toContain('perplexity');
    expect(result.meta).toMatchObject({ fusion: 'rrf', stored: false });
  });

  it('deduplicates repeated polling output and stays within the response budget', () => {
    const result = rerankOutput('training status', `${'still running\n\n'.repeat(100)}training status: complete`, {
      max_chars: 1_000,
      max_blocks: 4,
    });

    expect(result.returned_blocks).toBeLessThanOrEqual(4);
    expect(result.returned_chars).toBeLessThanOrEqual(1_000);
    expect(result.results[0].text).toContain('complete');
    const rendered = formatRerankedOutput(result);
    expect(rendered).toContain('[previous line repeated 99 more times]');
    expect(rendered.match(/still running/g)).toHaveLength(1);
  });

  it('redacts credentials from selected output', () => {
    const result = rerankOutput('API_KEY failure', 'API_KEY=secret-value\nerror: authentication failure');

    expect(formatRerankedOutput(result)).toContain('API_KEY=[REDACTED]');
    expect(formatRerankedOutput(result)).not.toContain('secret-value');
  });

  it('grows the default budget with distinct evidence instead of repeated raw volume', () => {
    const small = rerankOutput('evidence', [{ evidence: 'one' }]);
    const diverse = rerankOutput('evidence', Array.from({ length: 100 }, (_, id) => ({ evidence: `record-${id}` })));
    const repeated = rerankOutput('status', 'still running\n'.repeat(100_000));
    const unrelated = rerankOutput('perplexity', Array.from({ length: 100 }, (_, id) => ({ diagnostic: `record-${id}` })));
    expect(small.meta.response_budget_chars).toBe(1_500);
    expect(diverse.meta.response_budget_chars).toBeGreaterThan(small.meta.response_budget_chars);
    expect(diverse.meta.response_budget_chars).toBe(3_000);
    expect(repeated.meta.response_budget_chars).toBe(1_500);
    expect(unrelated.meta.response_budget_chars).toBe(1_500);
    expect(repeated.returned_chars).toBeLessThan(200);
    expect(repeated.meta.response_budget_policy).toBe('adaptive_evidence_breadth');
  });

  it('expands gradually for multiple query-matching blocks and handles empty output', () => {
    const pair = rerankOutput('evidence', [{ evidence: 'one' }, { evidence: 'two' }]);
    expect(pair.meta.response_budget_chars).toBe(2_250);
    const empty = rerankOutput('evidence', '');
    expect(empty.results).toEqual([]);
    expect(empty.meta.response_budget_chars).toBe(1_500);
  });

  it('honors explicit budgets above the default cap and below the default minimum', () => {
    const rows = Array.from({ length: 40 }, (_, id) => ({ evidence: `record-${id} ${'x'.repeat(1_000)}` }));
    const wide = rerankOutput('evidence', rows, { max_chars: 24_000, max_blocks: 30 });
    const tiny = rerankOutput('evidence', rows, { max_chars: 100 });
    expect(wide.returned_chars).toBeGreaterThan(12_000);
    expect(wide.returned_chars).toBeLessThanOrEqual(24_000);
    expect(tiny.returned_chars).toBeLessThanOrEqual(100);
    expect(wide.meta.response_budget_policy).toBe('caller');
  });
});

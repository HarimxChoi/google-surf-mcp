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
  });

  it('redacts credentials from selected output', () => {
    const result = rerankOutput('API_KEY failure', 'API_KEY=secret-value\nerror: authentication failure');

    expect(formatRerankedOutput(result)).toContain('API_KEY=[REDACTED]');
    expect(formatRerankedOutput(result)).not.toContain('secret-value');
  });
});

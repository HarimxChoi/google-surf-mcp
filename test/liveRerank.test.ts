import { describe, expect, it } from 'vitest';
import { rerankLiveResponse, rerankLiveRows } from '../src/liveRerank.js';
import { formatToolResponse } from '../src/response.js';

describe('standalone live reranking', () => {
  it('fuses provider order with query BM25 rank', () => {
    const rows = rerankLiveRows('warp quantization', [
      { title: 'General models', description: 'A broad model directory.' },
      { title: 'Unrelated result', description: 'No matching terms.' },
      { title: 'Warp quantization', description: 'Exact technical result.' },
    ]);

    expect(rows[0].title).toBe('Warp quantization');
  });

  it('preserves provider order when no lexical signal exists', () => {
    const rows = [
      { title: 'First', description: 'alpha' },
      { title: 'Second', description: 'beta' },
    ];

    expect(rerankLiveRows('unmatched', rows)).toEqual(rows);
  });

  it('keeps a relevant provider leader ahead of keyword stuffing', () => {
    const rows = rerankLiveRows('mean teacher exponential moving average consistency primary paper', [
      {
        title: 'Mean teachers are better role models',
        description: 'The primary paper introducing weight-averaged consistency targets.',
      },
      {
        title: 'Exponential moving average glossary',
        description: 'Mean teacher exponential moving average consistency primary paper '.repeat(4),
      },
    ]);

    expect(rows[0].title).toBe('Mean teachers are better role models');
  });

  it('reranks every parallel query independently', () => {
    const result = rerankLiveResponse(formatToolResponse({
      results: [{
        query: 'graph memory',
        results: [
          { title: 'Other', description: 'unrelated' },
          { title: 'Graph memory', description: 'matching result' },
        ],
      }],
    }), true);
    const group = (result.structuredContent?.results as Array<Record<string, any>>)[0];

    expect(group.results[0].title).toBe('Graph memory');
    expect(result.structuredContent?.meta).toMatchObject({ reranker: 'provider_bm25_rrf' });
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cosineSimilarity, DEFAULT_RESEARCH_VECTOR_MODEL, DEFAULT_RESEARCH_VECTOR_REVISION,
  LocalEmbeddingModel, type EmbeddingProvider,
} from '../src/research/dense.js';
import { ResearchService, tuneLocalQueries } from '../src/research/service.js';

function vector(first: number, second: number): number[] {
  return [first, second, ...new Array(382).fill(0)];
}

class FakeEmbeddings implements EmbeddingProvider {
  enabled(): boolean { return true; }
  modelId(): string { return 'fake/e5-384'; }
  dimensions(): number { return 384; }
  async embedQuery(text: string): Promise<number[]> {
    return text.includes('conceptual') ? vector(1, 0) : vector(0, 1);
  }
  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((text) => text.includes('semantic target') ? vector(1, 0) : vector(0, 1));
  }
}

describe('vector retrieval', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('uses E5 prefixes and validates cosine similarity', async () => {
    const seen: string[][] = [];
    const model = new LocalEmbeddingModel('multilingual-e5-small', async () => async (texts) => {
      seen.push(texts);
      return { tolist: () => texts.map(() => vector(1, 0)) };
    });

    await model.embedQuery('question');
    await model.embedQueries(['first', 'second']);
    await model.embedPassages(['evidence']);

    expect(seen).toEqual([
      ['query: question'],
      ['query: first', 'query: second'],
      ['passage: evidence'],
    ]);
    expect(cosineSimilarity(vector(1, 0), vector(1, 0))).toBe(1);
    expect(cosineSimilarity(vector(1, 0), vector(0, 1))).toBe(0);
  });

  it('includes the pinned default revision in the embedding identity', () => {
    const model = new LocalEmbeddingModel(DEFAULT_RESEARCH_VECTOR_MODEL, async () => async () => ({
      tolist: () => [],
    }));
    expect(model.modelId()).toBe(
      `${DEFAULT_RESEARCH_VECTOR_MODEL}@${DEFAULT_RESEARCH_VECTOR_REVISION}`,
    );
  });

  it('adds only deterministic query variants and removes duplicates', () => {
    expect(tuneLocalQueries(
      'Find "Exact Model" in WarpQuant_v2',
      ['Exact Model', 'WarpQuant_v2', 'additional evidence'],
    )).toEqual([
      'Find "Exact Model" in WarpQuant_v2',
      'Exact Model',
      'WarpQuant_v2',
      'additional evidence',
    ]);
  });

  it('runs exact, BM25, and HNSW vector retrieval as independent families', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-vector-'));
    roots.push(root);
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: new FakeEmbeddings(),
    });
    try {
      await service.createProject('Vector project', 'vector-project');
      await service.capture({
        tool: 'extract',
        project_id: 'vector-project',
        payload: {
          title: 'Exact Vector Document',
          url: 'https://example.com/vector',
          content: `${'neutral '.repeat(600)} semantic target contains lexicalneedle.`,
          extraction_quality: 'full_text',
        },
      });
      await service.waitForIdle();

      const exact = await service.searchFamilies('vector-project', 'Exact Vector Document', 10);
      const bm25 = await service.searchFamilies('vector-project', 'lexicalneedle', 10);
      const semantic = await service.searchFamilies('vector-project', 'conceptual alias', 10);

      expect(exact.exact.map((row) => row.title)).toContain('Exact Vector Document');
      expect(bm25.bm25.map((row) => row.title)).toContain('Exact Vector Document');
      expect(semantic.bm25).toHaveLength(0);
      expect(semantic.vector.map((row) => row.title)).toContain('Exact Vector Document');
    } finally {
      await service.close();
    }
  });

  it('adds semantic rank without discarding multi-lane RRF consensus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-rerank-'));
    roots.push(root);
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: new FakeEmbeddings(),
    });
    try {
      const ranked = await service.rerankCandidates('conceptual query', [
        {
          title: 'Consensus result',
          url: 'https://example.com/consensus',
          content: 'lexical and graph evidence',
          _rrf_score: 2 / 61,
        },
        {
          title: 'Semantic result',
          url: 'https://example.com/semantic',
          content: 'semantic target',
          _rrf_score: 1 / 61,
        },
      ], 2);

      expect(ranked.map((row) => row.title)).toEqual(['Consensus result', 'Semantic result']);
      expect(ranked[0]).not.toHaveProperty('_rrf_score');
    } finally {
      await service.close();
    }
  });

  it('batches query variants and reuses the primary query vector', async () => {
    class CountingEmbeddings extends FakeEmbeddings {
      queryCalls = 0;
      queryBatches = 0;

      override async embedQuery(text: string): Promise<number[]> {
        this.queryCalls++;
        return await super.embedQuery(text);
      }

      async embedQueries(texts: string[]): Promise<number[][]> {
        this.queryBatches++;
        return await Promise.all(texts.map(async (text) => await super.embedQuery(text)));
      }
    }

    const root = mkdtempSync(join(tmpdir(), 'surf-query-batch-'));
    roots.push(root);
    const embeddings = new CountingEmbeddings();
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: embeddings,
    });
    try {
      await service.createProject('Query batch', 'query-batch');
      await service.capture({
        tool: 'extract',
        project_id: 'query-batch',
        payload: {
          title: 'Batch evidence',
          url: 'https://example.com/batch',
          content: 'conceptual query lexicalneedle semantic target',
          extraction_quality: 'full_text',
        },
      });
      await service.waitForIdle();

      const result = await service.searchBatch(
        'query-batch',
        'conceptual query',
        ['lexicalneedle', 'conceptual query'],
        10,
      );

      expect(result.queries).toEqual(['conceptual query', 'lexicalneedle']);
      expect(result.results.map((row) => row.title)).toContain('Batch evidence');
      expect(embeddings.queryBatches).toBe(1);
      expect(embeddings.queryCalls).toBe(0);
      const controller = new AbortController();
      controller.abort();
      await expect(service.searchBatch(
        'query-batch',
        'cancelled query',
        [],
        10,
        [],
        controller.signal,
      )).rejects.toThrow('research search cancelled');
    } finally {
      await service.close();
    }
  });
});

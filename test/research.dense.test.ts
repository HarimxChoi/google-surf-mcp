import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalSearchHit } from '../src/research/contracts.js';
import {
  cosineSimilarity, DEFAULT_RESEARCH_VECTOR_MODEL, DEFAULT_RESEARCH_VECTOR_REVISION,
  LocalEmbeddingModel, type EmbeddingProvider,
} from '../src/research/dense.js';
import { ResearchService, tuneLocalQueries } from '../src/research/service.js';

function vector(first: number, second: number): number[] {
  return [first, second, ...new Array(382).fill(0)];
}

class FakeEmbeddings implements EmbeddingProvider {
  lastPassageCount = 0;
  enabled(): boolean { return true; }
  modelId(): string { return 'fake/e5-384'; }
  dimensions(): number { return 384; }
  async embedQuery(text: string): Promise<number[]> {
    return text.includes('conceptual') ? vector(1, 0) : vector(0, 1);
  }
  async embedPassages(texts: string[]): Promise<number[][]> {
    this.lastPassageCount = texts.length;
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

  it('bounds inference batches and serializes callers without poisoning the queue on failure', async () => {
    let active = 0;
    let peak = 0;
    let fail = true;
    const batches: string[][] = [];
    const model = new LocalEmbeddingModel('fake-e5', async () => async (texts) => {
      batches.push(texts);
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (fail) { fail = false; throw new Error('inference failed'); }
        return { tolist: () => texts.map(() => vector(1, 0)) };
      } finally {
        active--;
      }
    });
    await expect(model.embedQuery('failure')).rejects.toThrow('inference failed');
    const [passages, query] = await Promise.all([
      model.embedPassages(Array.from({ length: 11 }, (_, index) => `document ${index}`)),
      model.embedQuery('question'),
    ]);
    expect(passages).toHaveLength(11);
    expect(query).toHaveLength(384);
    expect(peak).toBe(1);
    expect(batches.every((batch) => batch.length <= 8)).toBe(true);
    expect(batches.some((batch) => batch.length === 8)).toBe(true);
    const count = batches.length;
    await model.embedQuery('question');
    expect(batches).toHaveLength(count);
    await model.dispose();
  });

  it('persists each embedding batch and resumes a drained job without regenerating cached passages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-vector-drain-'));
    roots.push(root);
    const fixture = fileURLToPath(new URL('./fixtures/research-embedding-drain.mjs', import.meta.url));
    const reports: Array<{ batches: string[][]; vector_hits?: number; queued_vector_hits?: number }> = [];
    for (const mode of ['write', 'read']) {
      const child = spawnSync(process.execPath, [fixture, mode, root], { encoding: 'utf8', timeout: 25_000 });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      reports.push(JSON.parse(child.stdout.trim()));
    }
    expect(reports[0].batches).toHaveLength(1);
    expect(reports[0].batches[0]).toHaveLength(4);
    expect(reports[1].batches.length).toBeGreaterThan(0);
    expect(reports[1].batches.flat().some((text) => reports[0].batches[0].includes(text))).toBe(false);
    expect(reports[1].vector_hits).toBeGreaterThan(0);
    expect(reports[1].queued_vector_hits).toBeGreaterThan(0);
  }, 30_000);

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
    const embeddings = new FakeEmbeddings();
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: embeddings,
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

  it('preserves first-page HNSW candidates when the reranker requests a wider pool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-vector-page-'));
    roots.push(root);
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: new FakeEmbeddings(),
    });
    try {
      await service.createProject('Vector page', 'vector-page');
      for (let index = 0; index < 24; index++) {
        await service.capture({
          tool: 'extract',
          project_id: 'vector-page',
          payload: {
            title: `Vector page ${index}`,
            url: `https://example.com/vector-page-${index}`,
            content: `semantic target ${index}`,
            extraction_quality: 'full_text',
          },
        });
      }
      await service.waitForIdle();

      const firstPage = await service.searchFamilies('vector-page', 'conceptual alias', 10);
      const expanded = await service.searchFamilies('vector-page', 'conceptual alias', 20);
      const expandedUrls = new Set(expanded.vector.map((row) => row.url));

      expect(firstPage.vector).toHaveLength(10);
      expect(firstPage.vector.every((row) => expandedUrls.has(row.url))).toBe(true);
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

  it('reranks the bounded candidate pool instead of only the first page', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-rerank-pool-'));
    roots.push(root);
    const embeddings = new FakeEmbeddings();
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: embeddings,
    });
    try {
      const candidates = Array.from({ length: 24 }, (_, index) => ({
        title: index === 10 ? 'Semantic tail target' : `Lexical distractor ${index}`,
        url: `https://example.com/candidate-${index}`,
        content: index === 10 ? 'semantic target' : 'unrelated passage',
        _rrf_score: 1 / (61 + index),
      }));
      const ranked = await service.rerankCandidates('conceptual query', candidates, 10);

      expect(embeddings.lastPassageCount).toBe(12);
      expect(ranked.map((row) => row.title)).toContain('Semantic tail target');
    } finally {
      await service.close();
    }
  });

  it('preserves bounded lane consensus when expanded lanes add more candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-rerank-expanded-'));
    roots.push(root);
    const embeddings = new FakeEmbeddings();
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: embeddings,
    });
    const hit = (title: string, family: LocalSearchHit['retrieval_family']): LocalSearchHit => ({
      title,
      url: `https://example.com/${title.toLowerCase().replaceAll(' ', '-')}`,
      description: title,
      document_id: title,
      content: title === 'Bounded semantic target' ? 'semantic target' : 'unrelated passage',
      score: 1,
      project_ids: ['expanded-pool'],
      source_family: 'document',
      retrieval_family: family,
    });
    try {
      await service.createProject('Expanded pool', 'expanded-pool');
      const shared = Array.from({ length: 8 }, (_, index) => `Shared ${index}`);
      const expanded = Array.from({ length: 10 }, (_, index) => `Expanded ${index}`);
      vi.spyOn(service, 'searchFamilies').mockImplementation(async (...args) => {
        await args[4];
        return {
        exact: [
          hit('Bounded semantic target', 'exact'),
          ...Array.from({ length: 19 }, (_, index) => hit(`Exact ${index}`, 'exact')),
        ],
        bm25: [
          ...shared.map((title) => hit(title, 'bm25')),
          hit('BM25 bounded 8', 'bm25'),
          hit('BM25 bounded 9', 'bm25'),
          ...expanded.map((title) => hit(title, 'bm25')),
        ],
        vector: [
          ...shared.map((title) => hit(title, 'vector')),
          hit('Vector bounded 8', 'vector'),
          hit('Vector bounded 9', 'vector'),
          ...expanded.map((title) => hit(title, 'vector')),
        ],
        graph: [],
        degraded_lanes: [],
        };
      });

      const baseline = await service.searchHybridBaseline(
        'expanded-pool',
        'conceptual query',
        10,
      );

      expect(embeddings.lastPassageCount).toBe(0);
      expect(baseline.map((row) => row.title)).toContain('Bounded semantic target');

      const result = await service.searchBatch(
        'expanded-pool',
        'conceptual query',
        [],
        10,
        [],
        undefined,
        { retrieval_lanes: ['exact', 'bm25', 'vector'] },
      );

      expect(embeddings.lastPassageCount).toBe(12);
      expect(result.results.map((row) => row.title)).toContain('Bounded semantic target');
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

  it('returns completed retrieval lanes when the response deadline interrupts reranking', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-vector-'));
    roots.push(root);
    const embeddings = new FakeEmbeddings();
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      embeddingProvider: embeddings,
    });
    try {
      await service.createProject('Deadline query', 'deadline-query');
      for (let index = 0; index < 2; index++) {
        await service.capture({
          tool: 'extract',
          project_id: 'deadline-query',
          payload: {
            title: `Deadline evidence ${index}`,
            url: `https://example.com/deadline-${index}`,
            content: `deadline evidence semantic target ${index}`,
            extraction_quality: 'full_text',
          },
        });
      }
      await service.waitForIdle();

      let releaseRerank!: () => void;
      let enteredRerank!: () => void;
      const blocked = new Promise<void>((resolveBlocked) => { releaseRerank = resolveBlocked; });
      const entered = new Promise<void>((resolveEntered) => { enteredRerank = resolveEntered; });
      const embedPassages = embeddings.embedPassages.bind(embeddings);
      embeddings.embedPassages = async (texts: string[]) => {
        enteredRerank();
        await blocked;
        return await embedPassages(texts);
      };
      const pending = service.searchBatch(
        'deadline-query', 'deadline evidence', [], 10, [], undefined, undefined,
        true, false, 'deadline-partial', 1_000,
      );
      await entered;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_050));
      releaseRerank();

      const result = await pending;
      expect(result.partial).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.completed_lanes).toEqual(expect.arrayContaining(['exact', 'bm25', 'vector', 'graph']));
      expect(result.incomplete_reason).toBe('response_deadline');
      expect(service.queryStatus('deadline-partial')).toMatchObject({
        status: 'partial', phase: 'complete', cancel_reason: 'response_deadline',
      });
    } finally {
      await service.close();
    }
  });
});

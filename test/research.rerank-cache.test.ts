import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalEmbeddingModel, type EmbeddingProvider } from '../src/research/dense.js';
import { ResearchService } from '../src/research/service.js';
import type { ResearchStore } from '../src/research/store.js';

const vector = (target: boolean) => [target ? 1 : 0, target ? 0 : 1, ...new Array(382).fill(0)];
const candidates = () => Array.from({ length: 12 }, (_, index) => ({
  title: `Candidate ${index}`, content: index === 10 ? 'semantic target' : `other ${index}`,
  url: `https://example.com/${index}`, _rrf_score: 1 / (61 + index),
}));

describe('persistent rerank passage vectors', () => {
  const resources: Array<{ root: string; service: ResearchService }> = [];
  const open = async (embeddingProvider: EmbeddingProvider) => {
    const root = await mkdtemp(join(tmpdir(), 'surf-rerank-cache-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', embeddingProvider });
    resources.push({ root, service });
    await service.createProject('Rerank cache', 'cache');
    return { service, store: (service as unknown as { store: ResearchStore }).store };
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const { root, service } of resources.splice(0)) {
      await service.close();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('preserves ranking after model disposal without re-encoding persisted passages', async () => {
    const batches: string[][] = [];
    const factory = vi.fn(async () => async (texts: string[]) => {
      batches.push(texts);
      return { tolist: () => texts.map(text => vector(text.includes('semantic target'))) };
    });
    const model = new LocalEmbeddingModel('fixture-e5', factory);
    const { service, store } = await open(model);
    const reads = vi.spyOn(store, 'cachedEmbeddings');
    const first = await service.rerankCandidates('question', candidates(), 10, vector(true));
    expect(first.map(row => row.url)).toContain('https://example.com/10');
    expect(batches.flat()).toHaveLength(12);
    await model.dispose();
    expect(model.diagnostics().cached_vectors).toBe(0);
    const second = await service.rerankCandidates('question', candidates(), 10, vector(true));
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledOnce();
    expect(batches.flat()).toHaveLength(12);
    expect(model.diagnostics().loaded).toBe(false);
    expect(model.diagnostics().cached_vectors).toBe(12);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await service.rerankCandidates('question', candidates(), 10, vector(true))).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('invalidates changed representations and model fingerprints only', async () => {
    let revision = 'one';
    const encoded: string[] = [];
    const provider: EmbeddingProvider = {
      enabled: () => true, modelId: () => 'fixture-e5', dimensions: () => 384,
      fingerprint: () => ({ revision, normalization: 'fixture', quantization: 'fixture' }),
      embedQuery: async () => vector(true),
      embedPassages: async texts => { encoded.push(...texts); return texts.map(text => vector(text.includes('semantic target'))); },
    };
    const { service } = await open(provider);
    const rows = candidates();
    rows[0].content = 'x'.repeat(1300);
    await service.rerankCandidates('question', rows, 10, vector(true));
    expect(encoded).toHaveLength(12);
    rows[0].content += 'outside the representation';
    await service.rerankCandidates('question', rows, 10, vector(true));
    expect(encoded).toHaveLength(12);
    rows[0].title = 'Changed title';
    await service.rerankCandidates('question', rows, 10, vector(true));
    expect(encoded).toHaveLength(13);
    revision = 'two';
    await service.rerankCandidates('question', rows, 10, vector(true));
    expect(encoded).toHaveLength(25);
  });

  it('keeps semantic ranking when derived-cache reads or writes fail', async () => {
    const provider: EmbeddingProvider = {
      enabled: () => true, modelId: () => 'fixture-e5', dimensions: () => 384,
      embedQuery: async () => vector(true),
      embedPassages: async texts => texts.map(text => vector(text.includes('semantic target'))),
    };
    const { service, store } = await open(provider);
    const read = vi.spyOn(store, 'cachedEmbeddings').mockRejectedValueOnce(new Error('cache unavailable'));
    const write = vi.spyOn(store, 'putCachedEmbeddings').mockRejectedValue(new Error('cache full'));
    const first = await service.rerankCandidates('question', candidates(), 10, vector(true));
    expect(first.map(row => row.url)).toContain('https://example.com/10');
    expect(write).not.toHaveBeenCalled();
    read.mockResolvedValue(new Map());
    expect(await service.rerankCandidates('question', candidates(), 10, vector(true))).toEqual(first);
    expect(write).toHaveBeenCalledOnce();
  });

  it('recomputes invalid cached vectors and coalesces duplicate representations', async () => {
    const embedPassages = vi.fn(async (texts: string[]) => texts.map(text => vector(text.includes('semantic target'))));
    const provider: EmbeddingProvider = {
      enabled: () => true, modelId: () => 'fixture-e5', dimensions: () => 384,
      embedQuery: async () => vector(true), embedPassages,
    };
    const { service, store } = await open(provider);
    vi.spyOn(store, 'cachedEmbeddings').mockImplementation(async keys => new Map(keys.map((key, index) =>
      [key, index % 2 ? [1] : new Array(384).fill(NaN)])));
    const rows = candidates();
    rows[1] = { ...rows[0] };
    const ranked = await service.rerankCandidates('question', rows, 10, vector(true));
    expect(ranked.map(row => row.url)).toContain('https://example.com/10');
    expect(embedPassages).toHaveBeenCalledOnce();
    expect(embedPassages.mock.calls[0][0]).toHaveLength(11);
  });
});

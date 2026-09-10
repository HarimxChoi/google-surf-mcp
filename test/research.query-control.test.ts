import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { ResearchStore } from '../src/research/store.js';
import type { LocalSearchHit, ProjectRecord } from '../src/research/contracts.js';
import { projectMemorySearchTool } from '../src/research/tools.js';
import { toErrorInfo } from '../src/response.js';
import { researchBrokerTimeoutMs } from '../src/research/broker.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function hit(id = 'evidence', family: LocalSearchHit['retrieval_family'] = 'exact'): LocalSearchHit {
  return {
    title: id, url: `https://example.com/${id}`, description: 'experiment result', content: 'experiment result',
    document_id: id, record_id: id, revision_id: 'revision-1', body_handle: id,
    project_ids: ['project'], source_family: 'document', retrieval_family: family, score: 1,
  };
}

function fixture() {
  const embeddings = {
    enabled: () => true, modelId: () => 'test/model', dimensions: () => 384,
    embedQuery: vi.fn(async () => [1, 0]),
    embedQueries: vi.fn(async (queries: string[]) => queries.map(() => [1, 0])),
    embedPassages: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  };
  const service = new ResearchService({ enabled: true, root: 'unused-query-test-root', endpoint: 'mem://', embeddingProvider: embeddings });
  vi.spyOn(service as unknown as { ensureProject: (id: string) => Promise<ProjectRecord> }, 'ensureProject')
    .mockImplementation(async (id) => ({ project_id: id } as ProjectRecord));
  const store = Reflect.get(service, 'store') as ResearchStore;
  const exact = vi.spyOn(store, 'searchProjectExact').mockResolvedValue([hit()]);
  const bm25 = vi.spyOn(store, 'searchProjectBm25').mockResolvedValue([hit('lexical', 'bm25')]);
  const vector = vi.spyOn(store, 'searchProjectVector').mockResolvedValue([hit('semantic', 'vector')]);
  const graphIndexes = vi.spyOn(store, 'ensureGraphSearchIndexes').mockResolvedValue(undefined);
  const graphSeeds = vi.spyOn(store, 'searchGraphSeeds').mockResolvedValue([]);
  const linked = vi.spyOn(store, 'linkedProjectIds').mockResolvedValue([]);
  return { service, embeddings, store, exact, bm25, vector, graphIndexes, graphSeeds, linked };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('lightweight query execution', () => {
  it('never initializes embeddings or prepares graph when only lexical lanes are requested', async () => {
    const f = fixture();
    f.exact.mockResolvedValue([]);
    f.bm25.mockResolvedValue([]);
    const response = await projectMemorySearchTool({
      project_id: 'project', query: 'evidence', filters: { retrieval_lanes: ['exact', 'bm25'] },
    }, f.service);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent?.meta).toMatchObject({
      retrieval_lanes: ['exact', 'bm25'], completed_lanes: ['exact', 'bm25'], reranker: 'rrf_only',
      graph_project_count: 0, degraded_lanes: [],
    });
    expect(f.embeddings.embedQueries).not.toHaveBeenCalled();
    expect(f.embeddings.embedQuery).not.toHaveBeenCalled();
    expect(f.embeddings.embedPassages).not.toHaveBeenCalled();
    expect(f.graphIndexes).not.toHaveBeenCalled();
    expect(f.graphSeeds).not.toHaveBeenCalled();
    expect(f.linked).not.toHaveBeenCalled();
    await f.service.close();
  });

  it('returns exact evidence at the deadline while BM25 is still pending and coalesces its retry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    f.bm25.mockReturnValue(blocked.promise);
    const run = (id: string) => f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
      { retrieval_lanes: ['exact', 'bm25'] }, false, false, id, 1_000);
    try {
      const first = run('first');
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await first;
      expect(result).toMatchObject({ partial: true, completed_lanes: ['exact'], degraded_lanes: ['bm25'], incomplete_reason: 'response_deadline' });
      expect(result.results[0]).toMatchObject({ record_id: 'evidence', revision_id: 'revision-1', body_handle: 'evidence' });
      const snapshot = f.service.queryStatus('first');
      expect(f.service.status().background_jobs).toBe(1);
      const second = run('second');
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await second).partial).toBe(true);
      expect(f.bm25).toHaveBeenCalledTimes(1);
      const closing = vi.fn();
      const close = f.service.close().then(closing);
      await vi.advanceTimersByTimeAsync(0);
      expect(closing).not.toHaveBeenCalled();
      blocked.resolve([hit('late', 'bm25')]);
      await close;
      expect(f.service.queryStatus('first')).toEqual(snapshot);
      expect(result.results.map((row) => row.document_id)).toEqual(['evidence']);
      expect(f.service.status().background_jobs).toBe(0);
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('does not hold lexical results behind a blocked embedding model', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<number[][]>();
    f.embeddings.embedQueries.mockReturnValue(blocked.promise);
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'vector'] }, true, false, 'embedding', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ partial: true, completed_lanes: ['exact'], degraded_lanes: ['vector'] });
      expect(f.exact).toHaveBeenCalled();
      expect(f.vector).not.toHaveBeenCalled();
      blocked.reject(new Error('model unavailable'));
      await f.service.waitForIdle();
      expect(f.embeddings.embedQuery).not.toHaveBeenCalled();
      expect(f.vector).not.toHaveBeenCalled();
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it.each(['rejected', 'empty'] as const)('does not retry a %s query embedding during reranking', async (outcome) => {
    const f = fixture();
    if (outcome === 'rejected') f.embeddings.embedQueries.mockRejectedValue(new Error('model unavailable'));
    else f.embeddings.embedQueries.mockResolvedValue([]);
    try {
      const response = await projectMemorySearchTool({ project_id: 'project', query: 'evidence',
        filters: { retrieval_lanes: ['exact', 'bm25', 'vector'] } }, f.service);
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent?.results).toHaveLength(2);
      expect(response.structuredContent?.meta).toMatchObject({
        completed_lanes: ['exact', 'bm25'], degraded_lanes: ['vector'], reranker: 'rrf_only',
      });
      expect(f.embeddings.embedQueries).toHaveBeenCalledTimes(1);
      expect(f.embeddings.embedQuery).not.toHaveBeenCalled();
      expect(f.embeddings.embedPassages).not.toHaveBeenCalled();
      expect(f.vector).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it('partitions overlapping embedding and retrieval time without double counting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    f.embeddings.embedQueries.mockImplementation(async (queries) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return queries.map(() => [1, 0]);
    });
    f.exact.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return [hit()];
    });
    f.embeddings.embedPassages.mockImplementation(async (texts) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return texts.map(() => [1, 0]);
    });
    const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
      { retrieval_lanes: ['exact', 'vector'] });
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result.timings).toEqual({ embedding_ms: 250, retrieval_ms: 150, rerank_ms: 100 });
    expect(Object.values(result.timings).reduce((sum, value) => sum + value, 0)).toBe(500);
    expect(result.reranker).toBe('local_vector');
    await f.service.close();
  });

  it('accounts for a response deadline while embedding is still pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    const blocked = deferred<number[][]>();
    f.embeddings.embedQueries.mockReturnValue(blocked.promise);
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'vector'] }, true, false, 'timing-partial', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).timings).toEqual({ embedding_ms: 1_000, retrieval_ms: 0, rerank_ms: 0 });
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('allows the maximum service deadline to report before the earlier transport watchdog', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    f.exact.mockReturnValue(blocked.promise);
    const args = ['project', 'evidence', [], 5, [], undefined, { retrieval_lanes: ['exact'] }, false, false, 'maximum', 300_000];
    const transportTimeout = vi.fn();
    const watchdog = setTimeout(transportTimeout, researchBrokerTimeoutMs('searchBatch', args));
    try {
      expect(researchBrokerTimeoutMs('searchBatch', args)).toBe(600_000);
      expect(researchBrokerTimeoutMs('searchBatch', [])).toBe(300_000);
      expect(researchBrokerTimeoutMs('indexProject', [])).toBe(3_600_000);
      await vi.advanceTimersByTimeAsync(250);
      const pending = projectMemorySearchTool({ project_id: 'project', query: 'evidence',
        filters: { retrieval_lanes: ['exact'] }, request_id: 'maximum', response_deadline_ms: 300_000 }, f.service);
      await vi.advanceTimersByTimeAsync(300_000);
      expect((await pending).structuredContent?.error).toMatchObject({ code: 'QUERY_TIMEOUT', request_id: 'maximum' });
      expect(transportTimeout).not.toHaveBeenCalled();
    } finally { clearTimeout(watchdog); blocked.resolve([]); await f.service.close(); }
  });

  it('reports structured deadline errors and request IDs when no lane has finished', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    f.exact.mockReturnValue(blocked.promise);
    try {
      const pending = projectMemorySearchTool({ project_id: 'project', query: 'evidence',
        filters: { retrieval_lanes: ['exact'] }, request_id: 'timeout', response_deadline_ms: 1_000 }, f.service);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).structuredContent?.error).toMatchObject({
        code: 'QUERY_TIMEOUT', request_id: 'timeout', phase: 'retrieval', cancel_reason: 'response_deadline', retryable: false,
      });
      expect(f.service.queryStatus('timeout')).toMatchObject({ status: 'cancelled', degraded_lanes: ['exact'] });
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('keeps caller cancellation distinct from a response deadline', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const error = await f.service.searchBatch('project', 'evidence', [], 5, [], controller.signal,
      { retrieval_lanes: ['exact'] }, false, false, 'cancel').catch((value: Error) => value);
    expect(toErrorInfo(error, { cloudMode: false })).toMatchObject({ code: 'QUERY_CANCELLED', request_id: 'cancel' });
    expect(f.exact).not.toHaveBeenCalled();
    expect(f.embeddings.embedQueries).not.toHaveBeenCalled();
    await f.service.close();
  });

  it('preserves evidence from a finished project without claiming its entire cross-project lane finished', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    f.exact.mockImplementation(async (id) => id === 'project' ? [hit()] : await blocked.promise);
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, ['other'], undefined,
        { retrieval_lanes: ['exact'] }, false, false, 'cross', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ partial: true, completed_lanes: [], degraded_lanes: ['exact'], results: [expect.objectContaining({ record_id: 'evidence' })] });
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('returns an empty partial result if one lane finished without hits', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    f.exact.mockResolvedValue([]);
    f.bm25.mockReturnValue(blocked.promise);
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'bm25'] }, false, false, 'empty', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ partial: true, results: [], completed_lanes: ['exact'] });
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('keeps lexical results when graph preparation stalls and does not start later graph work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<string[]>();
    f.linked.mockReturnValue(blocked.promise);
    const graph = vi.spyOn(f.store, 'currentGraph');
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'graph'] }, false, false, 'graph', 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ partial: true, completed_lanes: ['exact'], degraded_lanes: ['graph'] });
      blocked.resolve([]);
      await f.service.waitForIdle();
      await vi.advanceTimersByTimeAsync(0);
      expect(graph).not.toHaveBeenCalled();
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('returns before blocked reranking settles and reports the actual response phase', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<number[][]>();
    f.embeddings.embedPassages.mockReturnValue(blocked.promise);
    try {
      const pending = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'vector'] }, true, false, 'rerank', 1_000);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.service.queryStatus('rerank').phase).toBe('rerank');
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ partial: true, completed_lanes: ['exact', 'vector'], degraded_lanes: [] });
      expect(f.service.status().background_jobs).toBe(1);
    } finally { blocked.resolve([[1, 0], [1, 0]]); await f.service.close(); }
  });

  it('does not share a native read across a changed project generation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    const getProject = vi.spyOn(f.service as unknown as { ensureProject: () => Promise<ProjectRecord> }, 'ensureProject');
    getProject.mockResolvedValue({ project_id: 'project', catalog_generation: 1 } as ProjectRecord);
    f.exact.mockReturnValueOnce(blocked.promise).mockResolvedValue([hit('new-revision')]);
    try {
      const old = f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact'] }, false, false, 'old', 1_000).catch((error) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await old).toMatchObject({ code: 'QUERY_TIMEOUT' });
      getProject.mockResolvedValue({ project_id: 'project', catalog_generation: 2 } as ProjectRecord);
      const current = await f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact'] }, false, false, 'current');
      expect(current.results[0].record_id).toBe('new-revision');
      expect(f.exact).toHaveBeenCalledTimes(2);
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('retains the broker admission slot until native work drains, not just until the response returns', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const blocked = deferred<LocalSearchHit[]>();
    const released = vi.fn();
    f.bm25.mockReturnValue(blocked.promise);
    try {
      const pending = f.service.withSearchReadLease(() => f.service.searchBatch('project', 'evidence', [], 5, [], undefined,
        { retrieval_lanes: ['exact', 'bm25'] }, false, false, 'leased', 1_000), released);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).partial).toBe(true);
      expect(released).not.toHaveBeenCalled();
      blocked.resolve([]);
      await f.service.waitForIdle();
      await vi.advanceTimersByTimeAsync(0);
      expect(released).toHaveBeenCalledTimes(1);
    } finally { blocked.resolve([]); await f.service.close(); }
  });

  it('distinguishes disabled lanes from completed or degraded ones and adapts the response budget', async () => {
    const f = fixture();
    const first = await projectMemorySearchTool({ project_id: 'project', query: 'evidence',
      filters: { retrieval_lanes: ['exact'] } }, f.service);
    f.exact.mockResolvedValue(Array.from({ length: 10 }, (_, index) => hit(`evidence-${index}`)));
    const many = await projectMemorySearchTool({ project_id: 'project', query: 'evidence',
      filters: { retrieval_lanes: ['exact'] } }, f.service);
    const firstMeta = first.structuredContent?.meta as Record<string, number>;
    const manyMeta = many.structuredContent?.meta as Record<string, number>;
    expect(manyMeta.response_budget_bytes).toBeGreaterThan(firstMeta.response_budget_bytes);
    expect(manyMeta).toMatchObject({ response_budget_policy: 'adaptive_evidence_breadth', completed_lanes: ['exact'], degraded_lanes: [] });
    await f.service.close();
  });

  it('retains provenance when escaped Unicode descriptions need to fit a caller budget', async () => {
    const f = fixture();
    f.exact.mockResolvedValue([{ ...hit(), description: '\\"\n한글🙂'.repeat(1_000) }]);
    const response = await projectMemorySearchTool({ project_id: 'project', query: 'evidence',
      response_budget_bytes: 1_000, filters: { retrieval_lanes: ['exact'] } }, f.service);
    expect(response.structuredContent?.results).toEqual([expect.objectContaining({ record_id: 'evidence', revision_id: 'revision-1', body_handle: 'evidence' })]);
    expect(Buffer.byteLength(JSON.stringify(response.structuredContent?.results))).toBeLessThanOrEqual(1_000);
    expect(response.structuredContent?.meta).toMatchObject({ response_budget_policy: 'caller' });
    expect(JSON.stringify(response.structuredContent?.results)).not.toContain('\uFFFD');
    await f.service.close();
  });
});

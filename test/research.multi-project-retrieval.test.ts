import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { ResearchStore } from '../src/research/store.js';

describe('bounded multi-project retrieval', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('shares code rank metadata and hydrates only project-owned candidate bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surf-shared-source-ranks-'));
    roots.push(root);
    const service = new ResearchService({ enabled: true, root: join(root, 'db'), endpoint: 'mem://', vectorModel: '' });
    try {
      for (const id of ['alpha', 'beta']) {
        const source = join(root, id);
        await mkdir(source);
        await writeFile(join(source, `${id}.ts`), `export const ${id} = "commonrankmarker ${id}";`);
        await service.createProject(id, id);
        await service.indexProject({ project_id: id, roots: [{ label: 'repo', path: source }] });
        await service.waitForIdle();
      }
      const rankSpy = vi.spyOn(service.store, 'searchSourceRanks');
      const db = await service.store.open();
      const reads = vi.spyOn(db, 'select');
      const result = await service.searchFamilies('alpha', 'commonrankmarker', 5, ['beta'], undefined,
        false, undefined, { retrieval_lanes: ['bm25'] });
      expect(rankSpy).toHaveBeenCalledOnce();
      expect((await rankSpy.mock.results[0].value).every((row: object) => !('text' in row))).toBe(true);
      expect(result.bm25.map((row) => row.project_ids[0]).sort()).toEqual(['alpha', 'beta']);
      expect(reads.mock.calls.filter(([id]) => String(id).startsWith('source_body:'))).toHaveLength(2);
      expect(result.bm25.every((row) => row.content?.includes(`commonrankmarker ${row.project_ids[0]}`))).toBe(true);
      const alpha = await service.store.searchProjectBm25('alpha', 'commonrankmarker', 5);
      expect(alpha).toHaveLength(1);
      expect(alpha[0].content).toContain('commonrankmarker alpha');
    } finally {
      await service.close();
    }
  });

  it('limits concurrent project reads to two and completes a lane only after every project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surf-project-read-concurrency-'));
    roots.push(root);
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    try {
      const ids = Array.from({ length: 6 }, (_, index) => `scope-${index}`);
      for (const id of ids) await service.createProject(id, id);
      let active = 0;
      let peak = 0;
      vi.spyOn(service.store, 'searchProjectBm25').mockImplementation(async (id) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, id.endsWith('0') ? 20 : 1));
          return [{ document_id: id, title: id, url: `https://example.com/${id}`, description: id,
            score: 1, project_ids: [id], source_family: 'document', retrieval_family: 'bm25' }];
        } finally { active--; }
      });
      const completed: boolean[] = [];
      const result = await service.searchFamilies(ids[0], 'query', 10, ids.slice(1), undefined,
        false, undefined, { retrieval_lanes: ['bm25'] }, (_lane, _rows, complete) => completed.push(complete));
      expect(peak).toBe(2);
      expect(completed.filter(Boolean)).toHaveLength(1);
      expect(completed.at(-1)).toBe(true);
      expect(result.bm25.map((row) => row.title).sort()).toEqual(ids);
    } finally {
      await service.close();
    }
  });

  it('does not search HNSW for a project without vectors for the requested model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surf-empty-vector-scope-'));
    roots.push(root);
    const store = new ResearchStore(root, 'mem://');
    try {
      const db = await store.open();
      const queries = vi.spyOn(db, 'query');
      expect(await store.searchProjectVector('empty', 'model', new Array(384).fill(0), 10)).toEqual([]);
      expect(queries.mock.calls.some(([sql]) => String(sql).includes('embedding <|'))).toBe(false);
      expect(queries.mock.calls.some(([sql]) => String(sql).includes('LIMIT $scope_limit'))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('lets foreground retrieval finish before starting queued background indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surf-read-priority-'));
    roots.push(root);
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    let release = () => {};
    try {
      await service.createProject('Read priority', 'priority');
      let started = () => {};
      const reading = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.spyOn(service.store, 'searchProjectBm25').mockImplementation(async () => {
        started(); await gate; return [];
      });
      const search = service.searchFamilies('priority', 'priorityneedle', 5, [], undefined,
        false, undefined, { retrieval_lanes: ['bm25'] });
      await reading;
      await service.writeCatalogRecord({ project_id: 'priority', kind: 'document', operation: 'create',
        asset_id: 'queued-document', idempotency_key: 'queued-document-v1',
        body: 'Background evidence stays durable.', fields: { title: 'Queued evidence' } });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const pending = service.status();
      expect(pending.active_background_jobs).toBe(0);
      expect(pending.queued_background_jobs).toBeGreaterThan(0);
      expect(pending.queued_background_jobs).toBe(pending.background_jobs);
      release();
      await search;
      await service.waitForIdle();
      expect((await service.getCatalogRecord('priority', 'queued-document')).body).toBe('Background evidence stays durable.');
    } finally {
      release();
      await service.close();
    }
  });
});

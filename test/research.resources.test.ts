import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchService } from '../src/research/service.js';
import type { ResearchStore } from '../src/research/store.js';
import { applyEmbeddedStorageDefaults, embeddedStorageEnvironment, embeddingBatchSize } from '../src/research/resources.js';

describe('desktop research resource policy', () => {
  it('uses bounded storage defaults and preserves explicit operator settings', () => {
    const env = { SURREAL_ROCKSDB_BLOCK_CACHE_SIZE: '268435456' };
    applyEmbeddedStorageDefaults(env);
    expect(env).toMatchObject({
      SURREAL_HNSW_CACHE_SIZE: '134217728',
      SURREAL_ROCKSDB_BLOCK_CACHE_SIZE: '268435456',
      SURREAL_ROCKSDB_WRITE_BUFFER_SIZE: '33554432',
      SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER: '2',
      SURREAL_ROCKSDB_THREAD_COUNT: '2',
      SURREAL_ROCKSDB_JOBS_COUNT: '2',
    });
    expect(embeddedStorageEnvironment({}).SURREAL_ROCKSDB_BLOCK_CACHE_SIZE).toBe('536870912');
    expect(embeddingBatchSize()).toBe(8);
    expect(embeddingBatchSize(0)).toBe(1);
    expect(embeddingBatchSize(99)).toBe(32);
    expect(embeddingBatchSize(Number.NaN)).toBe(8);
  });

  it('serializes background work and continues after a failed job', async () => {
    const service = new ResearchService({ enabled: false, root: '.' });
    const internal = service as unknown as { schedule: (work: () => Promise<unknown>) => void };
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    internal.schedule(async () => { events.push('first'); await gate; throw new Error('test failure'); });
    internal.schedule(async () => { events.push('second'); });
    await vi.waitFor(() => expect(events).toEqual(['first']));
    release();
    await service.waitForIdle();
    expect(events).toEqual(['first', 'second']);
    await service.close();
  });

  it('does not load code bodies for document indexing or documents for code indexing', async () => {
    const service = new ResearchService({ enabled: false, root: '.' });
    const internal = service as unknown as {
      store: ResearchStore;
      buildRetrievalItems: (projectId: string, family: 'document' | 'code') => Promise<unknown[]>;
    };
    const documents = vi.spyOn(internal.store, 'listProjectDocuments').mockResolvedValue([]);
    const chunks = vi.spyOn(internal.store, 'listProjectDocumentChunks').mockResolvedValue([]);
    const sources = vi.spyOn(internal.store, 'listProjectSourceBodies').mockResolvedValue([]);
    const symbols = vi.spyOn(internal.store, 'listCodeSymbols').mockResolvedValue([]);
    await internal.buildRetrievalItems('sample', 'document');
    expect(documents).toHaveBeenCalledOnce();
    expect(chunks).toHaveBeenCalledOnce();
    expect(sources).not.toHaveBeenCalled();
    expect(symbols).not.toHaveBeenCalled();
    await internal.buildRetrievalItems('sample', 'code');
    expect(documents).toHaveBeenCalledOnce();
    expect(chunks).toHaveBeenCalledOnce();
    expect(sources).toHaveBeenCalledOnce();
    expect(symbols).toHaveBeenCalledOnce();
    await service.close();
  });

  it('coalesces queued captures without dropping documents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-capture-coalesce-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    const internal = service as unknown as {
      store: ResearchStore;
      schedule: (work: () => Promise<unknown>) => void;
      materializeRetrievalIndex: (projectId: string, family: 'document' | 'code') => Promise<unknown>;
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await service.createProject('Coalesced captures', 'coalesced');
      internal.schedule(async () => await gate);
      const materialize = vi.spyOn(internal, 'materializeRetrievalIndex');
      const jobWrites = vi.spyOn(internal.store, 'putKnowledgeJob');
      for (let index = 0; index < 5; index += 1) {
        await service.capture({
          tool: 'extract', project_id: 'coalesced',
          payload: {
            title: `Document ${index}`, url: `https://example.com/coalesced/${index}`,
            content: `Unique evidence ${index}. `.repeat(100), extraction_quality: 'full_text',
          },
        });
      }
      release();
      await service.waitForIdle();
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(await internal.store.listProjectDocuments('coalesced')).toHaveLength(5);
      const jobs = [...new Map(jobWrites.mock.calls.map(([job]) => [job.job_id, job] as const)).values()]
        .filter((job) => job.schema_version === 'capture-index-v1');
      expect(jobs).toHaveLength(5);
      expect(jobs.every((job) => job.status === 'done')).toBe(true);
    } finally {
      release();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

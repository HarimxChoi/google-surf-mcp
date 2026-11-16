import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Table } from 'surrealdb';
import { expect, it, vi } from 'vitest';
import { ResearchStore } from '../src/research/store.js';
import { buildDocumentSourceMap } from '../src/documentSourceMap.js';
import { isTransactionConflict } from '../src/research/errors.js';

const vector = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);

it('shares immutable chunk bodies across exact, vector and BM25 while preserving source maps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-shared-hydration-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    const text = 'needle calibration = 0.73';
    await db.insert(new Table('chunk'), [{ id: new RecordId('chunk', 'c'), document_id: 'd',
      chunk_index: 0, chunk_set_id: 'v1', content_hash: 'h1', text,
      title: 'Needle', url: 'https://example.com/d',
      source_map: buildDocumentSourceMap(text, [{ page: 8, text }], 'a'.repeat(64)) }]);
    await db.insert(new Table('project_document'), [{ id: new RecordId('project_document', 'p_d'),
      project_id: 'p', document_id: 'd', state: 'lexical_active', active_chunk_set_id: 'v1' }]);
    const item = { item_id: 'document:d:0', project_id: 'p', source_family: 'document' as const,
      source_id: 'd', content_hash: 'h1', title: 'Needle', url: 'https://example.com/d', text,
      exact_terms: ['needle'] };
    await store.upsertExactItem(item);
    await store.upsertVectorItem(item, 'fixture', vector);
    const query = vi.spyOn(db, 'query');
    await store.withRetrievalReadContext(async () => {
      const first = await store.searchProjectExact('p', 'needle', 10);
      const second = await store.searchProjectVector('p', 'fixture', vector, 10);
      const third = await store.searchProjectBm25('p', 'needle', 10);
      for (const hits of [first, second, third]) {
        expect(hits.map(row => row.content)).toEqual([text]);
        expect(hits[0].source_map?.pages.map(page => page.page)).toEqual([8]);
      }
    });
    const bodyReads = () => query.mock.calls.filter(([sql]) => String(sql).includes('SELECT document_id, chunk_set_id, chunk_index, text, content_hash, source_map FROM chunk')).length;
    expect(bodyReads()).toBe(1);
    await store.withRetrievalReadContext(() => store.searchProjectExact('p', 'needle', 10));
    expect(bodyReads()).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('rechecks membership and generation after a body has been shared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-shared-generation-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    const membership = new RecordId('project_document', 'p_d');
    await db.insert(new Table('project_document'), [{ id: membership, project_id: 'p', document_id: 'd',
      state: 'lexical_active', active_chunk_set_id: 'v1' }]);
    await db.insert(new Table('chunk'), ['v1', 'v2'].map(set => ({ id: new RecordId('chunk', set),
      document_id: 'd', chunk_index: 0, chunk_set_id: set, content_hash: set, text: `needle ${set}` })));
    const item = (set: string) => ({ item_id: 'document:d:0', project_id: 'p', source_family: 'document' as const,
      source_id: 'd', content_hash: set, title: 'Needle', url: 'https://example.com/d', text: `needle ${set}`, exact_terms: ['needle'] });
    await store.upsertExactItem(item('v1'));
    await store.withRetrievalReadContext(async () => {
      expect((await store.searchProjectExact('p', 'needle', 1))[0].content).toBe('needle v1');
      await db.query('UPDATE $record SET active_chunk_set_id = $set', { record: membership, set: 'v2' }).collect();
      await store.upsertExactItem(item('v2'));
      expect((await store.searchProjectExact('p', 'needle', 1))[0].content).toBe('needle v2');
      await db.query('UPDATE $record SET state = $state', { record: membership, state: 'forgotten' }).collect();
      expect(await store.searchProjectExact('p', 'needle', 1)).toEqual([]);
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('keeps legacy BM25 bodies without content hashes uncached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-shared-legacy-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    const chunk = new RecordId('chunk', 'legacy');
    await db.insert(new Table('project_document'), [{ id: new RecordId('project_document', 'p_d'),
      project_id: 'p', document_id: 'd', state: 'lexical_active' }]);
    await db.insert(new Table('chunk'), [{ id: chunk, document_id: 'd', chunk_index: 0,
      text: 'needle old', title: 'Legacy', url: 'https://example.com/legacy' }]);
    await store.withRetrievalReadContext(async () => {
      expect((await store.searchProjectBm25('p', 'needle', 1))[0].content).toBe('needle old');
      await db.query('UPDATE $record SET text = $text', { record: chunk, text: 'needle replacement' }).collect();
      expect((await store.searchProjectBm25('p', 'needle', 1))[0].content).toBe('needle replacement');
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('shares source bodies but rechecks source membership and hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-shared-source-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    const record = new RecordId('project_source_entry', 'p_entry');
    await db.insert(new Table('project_source_entry'), [{ id: record, entry_id: 'entry',
      project_id: 'p', root: 'fixture', path: 'source.ts', content_hash: 'current',
      active: true, searchable: true }]);
    await db.insert(new Table('source_body'), [{ id: new RecordId('source_body', 'current'),
      content_hash: 'current', text: 'needle shared source' }]);
    const item = { item_id: 'source:entry:0', project_id: 'p', source_family: 'code' as const,
      source_id: 'entry', content_hash: 'current', title: 'Source', url: 'https://example.com/source',
      text: 'needle shared source', exact_terms: ['needle'] };
    await store.upsertExactItem(item);
    await store.upsertVectorItem(item, 'fixture', vector);
    const query = vi.spyOn(db, 'query');
    await store.withRetrievalReadContext(async () => {
      const first = await store.searchProjectExact('p', 'needle', 1);
      const second = await store.searchProjectVector('p', 'fixture', vector, 1);
      expect(first.map(row => row.content)).toEqual(['needle shared source']);
      expect(second.map(row => row.content)).toEqual(['needle shared source']);
      expect(query.mock.calls.filter(([sql]) => String(sql).includes('SELECT content_hash, text FROM $body_records'))).toHaveLength(1);
      await db.update(record).merge({ content_hash: 'changed' })
        .retry({ attempts: 5, retryable: isTransactionConflict });
      expect(await store.searchProjectExact('p', 'needle', 1)).toEqual([]);
      await db.update(record).merge({ content_hash: 'current', active: false })
        .retry({ attempts: 5, retryable: isTransactionConflict });
      expect(await store.searchProjectVector('p', 'fixture', vector, 1)).toEqual([]);
    });
  } finally {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

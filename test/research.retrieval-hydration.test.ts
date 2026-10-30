import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Table } from 'surrealdb';
import { expect, it, vi } from 'vitest';
import { ResearchStore } from '../src/research/store.js';

it('hydrates exact references through indexed document/hash pairs without cross-document matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-retrieval-hydration-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    await db.insert(new Table('chunk'), [
      { id: new RecordId('chunk', 'a'), document_id: 'a', content_hash: 'ha', text: 'first match' },
      { id: new RecordId('chunk', 'b'), document_id: 'b', chunk_set_id: 'active', content_hash: 'hb', text: 'second match' },
      { id: new RecordId('chunk', 'cross-a'), document_id: 'a', content_hash: 'hb', text: 'wrong cross match' },
      { id: new RecordId('chunk', 'cross-b'), document_id: 'b', content_hash: 'ha', text: 'wrong cross match' },
      { id: new RecordId('chunk', 'unrelated'), document_id: 'other', content_hash: 'ha', text: 'unrelated' },
    ]);
    await db.insert(new Table('retrieval_exact'), ['a', 'b'].map((id) => ({
      id: new RecordId('retrieval_exact', id), item_id: `document:${id}:0`,
      project_id: 'p', normalized_term: 'needle', source_family: 'document',
      source_id: id, content_hash: `h${id}`, title: id, url: `https://example.com/${id}`,
    })));
    const query = vi.spyOn(db, 'query');
    const hits = await store.searchProjectExact('p', 'needle', 10);
    expect(hits.map((hit) => hit.content)).toEqual(['first match', 'second match']);
    const hydration = query.mock.calls.find(([sql]) => (
      typeof sql === 'string' && sql.includes('SELECT document_id, text, content_hash FROM chunk')
    ));
    expect(hydration).toBeDefined();
    const [rows] = await db.query(hydration![0] as string, hydration![1]).collect();
    expect(rows).toHaveLength(2);
    const [plan] = await db.query(`${hydration![0]} EXPLAIN`, hydration![1]).collect();
    expect(JSON.stringify(plan)).toContain('chunk_document');
    expect(JSON.stringify(plan)).not.toContain('TableScan');
    expect(await store.searchProjectExact('p', 'missing', 10)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('hydrates code references by primary record IDs and preserves stale-body rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-source-hydration-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    await db.insert(new Table('project_source_entry'), [{
      id: new RecordId('project_source_entry', 'p_entry'), entry_id: 'entry',
      project_id: 'p', root: 'fixture', path: 'source.ts', content_hash: 'current',
      active: true, searchable: true,
    }]);
    await db.insert(new Table('source_body'), [
      { id: new RecordId('source_body', 'current'), content_hash: 'current', text: 'selected source body' },
      { id: new RecordId('source_body', 'other'), content_hash: 'other', text: 'unrelated source body' },
    ]);
    await db.insert(new Table('retrieval_exact'), ['current', 'stale'].map((hash) => ({
      id: new RecordId('retrieval_exact', hash), item_id: `source:entry:${hash}`,
      project_id: 'p', normalized_term: hash, source_family: 'code',
      source_id: 'entry', content_hash: hash, title: 'fixture', url: 'https://example.com/source',
    })));
    const query = vi.spyOn(db, 'query');
    const hits = await store.searchProjectExact('p', 'current', 10);
    expect(hits.map((hit) => hit.content)).toEqual(['selected source body']);
    for (const fragment of ['SELECT entry_id, project_id, root, path', 'SELECT content_hash, text FROM']) {
      const hydration = query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes(fragment));
      expect(hydration).toBeDefined();
      const [plan] = await db.query(`${hydration![0]} EXPLAIN`, hydration![1]).collect();
      expect(JSON.stringify(plan)).not.toContain('TableScan');
    }
    expect(await store.searchProjectExact('p', 'stale', 10)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Table } from 'surrealdb';
import { expect, it } from 'vitest';
import { ResearchStore } from '../src/research/store.js';

it('uses the existing composite index for active and legacy chunk membership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-chunk-query-plan-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    await db.insert(new Table('chunk'), [
      { id: new RecordId('chunk', 'current'), document_id: 'a', chunk_set_id: 'active', text: 'current' },
      { id: new RecordId('chunk', 'old'), document_id: 'a', chunk_set_id: 'old', text: 'old' },
      { id: new RecordId('chunk', 'legacy'), document_id: 'b', text: 'legacy' },
    ]);
    const [broad] = await db.query<unknown[]>(
      'SELECT document_id, chunk_set_id, text FROM chunk WHERE document_id IN $ids EXPLAIN',
      { ids: ['a', 'b'] },
    ).collect();
    expect(JSON.stringify(broad)).toContain('TableScan');
    for (const [documentId, chunkSet] of [['a', 'active'], ['b', undefined]]) {
      const [plan] = await db.query<unknown[]>(
        `SELECT document_id, chunk_set_id, text FROM chunk
         WHERE document_id = $document_id AND chunk_set_id = ${chunkSet ? '$chunk_set_id' : 'NONE'} EXPLAIN`,
        { document_id: documentId, ...(chunkSet ? { chunk_set_id: chunkSet } : {}) },
      ).collect();
      expect(JSON.stringify(plan)).toContain('chunk_document');
      expect(JSON.stringify(plan)).not.toContain('TableScan');
    }
    const [paired] = await db.query<unknown[]>(
      `SELECT document_id, chunk_set_id, text FROM chunk WHERE
       (document_id = $a AND chunk_set_id = $active) OR (document_id = $b AND chunk_set_id = NONE)
       ORDER BY document_id, chunk_set_id EXPLAIN`,
      { a: 'a', active: 'active', b: 'b' },
    ).collect();
    expect(JSON.stringify(paired)).toContain('chunk_document');
    expect(JSON.stringify(paired)).not.toContain('TableScan');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

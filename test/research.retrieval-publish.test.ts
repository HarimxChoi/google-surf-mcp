import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Table } from 'surrealdb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { ResearchStore } from '../src/research/store.js';

describe('bounded catalog chunk reads', () => {
  let root: string;
  let store: ResearchStore;

  afterEach(async () => {
    vi.restoreAllMocks();
    await store?.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'surf-membership-chunks-'));
    store = new ResearchStore(root, 'mem://');
    return await store.open();
  }

  it.each([0, 250, 251])('bounds reads for %i memberships without nested project subqueries', async (count) => {
    const db = await setup();
    const memberships = Array.from({ length: count }, (_, index) => ({
      id: new RecordId('project_document', 'test_' + index),
      document_id: 'document-' + String(index).padStart(4, '0'),
      project_id: 'test', state: 'lexical_active',
    }));
    if (memberships.length) await db.insert(new Table('project_document'), memberships);
    const query = db.query.bind(db);
    const batches: number[] = [];
    const reads: Array<{ sql: string; variables: Record<string, unknown> }> = [];
    vi.spyOn(db, 'query').mockImplementation(((...args: Parameters<typeof db.query>) => {
      const sql = String(args[0]);
      const variables = args[1] as Record<string, unknown> | undefined;
      expect(sql).not.toContain('SELECT VALUE active_chunk_set_id FROM project_document');
      expect(sql).not.toContain('document_id IN');
      if (sql.includes('FROM chunk')) {
        batches.push(Object.keys(variables ?? {}).filter((key) => key.startsWith('document_')).length);
        reads.push({ sql, variables: variables ?? {} });
      }
      return query(...args);
    }) as typeof db.query);
    expect(await store.listProjectDocumentChunks('test')).toEqual([]);
    expect(batches).toHaveLength(Math.ceil(count / 250));
    expect(batches.every((size) => size > 0 && size <= 250)).toBe(true);
    for (const read of reads) {
      const [plan] = await query(read.sql + ' EXPLAIN', read.variables).collect();
      expect(JSON.stringify(plan)).toContain('chunk_document');
      expect(JSON.stringify(plan)).not.toContain('TableScan');
    }
  });

  it('matches each active set to its own document and preserves legacy and other-project originals', async () => {
    const db = await setup();
    const definitions = [
      { document_id: 'a', project_id: 'test', active_chunk_set_id: 'a-active' },
      { document_id: 'b', project_id: 'test', active_chunk_set_id: 'b-active' },
      { document_id: 'c', project_id: 'test' },
      { document_id: 'd', project_id: 'other', active_chunk_set_id: 'd-active' },
    ];
    for (const definition of definitions) {
      await db.upsert(new RecordId('document', definition.document_id)).content({
        document_id: definition.document_id, title: definition.document_id,
        canonical_url: 'surf://fixture/' + definition.document_id,
      });
      await db.upsert(new RecordId('project_document', definition.project_id + '_' + definition.document_id))
        .content({ ...definition, state: 'lexical_active' });
    }
    const chunks = [
      { document_id: 'a', chunk_index: 1, chunk_set_id: 'a-active', text: 'A current' },
      { document_id: 'a', chunk_index: 0, chunk_set_id: 'staged-a', text: 'A staged' },
      { document_id: 'b', chunk_index: 1, chunk_set_id: 'b-active', text: 'B current' },
      { document_id: 'b', chunk_index: 0, chunk_set_id: 'a-active', text: 'B obsolete' },
      { document_id: 'c', chunk_index: 1, text: 'C legacy' },
      { document_id: 'c', chunk_index: 0, chunk_set_id: 'staged-c', text: 'C staged' },
      { document_id: 'd', chunk_index: 0, chunk_set_id: 'd-active', text: 'Other project' },
    ];
    await db.insert(new Table('chunk'), chunks.map((chunk, index) => ({
      id: new RecordId('chunk', 'fixture-' + index), ...chunk,
      title: chunk.document_id, url: 'surf://fixture/' + chunk.document_id, content_hash: chunk.text,
    })));
    expect((await store.listProjectDocumentChunks('test')).map((row) => row.text))
      .toEqual(['A current', 'B current', 'C legacy']);
    expect((await store.listProjectDocuments('test')).map((row) => row.text))
      .toEqual(['A current', 'B current', 'C legacy']);
    const [remaining] = await db.query<[Array<{ count: number }>]>(
      'SELECT count() AS count FROM chunk GROUP ALL',
    ).collect();
    expect(remaining).toEqual([{ count: 7 }]);
  });

  it('filters BM25 hits by each document active set, including legacy members', async () => {
    const db = await setup();
    const definitions = [
      { document_id: 'a', project_id: 'test', active_chunk_set_id: 'a-active' },
      { document_id: 'b', project_id: 'test', active_chunk_set_id: 'b-active' },
      { document_id: 'c', project_id: 'test' },
      { document_id: 'd', project_id: 'other', active_chunk_set_id: 'd-active' },
    ];
    for (const definition of definitions) {
      await db.upsert(new RecordId('document', definition.document_id)).content({
        document_id: definition.document_id, title: definition.document_id,
      });
      await db.upsert(new RecordId('project_document', definition.project_id + '_' + definition.document_id))
        .content({ ...definition, state: 'lexical_active' });
    }
    const chunks = [
      { document_id: 'a', chunk_set_id: 'a-active', text: 'membershipneedle A current' },
      { document_id: 'b', chunk_set_id: 'b-active', text: 'membershipneedle B current' },
      { document_id: 'b', chunk_set_id: 'a-active', text: 'membershipneedle B obsolete' },
      { document_id: 'c', text: 'membershipneedle C legacy' },
      { document_id: 'c', chunk_set_id: 'staged-c', text: 'membershipneedle C staged' },
      { document_id: 'd', chunk_set_id: 'd-active', text: 'membershipneedle other project' },
    ];
    await db.insert(new Table('chunk'), chunks.map((chunk, index) => ({
      id: new RecordId('chunk', 'bm25-' + index), ...chunk, chunk_index: [0, 2, 1, 4, 3, 5][index],
      title: chunk.document_id, url: 'surf://fixture/' + chunk.document_id,
    })));
    const query = db.query.bind(db);
    let search: { sql: string; variables: Record<string, unknown> } | undefined;
    vi.spyOn(db, 'query').mockImplementation(((...args: Parameters<typeof db.query>) => {
      const sql = String(args[0]);
      if (sql.includes('text @0@')) search = { sql, variables: args[1] as Record<string, unknown> };
      return query(...args);
    }) as typeof db.query);
    const hits = await store.searchProjectBm25('test', 'membershipneedle', 10);
    expect(hits.map((hit) => hit.content).sort()).toEqual([
      'membershipneedle A current', 'membershipneedle B current', 'membershipneedle C legacy',
    ]);
    expect(search!.sql).not.toContain('SELECT VALUE active_chunk_set_id');
    const [plan] = await query(search!.sql + ' EXPLAIN', search!.variables).collect();
    expect(JSON.stringify(plan)).toContain('chunk_text');
    expect(JSON.stringify(plan)).not.toContain('TableScan');
    expect(await store.searchProjectBm25('missing', 'membershipneedle', 10)).toEqual([]);
  });

  it('does not read chunk bodies when only retrieval metadata is requested', async () => {
    const db = await setup();
    await db.upsert(new RecordId('document', 'a')).content({ title: 'A', canonical_url: 'surf://a' });
    await db.upsert(new RecordId('project_document', 'test_a')).content({
      document_id: 'a', project_id: 'test', state: 'lexical_active',
    });
    const query = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(((...args: Parameters<typeof db.query>) => {
      expect(String(args[0])).not.toContain('FROM chunk');
      return query(...args);
    }) as typeof db.query);
    expect(await store.listProjectDocuments('test', false)).toEqual([
      { project_id: 'test', document_id: 'a', state: 'lexical_active', title: 'A', url: 'surf://a' },
    ]);
  });
});

it('replays a failed catalog index without changing the committed revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-catalog-replay-'));
  const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
  const failure = vi.spyOn(ResearchStore.prototype, 'commitRetrievalGeneration')
    .mockRejectedValueOnce(new Error('fixture publication timeout'));
  try {
    await service.createProject('Replay', 'replay');
    const input = {
      project_id: 'replay', kind: 'method' as const, operation: 'create' as const,
      asset_id: 'replay-source', idempotency_key: 'replay-source-v1', expected_revision: 0,
      body: 'Preserved recovery evidence', fields: { title: 'Replay source' },
    };
    const original = await service.writeCatalogRecord(input);
    await service.waitForIdle();
    expect((await service.jobStatus('replay', original.index_job_id!)).status).toBe('failed');
    failure.mockRestore();
    const replay = await service.writeCatalogRecord(input);
    await service.waitForIdle();
    expect(replay).toMatchObject({
      revision: 1, operation_id: original.operation_id, applied_this_request: false,
      idempotent_replay: true,
    });
    expect((await service.jobStatus('replay', original.index_job_id!)).status).toBe('done');
    expect(await service.writeCatalogRecord(input)).toMatchObject({ revision: 1, index_state: 'current' });
    const record = await service.getCatalogRecord('replay', 'replay-source');
    expect(record).toMatchObject({ body: input.body, revision: { revision: 1 } });
  } finally {
    failure.mockRestore();
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

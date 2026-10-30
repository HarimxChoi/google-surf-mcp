import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordId, Table } from 'surrealdb';
import { expect, it } from 'vitest';
import { ResearchStore } from '../src/research/store.js';

it('uses the HNSW index with project and embedding-model filters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'surf-vector-query-plan-'));
  const store = new ResearchStore(root, 'mem://');
  try {
    const db = await store.open();
    const embedding = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
    await db.insert(new Table('retrieval_vector'), [{
      id: new RecordId('retrieval_vector', 'fixture'), item_id: 'fixture',
      project_id: 'p', embedding_model: 'm', embedding,
    }]);
    const [plan] = await db.query(
      `SELECT item_id, project_id, vector::distance::knn() AS distance
       FROM retrieval_vector
       WHERE project_id = $project_id AND embedding_model = $embedding_model
         AND embedding <|24, 400|> $embedding
       ORDER BY distance ASC, item_id ASC LIMIT $limit EXPLAIN`,
      { project_id: 'p', embedding_model: 'm', embedding, limit: 24 },
    ).collect();
    console.info(JSON.stringify({ vector_query_plan: plan }));
    expect(JSON.stringify(plan)).toContain('retrieval_vector_embedding');
    expect(JSON.stringify(plan)).not.toContain('TableScan');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

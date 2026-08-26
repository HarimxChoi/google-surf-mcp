import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RESEARCH_VECTOR_MODEL } from '../src/research/dense.js';
import { ResearchService } from '../src/research/service.js';

const root = await mkdtemp(join(tmpdir(), 'surf-vector-smoke-'));
const service = new ResearchService({
  enabled: true,
  root,
  endpoint: 'mem://',
  vectorModel: DEFAULT_RESEARCH_VECTOR_MODEL,
});
try {
  await service.createProject('Vector smoke', 'vector-smoke');
  const started = Date.now();
  await service.capture({
    tool: 'extract',
    project_id: 'vector-smoke',
    payload: {
      title: 'Feline Window Study',
      url: 'https://example.com/feline-window',
      content: 'A feline rests on the windowsill while the room remains quiet. lexicalneedle',
      extraction_quality: 'full_text',
    },
  });
  await service.waitForIdle();
  const indexedMs = Date.now() - started;
  const [exact, bm25, vector] = await Promise.all([
    service.searchFamilies('vector-smoke', 'Feline Window Study', 10),
    service.searchFamilies('vector-smoke', 'lexicalneedle', 10),
    service.searchFamilies('vector-smoke', 'cat sitting near a window', 10),
  ]);
  if (!exact.exact.length || !bm25.bm25.length || !vector.vector.length) {
    throw new Error('exact, BM25, or vector retrieval lane is empty');
  }
  console.log(JSON.stringify({
    model: DEFAULT_RESEARCH_VECTOR_MODEL,
    indexed_ms: indexedMs,
    exact: exact.exact[0].title,
    bm25: bm25.bm25[0].title,
    vector: vector.vector[0].title,
  }));
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(0);

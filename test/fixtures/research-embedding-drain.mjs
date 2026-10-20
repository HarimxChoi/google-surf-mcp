import { ResearchService } from '../../build/research/service.js';

const [mode, root] = process.argv.slice(2);
const batches = [];
let service;
let started;
let release;
const embeddingStarted = new Promise((resolve) => { started = resolve; });
const captureQueued = new Promise((resolve) => { release = resolve; });
const unit = () => [1, ...new Array(383).fill(0)];
const embeddings = {
  enabled: () => true,
  modelId: () => 'drain-test/e5-384',
  dimensions: () => 384,
  embedQuery: async () => unit(),
  embedPassages: async (texts) => {
    batches.push(texts);
    if (mode === 'write') {
      started();
      await captureQueued;
      await service.requestDrain();
    }
    return texts.map(unit);
  },
};

async function main() {
  service = new ResearchService({ enabled: true, root, embeddingProvider: embeddings, vectorBatchSize: 4 });
  try {
    if (mode === 'write') {
      await service.createProject('Checkpoint', 'checkpoint');
      await service.capture({
        tool: 'extract', project_id: 'checkpoint',
        payload: {
          title: 'Checkpoint document', url: 'https://example.com/checkpoint',
          content: Array.from({ length: 12 }, (_, index) => `Section ${index}. ${'research '.repeat(700)}`).join('\n\n'),
          extraction_quality: 'full_text',
        },
      });
      await embeddingStarted;
      await service.createProject('Queued checkpoint', 'queued-checkpoint');
      await service.capture({
        tool: 'extract', project_id: 'queued-checkpoint',
        payload: {
          title: 'Queued document', url: 'https://example.com/queued-checkpoint',
          content: 'Queued research evidence. '.repeat(250), extraction_quality: 'full_text',
        },
      });
      release();
    } else {
      await service.getProject('checkpoint');
    }
    await service.waitForIdle();
    const found = mode === 'read' ? await service.searchFamilies('checkpoint', 'checkpoint', 5) : undefined;
    const queued = mode === 'read' ? await service.searchFamilies('queued-checkpoint', 'queued research', 5) : undefined;
    console.log(JSON.stringify({ batches, vector_hits: found?.vector.length, queued_vector_hits: queued?.vector.length }));
  } finally {
    await service.close();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});

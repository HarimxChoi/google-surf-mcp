import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { projectMemorySearchTool } from '../src/research/tools.js';

const parser = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/documentReader.js', () => ({
  documentParserFingerprint: () => 'source-map-native-pdf-test-v1',
  readBinaryDocument: async (bytes: Uint8Array) => {
    parser.calls++;
    const { extractPdfTiered } = await import('../src/extract-pdf.js');
    return { ...await extractPdfTiered(bytes, 'full', 1_000_000), url: '' };
  },
}));

let root: string, source: string, service: ResearchService;
beforeEach(async () => {
  vi.stubEnv('SURF_EXTRACT_OCR', 'false');
  vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', 'text');
  root = mkdtempSync(join(tmpdir(), 'surf-map-db-'));
  source = mkdtempSync(join(tmpdir(), 'surf-map-source-'));
  parser.calls = 0;
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Table 1: Native voltage\nNative operating voltage is 3.3V.', { x: 40, y: 700, size: 12 });
  pdf.addPage().drawText('Table 2: Override voltage\nGPIO45 high selects 1.8V.', { x: 40, y: 700, size: 12 });
  writeFileSync(join(source, 'voltage.pdf'), await pdf.save());
  service = new ResearchService({ enabled: true, root, endpoint: 'mem://', embeddingProvider: {
    enabled: () => false, dimensions: () => 384, modelId: () => undefined,
    embedQuery: async () => [], embedPassages: async () => [],
  } });
  await service.createProject('Mapped root', 'mapped-root');
});
afterEach(async () => {
  await service.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('native parser source-map root integration', () => {
  it('reuses the source-map ID and inventory digest without a second native parse', async () => {
    const input = { project_id: 'mapped-root', roots: [{ label: 'documents', path: source }] };
    const first = await service.indexProject(input);
    await service.waitForIdle();
    const before = (await service['store'].listProjectSourceEntries('mapped-root'))[0];
    expect(before.source_map_id).toMatch(/^[a-f0-9]{64}$/);
    const second = await service.indexProject(input);
    await service.waitForIdle();
    const after = (await service['store'].listProjectSourceEntries('mapped-root'))[0];
    expect(parser.calls).toBe(1);
    expect(second).toMatchObject({ reused: true, inventory_digest: first.inventory_digest, snapshot_id: first.snapshot_id });
    expect(after.source_map_id).toBe(before.source_map_id);
  });
  it('hydrates BM25, exact and vector spans and exposes only bounded references through the tool', async () => {
    await service.indexProject({ project_id: 'mapped-root', roots: [{ label: 'documents', path: source }] });
    await service.waitForIdle();
    const store = service['store'];
    const [entry] = await store.listProjectSourceEntries('mapped-root');
    const bm25 = await store.searchProjectBm25('mapped-root', 'GPIO45', 5);
    expect(bm25[0]?.source_map?.pages.map(page => page.page)).toEqual([1, 2]);
    const text = bm25[0].content;
    const start = text.indexOf('GPIO45');
    const item = { item_id: 'test-source-span', project_id: 'mapped-root', source_family: 'code' as const,
      source_id: entry.entry_id, title: 'Voltage', url: bm25[0].url, content_hash: entry.content_hash!,
      text: text.slice(start), span_start: start, span_end: text.length, exact_terms: ['mappedvoltage'] };
    await store.upsertExactItem(item);
    const embedding = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
    await store.upsertVectorItem(item, 'unit-vector-test', embedding);
    for (const hits of [await store.searchProjectExact('mapped-root', 'mappedvoltage', 5),
      await store.searchProjectVector('mapped-root', 'unit-vector-test', embedding, 5)]) {
      expect(hits[0]?.source_map?.pages.map(page => page.page)).toEqual([2]);
    }
    const result = await projectMemorySearchTool({ project_id: 'mapped-root', query: 'GPIO45', limit: 5,
      filters: { retrieval_lanes: ['bm25'] } }, service);
    expect(JSON.stringify(result)).not.toContain('source_map');
    const rows = result.structuredContent?.results as Array<Record<string, unknown>>;
    expect(rows[0]?.source_refs).toMatchObject({ pages: [2] });
  });
});

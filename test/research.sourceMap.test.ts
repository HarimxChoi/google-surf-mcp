import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { buildDocumentSourceMap } from '../src/documentSourceMap.js';
import { compactRankedResults } from '../src/research/integration.js';

let root: string, service: ResearchService;
const first = '한글 원문 첫째 페이지\nTable 1: Native constraints\n3.3V without override.';
const second = '둘째 페이지\nFigure 2: Voltage table\n1.8V with override.';
const content = '  ' + first + '\n\n' + second + '\n';
const url = 'https://example.org/mapped.pdf';
const source_map = buildDocumentSourceMap(content, [{ page: 1, text: first }, { page: 2, text: second, ocr: true }], 'a'.repeat(64));
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'surf-source-map-'));
  service = new ResearchService({ enabled: true, root, endpoint: 'mem://', embeddingProvider: {
    enabled: () => false, dimensions: () => 384, modelId: () => undefined,
    embedQuery: async () => [], embedPassages: async () => [],
  } });
  await service.createProject('Mapped sources', 'maps');
});
afterEach(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });

async function readDocument() {
  const [document] = await service['store'].listProjectDocuments('maps', false);
  const result = await service.getCatalogRecord('maps', document.document_id, undefined, 0, 1_000_000);
  if (!('document' in result)) throw new Error('Expected document readback');
  return result;
}

describe('durable source map receipts', () => {
  it('keeps a linked note available after capture, BM25 hydration and ranked compaction', async () => {
    const main = 'Temperature was 1.09 [0.95 to 1.20] C5 in 2011-2020.';
    const note = '5  Ranges represent very likely intervals unless otherwise stated.';
    const body = main + '\n\n' + 'Temperature in 2011-2020 was compared to the earlier baseline.\n\n'.repeat(24) + note;
    const map = buildDocumentSourceMap(body, [{ page: 7, text: body }], 'b'.repeat(64));
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'Assessment', url,
      content: body, source_map: map, extraction_quality: 'full_text' } });
    const hits = await service['store'].searchProjectBm25('maps', 'Temperature 1.09', 5);
    expect(hits[0]?.source_map?.source_sha256).toBe('b'.repeat(64));
    const [row] = compactRankedResults('Temperature 1.09 0.95 1.20 2011-2020', hits.map(hit => ({ ...hit })));
    expect(row.description).toContain(main);
    expect(row.description).toContain(note);
    expect(row.source_refs).toMatchObject({ pages: [7] });
    expect(row.source_map).toBeUndefined();
    expect(String(row.description).length + JSON.stringify(row.source_refs).length).toBeLessThanOrEqual(1200);
  });
  it('preserves source identity through title prefixing and UTF-8 paged reads', async () => {
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'Mapped PDF', url,
      content, source_map, extraction_quality: 'full_text' } });
    const read = await readDocument();
    expect(read.source_refs?.pages).toEqual([1, 2]);
    expect(read.source_refs?.ocr_pages).toEqual([2]);
    expect(read).not.toHaveProperty('source_map');
    const start = read.body!.indexOf('1.8V');
    const offset = Buffer.byteLength(read.body!.slice(0, start), 'utf8');
    const page = await service.getCatalogRecord('maps', read.record.document_id, undefined, offset, 12);
    expect(page.body).toContain('1.8V');
    expect('source_refs' in page && page.source_refs?.pages).toEqual([2]);
    const metadata = await service.getCatalogRecord('maps', read.record.document_id, undefined, 0, 0);
    expect(metadata).not.toHaveProperty('source_refs');
  });
  it('does not attach an earlier map to replacement content without provenance', async () => {
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'Mapped PDF', url,
      content, source_map, extraction_quality: 'full_text' } });
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'New version', url,
      content: 'A new unlocated source body.', extraction_quality: 'full_text' } });
    expect((await readDocument()).source_refs).toBeUndefined();
  });
  it('rejects a map whose content hash does not match the captured body', async () => {
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'Unmatched', url,
      content: 'Different content', source_map, extraction_quality: 'full_text' } });
    expect((await readDocument()).source_refs).toBeUndefined();
  });
  it('returns page references from captured chunks in BM25 and exact retrieval', async () => {
    await service.capture({ tool: 'extract', project_id: 'maps', payload: { title: 'Mapped PDF', url,
      content, source_map, extraction_quality: 'full_text' } });
    const store = service['store'];
    const bm25 = await store.searchProjectBm25('maps', 'override', 5);
    expect(bm25[0]?.source_map?.source_sha256).toBe('a'.repeat(64));
    expect(bm25[0]?.source_map?.pages.map(page => page.page)).toEqual([1, 2]);
    const chunks = await store.listProjectDocumentChunks('maps');
    await store.upsertExactItem({ item_id: `document:${chunks[0].document_id}:${chunks[0].chunk_index}`, project_id: 'maps',
      source_family: 'document', source_id: chunks[0].document_id, title: 'Mapped PDF', url,
      content_hash: chunks[0].content_hash, text: chunks[0].text, exact_terms: ['mapped'] });
    const exact = await store.searchProjectExact('maps', 'mapped', 5);
    expect(exact[0]?.source_map?.pages.map(page => page.page)).toEqual([1, 2]);
  });
});

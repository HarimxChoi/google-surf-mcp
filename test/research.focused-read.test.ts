import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentSourceMap } from '../src/documentSourceMap.js';
import { ResearchService } from '../src/research/service.js';
import { compactRankedResults } from '../src/research/integration.js';
import { projectMemoryTool } from '../src/research/tools.js';
import { RESEARCH_BROKER_METHODS, RESEARCH_BROKER_READ_METHODS } from '../src/research/broker.js';

const parser = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/documentReader.js', () => ({ documentParserFingerprint: () => 'focused-read-v1', readBinaryDocument: parser.read }));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const main = 'Temperature was 1.09 C5 in 2011-2020.';
const note = '5  Ranges represent very likely intervals unless otherwise stated.';
const content = main + '\n\n' + 'An unrelated section describes other observations.\n\n'.repeat(150) + note;
const query = 'Temperature 1.09 2011-2020';
const url = 'https://example.org/focused.pdf';
let root: string, source: string, service: ResearchService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'surf-focused-db-'));
  source = mkdtempSync(join(tmpdir(), 'surf-focused-source-'));
  service = new ResearchService({ enabled: true, root, endpoint: 'mem://', embeddingProvider: {
    enabled: () => false, dimensions: () => 384, modelId: () => undefined,
    embedQuery: async () => [], embedPassages: async () => [],
  } });
  await service.createProject('Focused reads', 'focus');
});
afterEach(async () => {
  await service.close();
  rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true });
});

async function capture() {
  const source_map = buildDocumentSourceMap(content, [{ page: 7, text: content }], 'a'.repeat(64));
  await service.capture({ tool: 'extract', project_id: 'focus', payload: {
    title: 'Assessment', url, content, source_map, extraction_quality: 'full_text' } });
  return (await service['store'].listProjectDocuments('focus', false))[0].document_id;
}

describe('focused reads of stored evidence', () => {
  it('reads a linked note beyond the retrieved chunk without dumping the document', async () => {
    const id = await capture();
    const hits = await service['store'].searchProjectBm25('focus', query, 1);
    const [first] = compactRankedResults(query, hits.map(hit => ({ ...hit })));
    expect(first.description).not.toContain(note);
    const response = await projectMemoryTool({ action: 'get', project_id: 'focus', record_id: id, query }, service);
    expect(response.isError).not.toBe(true);
    const record = response.structuredContent!.record;
    expect(record).toMatchObject({ focused: true, source_kind: 'document', record_id: id, capture_truncated: false });
    expect(record.content).toContain(main); expect(record.content).toContain(note);
    expect(record.captured_length).toBeGreaterThan(4_000);
    expect(record.content.length + JSON.stringify(record.source_refs).length).toBeLessThanOrEqual(1200);
    const start = record.content.indexOf('Ranges represent');
    expect(record.source_refs.excerpt_pages.some(([from, to, page]: number[]) => from <= start && to >= start + 16 && page === 7)).toBe(true);
    expect(JSON.stringify(response)).not.toContain('"source_map"');
    const raw = await service.getCatalogRecord('focus', id, undefined, 0, 1_000_000);
    expect(raw.body).toContain(note); expect(raw).not.toHaveProperty('focused');
  });

  it('uses the same focused read for an approved native source root', async () => {
    const bytes = 'original native PDF bytes';
    writeFileSync(join(source, 'assessment.pdf'), bytes);
    parser.read.mockResolvedValue({ content, source_map: buildDocumentSourceMap(content, [{ page: 7, text: content }], sha(bytes)),
      extraction_quality: 'full_text', url: '' });
    await service.indexProject({ project_id: 'focus', roots: [{ label: 'documents', path: source }] });
    await service.waitForIdle();
    const [entry] = await service['store'].listProjectSourceEntries('focus');
    const record = await service.readProjectEvidence('focus', entry.entry_id, query);
    expect(record.source_kind).toBe('source'); expect(record.content).toContain(note);
    expect(record.source_refs?.pages).toContain(7);
    expect(record.content.length + JSON.stringify(record.source_refs).length).toBeLessThanOrEqual(1200);
  });

  it.each([1, 2, 64])('keeps page coordinates aligned when removing %i untrusted-content wrappers', async depth => {
    const first = 'Unrelated introduction.', target = 'Target calibration is 0.73.';
    const wrapped = '--- BEGIN UNTRUSTED CONTENT ---\n'.repeat(depth)
      + `${first}\n\n${target}` + '\n--- END UNTRUSTED CONTENT ---'.repeat(depth);
    const boundary = wrapped.indexOf(target), bytes = 'wrapped native PDF bytes';
    writeFileSync(join(source, 'wrapped.pdf'), bytes);
    parser.read.mockResolvedValue({ content: wrapped, extraction_quality: 'full_text', url: '',
      source_map: buildDocumentSourceMap(wrapped, [{ page: 1, text: wrapped.slice(0, boundary - 2) },
        { page: 2, text: wrapped.slice(boundary) }], sha(bytes)) });
    await service.indexProject({ project_id: 'focus', roots: [{ label: 'documents', path: source }] });
    await service.waitForIdle();
    const [entry] = await service['store'].listProjectSourceEntries('focus');
    const record = await service.readProjectEvidence('focus', entry.entry_id, 'Target calibration');
    expect(record.content).toContain(target);
    expect(record.content).not.toContain('UNTRUSTED');
    const offset = record.content.indexOf(target);
    expect(record.source_refs?.excerpt_pages?.filter(([from, to]) => from <= offset && to >= offset + target.length)
      .map(([, , page]) => page)).toEqual([2]);
    const clean = `${first}\n\n${target}`;
    expect(record.captured_hash).toBe(sha(clean));
    for (const [start, end] of record.evidence_ranges) expect(clean.slice(start, end)).not.toContain('UNTRUSTED');
  });

  it('preserves project-specific maps and bodies when another project captures the same URL', async () => {
    const id = await capture();
    await service.waitForIdle();
    const before = await service.readProjectEvidence('focus', id, query);
    await service.createProject('Other', 'other');
    await service.capture({ tool: 'extract', project_id: 'other', payload: { title: 'Assessment', url, content,
      source_map: buildDocumentSourceMap(content, [{ page: 9, text: content }], 'b'.repeat(64)), extraction_quality: 'full_text' } });
    await service.waitForIdle();
    const other = await service.readProjectEvidence('other', id, query);
    expect(other.source_refs?.pages).toEqual([9]);
    expect(await service.readProjectEvidence('focus', id, query)).toEqual(before);
    for (const [projectId, page] of [['focus', 7], ['other', 9]] as const) {
      const hits = await service['store'].searchProjectExact(projectId, 'assessment', 1);
      expect(hits).toHaveLength(1);
      const [ranked] = compactRankedResults(query, hits.map(hit => ({ ...hit })));
      expect((ranked.source_refs as { pages: number[] }).pages).toEqual([page]);
    }
    const raw = await service.getCatalogRecord('focus', id, undefined, 0, 1_000_000);
    expect(raw.source_refs?.pages).toEqual([7]);
    const hits = await service['store'].searchProjectBm25('focus', query, 1);
    const [ranked] = compactRankedResults(query, hits.map(hit => ({ ...hit })));
    expect((ranked.source_refs as { pages: number[] }).pages).toEqual([7]);
    await service.capture({ tool: 'extract', project_id: 'other', payload: { title: 'Replacement', url,
      content: 'Replacement calibration is 2.0 C.', extraction_quality: 'full_text' } });
    await service.waitForIdle();
    expect(await service.readProjectEvidence('focus', id, query)).toEqual(before);
    expect((await service.getCatalogRecord('focus', id, undefined, 0, 1_000_000)).body).toBe('Assessment\n' + content);
    expect((await service.readProjectEvidence('other', id, 'Replacement calibration')).content).toContain('2.0 C');
  });

  it('uses actual wrapper offsets when the whole body also appears inside the marker', async () => {
    const open = '--- BEGIN UNTRUSTED CONTENT ---\n', close = '\n--- END UNTRUSTED CONTENT ---', body = 'CONTENT';
    const wrapped = open + body + close, bytes = 'short wrapped PDF bytes';
    writeFileSync(join(source, 'marker.pdf'), bytes);
    parser.read.mockResolvedValue({ content: wrapped, extraction_quality: 'full_text', url: '',
      source_map: buildDocumentSourceMap(wrapped, [{ page: 1, text: open.trimEnd() },
        { page: 2, text: body + close }], sha(bytes)) });
    await service.indexProject({ project_id: 'focus', roots: [{ label: 'documents', path: source }] });
    await service.waitForIdle();
    const [entry] = await service['store'].listProjectSourceEntries('focus');
    const record = await service.readProjectEvidence('focus', entry.entry_id, body);
    expect(record.content).toBe(body);
    expect(record.source_refs?.pages).toEqual([2]);
    expect(record.source_refs?.excerpt_pages).toEqual([[0, body.length, 2]]);
  });

  it('does not delete another capture staged before an intervening publish', async () => {
    const id = await capture();
    await service.waitForIdle();
    await service.createProject('Other', 'other');
    const staged = 'Staged calibration is 0.81.', hash = sha(staged);
    await service['store'].stageDocumentChunks([{ chunk_id: `${id}_staged`, document_id: id, chunk_set_id: hash,
      chunk_index: 0, text: staged, title: 'Staged', url, content_hash: hash }]);
    await service.capture({ tool: 'extract', project_id: 'focus', payload: { title: 'Replacement', url,
      content: 'Replacement calibration is 2.0 C.', extraction_quality: 'full_text' } });
    await service['store'].publishDocumentChunkSet({ document_id: id, title: 'Staged', canonical_url: url, content_hash: hash },
      { project_id: 'other', document_id: id, state: 'lexical_active' }, hash);
    expect((await service.readProjectEvidence('other', id, 'Staged calibration')).content).toBe(staged);
    expect((await service.readProjectEvidence('focus', id, 'Replacement calibration')).content).toContain('2.0 C');
  });

  it('rejects cross-project records, empty queries and raw paging mixed with focused reads', async () => {
    const id = await capture();
    await service.createProject('Other', 'other');
    await expect(service.readProjectEvidence('other', id, query)).rejects.toThrow('not found');
    await expect(service.readProjectEvidence('focus', id, ' ')).rejects.toThrow();
    const result = await projectMemoryTool({ action: 'get', project_id: 'focus', record_id: id, query, body_bytes: 0 }, service);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('omit');
    await expect(service.readProjectEvidence('focus', id, query, 99)).rejects.toThrow('revision not found');
  });

  it('does not use a stale map on replacement content', async () => {
    const id = await capture();
    await service.capture({ tool: 'extract', project_id: 'focus', payload: {
      title: 'Replacement', url, content: 'A replacement measurement is 2.0 C.', extraction_quality: 'full_text' } });
    const record = await service.readProjectEvidence('focus', id, 'replacement measurement');
    expect(record.content).toContain('2.0 C'); expect(record.content).not.toContain(note);
    expect(record.source_refs).toBeUndefined();
  });

  it('honors catalog revisions and reports a bounded capture window', async () => {
    await service.writeCatalogRecord({ project_id: 'focus', kind: 'document', operation: 'create',
      asset_id: 'catalog-source', expected_revision: 0, idempotency_key: 'source-v1',
      body: 'The first measurement is 1.09 C.', fields: { title: 'Typed source' } });
    await service.writeCatalogRecord({ project_id: 'focus', kind: 'document', operation: 'patch',
      asset_id: 'catalog-source', expected_revision: 1, idempotency_key: 'source-v2',
      body: 'x'.repeat(1024 * 1024) + '\nTAIL_MEASUREMENT 2.0 C.', fields: { title: 'Large typed source' } });
    const first = await service.readProjectEvidence('focus', 'catalog-source', 'first measurement', 1);
    expect(first).toMatchObject({ source_kind: 'catalog', revision: 1, capture_truncated: false });
    expect(first.content).toContain('1.09 C');
    const current = await service.readProjectEvidence('focus', 'catalog-source', 'TAIL_MEASUREMENT');
    expect(current.capture_truncated).toBe(true);
    expect(current.total_bytes).toBeGreaterThan(1024 * 1024);
    expect(current.content).not.toContain('TAIL_MEASUREMENT');
    expect(current.content.length).toBeLessThanOrEqual(1200);
    await service.waitForIdle();
  });

  it('selects legacy plan evidence without echoing the full record', async () => {
    const plan = await service.createPlan({ project_id: 'focus', title: 'Legacy plan',
      body: 'Preserve the baseline.\n\nTarget calibration value is 0.73.\n\n' + 'Other context. '.repeat(500) }, false);
    const record = await service.readProjectEvidence('focus', plan.plan_revision_id, 'Target calibration value');
    expect(record.source_kind).toBe('legacy'); expect(record.content).toContain('0.73');
    expect(record.content.length).toBeLessThanOrEqual(1200);
    expect(record).not.toHaveProperty('record');
  });

  it('keeps empty metadata-only documents empty rather than manufacturing a body', async () => {
    await service.capture({ tool: 'extract', project_id: 'focus', payload: {
      title: 'Metadata', url, extraction_quality: 'metadata_only' } });
    const [document] = await service['store'].listProjectDocuments('focus', false);
    const record = await service.readProjectEvidence('focus', document.document_id, 'measurement');
    expect(record.content).toBe(''); expect(record.total_bytes).toBe(0);
    expect(record.source_refs).toBeUndefined();
  });

  it('round-trips a Unicode character across a nominal document-chunk boundary', async () => {
    const body = 'x'.repeat(3997) + '\ud83d\ude00\nTarget calibration is 0.73.';
    const receipt = await service.capture({ tool: 'extract', project_id: 'focus', payload: {
      title: 'U', url, content: body, extraction_quality: 'full_text' } });
    expect(receipt.stored).toBe(1);
    const [document] = await service['store'].listProjectDocuments('focus', false);
    const record = await service.readProjectEvidence('focus', document.document_id, 'Target calibration');
    expect(record.content).toContain('0.73');
    const raw = await service.getCatalogRecord('focus', document.document_id, undefined, 0, 100_000);
    expect(raw.body).toBe('U\n' + body);
  });

  it('exposes the focused read as read-only and rejects an ambiguous batch query', async () => {
    expect(RESEARCH_BROKER_METHODS.has('readProjectEvidence')).toBe(true);
    expect(RESEARCH_BROKER_READ_METHODS.has('readProjectEvidence')).toBe(true);
    const result = await projectMemoryTool({ action: 'get_batch', project_id: 'focus', record_ids: ['unknown'], query }, service);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('action=get');
    expect(result.structuredContent?.records).toBeUndefined();
  });
});

import { createHash } from 'node:crypto';
import * as CFB from 'cfb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectDocumentArchive } from '../src/documentArchive.js';
import { readDocumentCatalog } from '../src/documentCatalog.js';
import { boundDocumentCatalog } from '../src/documentCatalogBudget.js';
import { parseNativeDocument } from '../src/documentParse.js';
import { shapeExtractionResponse } from '../src/agent.js';
import { formatToolResponse } from '../src/response.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function archive(entries: Record<string, string | Buffer>): Buffer {
  const container = CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(entries)) CFB.utils.cfb_add(container, name, Buffer.from(text));
  return Buffer.from(CFB.write(container, { type: 'buffer', fileType: 'zip', compression: true }));
}
const relations = (rows: Array<[string, string, string, string?]>): string => `<Relationships xmlns="${PKG}">${rows.map(([id, type, target, mode]) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;
const note = (placeholder: string, text = ''): string => `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp>
  <p:nvSpPr><p:nvPr><p:ph ${placeholder}/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
  </p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
  <p:txBody><a:p><a:fld><a:t>12</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
function presentation(): Record<string, string> {
  return {
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>
      <p:sldId id="256" r:id="r1"/><p:sldId id="257" r:id="r2"/><p:sldId id="258" r:id="r3"/></p:sldIdLst>
      <p:extLst><p:ext uri="sections"><sectionLst xmlns="${P14}"><section id="s1" name="Methods"><sldIdLst>
      <sldId id="256"/><sldId id="258"/></sldIdLst></section></sectionLst></p:ext></p:extLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relations([['r1', 'slide', 'slides/slide2.xml'], ['r2', 'slide', 'slides/slide1.xml'], ['r3', 'slide', 'slides/slide3.xml']]),
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${P}"/>`,
    'ppt/slides/slide2.xml': `<p:sld xmlns:p="${P}" show="0"/>`,
    'ppt/slides/slide3.xml': `<p:sld xmlns:p="${P}" show="false"/>`,
    'ppt/slides/_rels/slide1.xml.rels': relations([['n1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/slides/_rels/slide2.xml.rels': relations([['n2', 'notesSlide', '../notesSlides/notesSlide2.xml']]),
    'ppt/slides/_rels/slide3.xml.rels': relations([['n3', 'notesSlide', '../notesSlides/notesSlide3.xml']]),
    'ppt/notesSlides/notesSlide1.xml': note('idx="1"', 'A &amp; B'),
    'ppt/notesSlides/notesSlide2.xml': note('type="body"'),
    'ppt/notesSlides/notesSlide3.xml': note('type="body"', '   '),
    'ppt/notesSlides/_rels/notesSlide1.xml.rels': relations([['m', 'notesMaster', '../notesMasters/notesMaster1.xml']]),
    'ppt/notesMasters/notesMaster1.xml': `<p:notesMaster xmlns:p="${P}"><p:cSld><p:spTree><p:sp>
      <p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:notesMaster>`,
    'docProps/app.xml': '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Notes>3</Notes><Company>Cedar</Company></Properties>',
  };
}
afterEach(() => vi.restoreAllMocks());

describe('source-wide native document catalogs', () => {
  it('reads DOCX producer properties and source hashes without treating producer pages as rendered pages', async () => {
    const props = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Cedar</dc:title><dc:creator>Kim</dc:creator></cp:coreProperties>';
    const bytes = archive({ 'word/document.xml': '<not-the-body-parser/>', 'docProps/core.xml': props,
      'docProps/app.xml': '<Properties><Pages>219</Pages></Properties>' });
    const result = await parseNativeDocument(bytes, 'metadata', 6000);
    expect(result.content).toBeUndefined(); expect(result.page_count).toBeUndefined();
    expect(result.document_catalog).toMatchObject({ format: 'docx', source_sha256: hash(bytes), details_truncated: false });
    expect(result.document_catalog?.producer_properties).toContainEqual({ part: 'docProps/app.xml', name: 'Pages', value: '219' });
    expect(result.document_catalog?.source_parts).toContainEqual({ part: 'docProps/core.xml', sha256: hash(props) });
    expect(result.document_catalog?.source_parts.some(row => row.part === 'word/document.xml')).toBe(false);
  });
  it('distinguishes producer notes, notes relationships and nonempty body text in presentation order', async () => {
    const { catalog } = await readDocumentCatalog(archive(presentation()), 6000);
    expect(catalog?.presentation).toMatchObject({ slide_count: 3, slide_parts_complete: true,
      hidden_slide_count: 2, hidden_slide_indexes: [1, 3], notes_relationship_slide_count: 3,
      notes_relationship_slide_indexes: [1, 2, 3], nonempty_note_slide_count: 1,
      nonempty_note_slide_indexes: [2], note_body_scope_complete: true,
      sections: [{ name: 'Methods', slide_indexes: [1, 3] }] });
    expect(catalog?.producer_properties).toContainEqual({ part: 'docProps/app.xml', name: 'Notes', value: '3' });
  });
  it('does not infer a body role from a missing master index', async () => {
    const entries = presentation(); entries['ppt/notesSlides/notesSlide1.xml'] = note('', 'Unclassified memo');
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ nonempty_note_slide_count: 0, note_body_scope_complete: false });
  });
  it.each(['missing', 'external'])('keeps %s note targets unknown without fetching them', async kind => {
    const entries = presentation();
    entries['ppt/slides/_rels/slide1.xml.rels'] = relations([['n', 'notesSlide', kind === 'external'
      ? 'https://example.com/notes.xml' : '../notesSlides/missing.xml', kind === 'external' ? 'External' : undefined]]);
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ notes_relationship_slide_count: 3, note_body_scope_complete: false });
    expect(catalog?.source_parts.some(row => row.part.startsWith('https:'))).toBe(false);
  });
  it('marks unresolved slide parts instead of treating missing slides as visible or empty notes', async () => {
    const entries = presentation(); delete entries['ppt/slides/slide3.xml'];
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ slide_count: 3, slide_parts_complete: false,
      hidden_slide_count: 1, unresolved_slide_indexes: [3], note_body_scope_complete: false });
  });
  it('does not interpret lookalike namespace placeholders as a notes-body role', async () => {
    const entries = presentation();
    entries['ppt/notesSlides/notesSlide1.xml'] = note('type="body"', 'Memo').replaceAll('p:ph', 'fake:ph').replace('<p:notes ', '<p:notes xmlns:fake="urn:untrusted" ');
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ nonempty_note_slide_count: 0, note_body_scope_complete: false });
  });
  it('does not treat an invalid relationship namespace as proof of no notes', async () => {
    const entries = presentation();
    entries['ppt/slides/_rels/slide1.xml.rels'] = entries['ppt/slides/_rels/slide1.xml.rels'].replace(PKG, 'urn:untrusted');
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation?.note_body_scope_complete).toBe(false);
  });
  it('does not recognize a custom relationship merely because its type ends with notesSlide', async () => {
    const entries = presentation();
    entries['ppt/slides/_rels/slide1.xml.rels'] = entries['ppt/slides/_rels/slide1.xml.rels'].replace(`${R}/notesSlide`, 'urn:custom/notesSlide');
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ notes_relationship_slide_count: 2, nonempty_note_slide_count: 0 });
  });
  it('does not count a notes master as a notes slide even when a relation points to it', async () => {
    const entries = presentation();
    entries['ppt/slides/_rels/slide1.xml.rels'] = relations([['n', 'notesSlide', '../notesMasters/notesMaster1.xml']]);
    entries['ppt/notesMasters/notesMaster1.xml'] = entries['ppt/notesMasters/notesMaster1.xml']
      .replace('</p:sp>', `<p:txBody xmlns:a="${A}"><a:p><a:r><a:t>Not a slide note</a:t></a:r></a:p></p:txBody></p:sp>`);
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation).toMatchObject({ nonempty_note_slide_count: 0, note_body_scope_complete: false });
  });
  it.each(['utf-16le', 'utf-16be'])('decodes %s XML while retaining original part hashes', async encoding => {
    const entries: Record<string, string | Buffer> = presentation();
    const raw = Buffer.from('\ufeff' + entries['ppt/presentation.xml'], 'utf16le');
    if (encoding === 'utf-16be') raw.swap16();
    entries['ppt/presentation.xml'] = raw;
    const { catalog } = await readDocumentCatalog(archive(entries), 6000);
    expect(catalog?.presentation?.slide_count).toBe(3);
    expect(catalog?.source_parts).toContainEqual({ part: 'ppt/presentation.xml', sha256: hash(raw) });
  });
  it('rejects unsupported presentation roots rather than returning a misleading zero count', async () => {
    const entries = presentation(); entries['ppt/presentation.xml'] = '<presentation xmlns="urn:untrusted"/>';
    await expect(readDocumentCatalog(archive(entries), 6000)).rejects.toThrow('unsupported root or namespace');
  });
  it.each(['<!DOCTYPE Properties [<!ENTITY x "secret">]><Properties><Company>&x;</Company></Properties>', '<Properties><Company>bad</Properties>'])
  ('rejects unsafe or malformed selected XML', async props => {
    await expect(readDocumentCatalog(archive({ 'word/document.xml': '<w/>', 'docProps/app.xml': props }), 6000)).rejects.toThrow();
  });
  it('rejects invalid UTF-8 rather than silently replacing source characters', async () => {
    const props = Buffer.concat([Buffer.from('<Properties><Company>'), Buffer.from([0xff]), Buffer.from('</Company></Properties>')]);
    await expect(readDocumentCatalog(archive({ 'word/document.xml': '<w/>', 'docProps/app.xml': props }), 6000)).rejects.toThrow();
  });
  it('skips unused media decompression but retains declared archive-size checks', async () => {
    const bytes = archive({ 'word/document.xml': '<w/>', 'docProps/app.xml': '<Properties><Pages>2</Pages></Properties>',
      'word/media/unused.bin': Buffer.alloc(1024 * 1024, 65) });
    const name = Buffer.from('word/media/unused.bin'), offset = bytes.indexOf(name), header = offset - 30;
    expect(bytes.readUInt32LE(header)).toBe(0x04034b50);
    const start = offset + name.length + bytes.readUInt16LE(header + 28);
    bytes.fill(0xff, start, start + 16);
    expect((await readDocumentCatalog(bytes, 6000)).catalog?.format).toBe('docx');
    await expect(inspectDocumentArchive(bytes)).rejects.toThrow();
    const oversized = archive({ 'word/document.xml': '<w/>', 'word/media/unused.bin': Buffer.alloc(65 * 1024 * 1024) });
    await expect(readDocumentCatalog(oversized, 6000)).rejects.toThrow('64 MiB');
  });
  it('rejects duplicate ZIP parts even when the duplicate is not selected', async () => {
    const bytes = archive({ 'word/document.xml': '<w/>', 'spare.bin': 'a', 'other.bin': 'b' });
    for (let offset = bytes.indexOf('other.bin'); offset >= 0; offset = bytes.indexOf('other.bin', offset + 9)) bytes.write('spare.bin', offset);
    await expect(readDocumentCatalog(bytes, 6000)).rejects.toThrow('duplicate');
  });
  it('omits catalogs that cannot fit and preserves counts when lists or properties are shortened', async () => {
    const entries = presentation();
    entries['docProps/custom.xml'] = `<Properties>${Array.from({ length: 80 }, (_, i) => `<Field${i}>${'x'.repeat(100)}</Field${i}>`).join('')}</Properties>`;
    const bytes = archive(entries), full = await readDocumentCatalog(bytes, 6000);
    expect(full.catalog?.details_truncated).toBe(true);
    expect(JSON.stringify(full.catalog).length).toBeLessThanOrEqual(6000);
    expect(full.catalog?.presentation?.nonempty_note_slide_count).toBe(1);
    for (const budget of [0, 100]) {
      const result = await readDocumentCatalog(bytes, budget);
      expect(result.catalog).toBeUndefined(); expect(result.catalogTruncated).toBe(true);
    }
    const bounded = boundDocumentCatalog(full.catalog!, 1200);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1200);
    expect(bounded?.presentation?.slide_count).toBe(3);
  });
  it('reapplies the current metadata response budget to an earlier larger capture', async () => {
    const { catalog } = await readDocumentCatalog(archive(presentation()), 6000);
    const result = formatToolResponse({ url: 'https://example.org/deck.pptx', document_catalog: catalog });
    const small = shapeExtractionResponse(result, { response_content: 'full', max_chars: 1000 }, 'full');
    expect(JSON.stringify(small.structuredContent?.document_catalog).length).toBeLessThanOrEqual(1000);
    expect(small.structuredContent?.truncated).toBe(true);
    const summary = shapeExtractionResponse(result, { response_content: 'summary' }, 'full');
    expect(JSON.stringify(summary.structuredContent?.document_catalog).length).toBeLessThanOrEqual(1500);
    const minimal = shapeExtractionResponse(result, { max_chars: 200 }, 'full');
    expect(minimal.structuredContent?.document_catalog).toBeUndefined();
    expect(minimal.structuredContent?.truncated).toBe(true);
  });
  it.each(['', 'body text'])('bounds catalog and body together when content is %j', async content => {
    const { catalog } = await readDocumentCatalog(archive(presentation()), 6000);
    const shaped = shapeExtractionResponse(formatToolResponse({ url: 'https://example.org/deck.pptx', document_catalog: catalog, content }),
      { response_content: 'full', max_chars: 1000 }, 'full');
    const data = shaped.structuredContent!;
    expect((data.document_catalog ? JSON.stringify(data.document_catalog).length : 0) + String(data.content ?? '').length).toBeLessThanOrEqual(1000);
    expect(data.truncated).toBe(true);
  });
  it.each(['summary', 'full'] as const)('does not leak metadata-only catalogs into %s search result fields', async response_content => {
    const { catalog } = await readDocumentCatalog(archive(presentation()), 6000);
    const result = shapeExtractionResponse(formatToolResponse({ results: [{ title: 'Deck', url: 'https://example.org/deck.pptx',
      content: 'source body', description: 'result', document_catalog: catalog }] }), { response_content }, 'summary');
    const rows = result.structuredContent?.results as Array<Record<string, unknown>>;
    expect(rows[0].document_catalog).toBeUndefined();
  });
});

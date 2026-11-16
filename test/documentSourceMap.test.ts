import { describe, expect, it } from 'vitest';
import { buildDocumentSourceMap, documentSourceRefs, readDocumentSourceMap, remapDocumentSourceMap, sliceDocumentSourceMaps } from '../src/documentSourceMap.js';

const sourceHash = 'a'.repeat(64);
const first = 'Native heading\nTable 1: Native limits\nvoltage 3.3V';
const second = '한글 표\nFigure 2: Rotated scan\nvoltage 1.8V';
const text = first + '\n\n' + second;
const pages = [{ page: 1, text: first }, { page: 2, text: second, ocr: true }];

describe('document source coordinates', () => {
  it('preserves source text and maps pages, OCR and caption candidates', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    expect(readDocumentSourceMap(map, text)).toEqual(map);
    expect(map.complete).toBe(true);
    expect(map.pages).toEqual([{ page: 1, start: 0, end: first.length },
      { page: 2, start: first.length + 2, end: text.length, ocr: true }]);
    expect(map.captions.map(span => text.slice(span.start, span.end))).toEqual(['Table 1: Native limits', 'Figure 2: Rotated scan']);
  });
  it('selects only overlapping pages in UTF-16 coordinates', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    const start = text.indexOf('1.8V');
    const refs = documentSourceRefs(map, text, [{ start, end: start + 4 }]);
    expect(refs?.pages).toEqual([2]);
    expect(refs?.ocr_pages).toEqual([2]);
    expect(refs?.captions?.[0]).toMatchObject({ page: 2, label: 'Figure 2: Rotated scan' });
    expect(refs?.excerpt_pages).toEqual([[0, 4, 2]]);
  });

  it('maps discontiguous excerpt coordinates without assigning synthetic separators to a page', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    const start = text.indexOf('1.8V');
    const refs = documentSourceRefs(map, text, [{ start: 0, end: 6 }, { start, end: start + 4 }]);
    expect(refs?.excerpt_pages).toEqual([[0, 6, 1], [8, 12, 2]]);
    for (const ranges of [[{ start: -1, end: 4 }], [{ start: 4, end: 4 }], [{ start: 0, end: text.length + 1 }]]) {
      expect(documentSourceRefs(map, text, ranges)).toBeUndefined();
    }
  });

  it('splits a returned range at source pages with Unicode and single-LF boundaries', () => {
    const one = '\ud83d\ude00\ud55c\uae00', two = 'Second page';
    const value = one + '\n' + two;
    const map = buildDocumentSourceMap(value, [{ page: 1, text: one }, { page: 2, text: two }], sourceHash);
    expect(documentSourceRefs(map, value, [{ start: 0, end: value.length }])?.excerpt_pages)
      .toEqual([[0, one.length, 1], [one.length + 1, value.length, 2]]);
  });
  it('does not use a source map with stale text', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    expect(readDocumentSourceMap(map, text + ' changed')).toBeUndefined();
    expect(documentSourceRefs(map, text.replace('1.8V', '9.9V'), [{ start: 0, end: 10 }])).toBeUndefined();
  });
  it('keeps repeated page text in source order', () => {
    const value = 'Repeated\n\nRepeated';
    const map = buildDocumentSourceMap(value, [{ page: 1, text: 'Repeated' }, { page: 3, text: 'Repeated' }], sourceHash);
    expect(map.pages.map(page => page.start)).toEqual([0, 10]);
  });
  it('maps a clipped page prefix without pretending it is complete', () => {
    const clipped = text.slice(0, 8);
    const map = buildDocumentSourceMap(clipped, pages, sourceHash, false);
    expect(map.complete).toBe(false);
    expect(map.pages).toEqual([{ page: 1, start: 0, end: 8 }]);
  });
  it('handles empty or mismatched parser pages explicitly', () => {
    expect(buildDocumentSourceMap('', [], sourceHash).pages).toEqual([]);
    const map = buildDocumentSourceMap('different', [{ page: 1, text: 'source page' }], sourceHash);
    expect(map.pages).toEqual([]);
    expect(map.complete).toBe(false);
  });
  it('rebases title prefixes and trimmed whitespace without changing the underlying source identity', () => {
    const raw = '  ' + text + '\n';
    const map = buildDocumentSourceMap(raw, pages, sourceHash);
    const target = 'Document title\n' + raw.trim();
    const rebased = remapDocumentSourceMap(map, raw, target, 2, 'Document title\n'.length);
    expect(readDocumentSourceMap(rebased, target)?.source_sha256).toBe(sourceHash);
    expect(rebased?.pages[0].start).toBe('Document title\n'.length);
    expect(remapDocumentSourceMap(map, raw, target + 'not a substring', 2, 15)).toBeUndefined();
  });
  it('bounds source-reference metadata instead of exposing the whole map', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    const refs = documentSourceRefs(map, text, [{ start: 0, end: text.length }], 80);
    expect(JSON.stringify(refs).length).toBeLessThanOrEqual(80);
    expect(refs?.truncated).toBe(true);
  });
  it('maps ranked chunk coordinates without carrying captions across chunk boundaries', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    const start = text.indexOf(second);
    const [chunk, partial, invalid] = sliceDocumentSourceMaps(map, text, [
      { start, end: text.length }, { start: text.indexOf('1.8V'), end: text.length }, { start: -1, end: 2 },
    ]);
    expect(readDocumentSourceMap(chunk, second)?.pages).toEqual([{ page: 2, start: 0, end: second.length, ocr: true }]);
    expect(documentSourceRefs(chunk, second, [{ start: 0, end: second.length }])?.captions?.[0].label).toContain('Figure 2');
    expect(partial?.captions).toEqual([]);
    expect(invalid).toBeUndefined();
    expect(sliceDocumentSourceMaps(map, text + 'changed', [{ start: 0, end: 8 }])).toEqual([undefined]);
  });
  it('rejects invalid, overlapping and detached caption coordinates', () => {
    const map = buildDocumentSourceMap(text, pages, sourceHash);
    for (const value of [null, {}, { ...map, pages: [null] }, { ...map, pages: [{ page: 0, start: 0, end: 1 }] },
      { ...map, pages: [{ page: 1, start: 0, end: 10 }, { page: 2, start: 9, end: 20 }] },
      { ...map, captions: [{ page: 8, start: 0, end: 8 }] }]) expect(readDocumentSourceMap(value)).toBeUndefined();
  });
});

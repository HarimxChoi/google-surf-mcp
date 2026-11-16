import { describe, expect, it } from 'vitest';
import { buildDocumentSourceMap } from '../src/documentSourceMap.js';
import { documentContextSpans, selectDocumentEvidence } from '../src/documentEvidence.js';
import { selectEvidence } from '../src/evidence.js';

const table = 'Table 3-4. SPI voltage\n\nSource    Voltage    FORCE    GPIO45    TIEH\nRTC       3.3 V      0        0         Ignored\nRTC       3.3 V      1        Ignored   1\nRegulator 1.8 V      0        1         Ignored\nRegulator 1.8 V      1        Ignored   0';
const content = 'SPI voltage control is described in Table 3-4. The controls include GPIO45 and an override.\n\n' + table + '\n\nNext section';
const map = buildDocumentSourceMap(content, [{ page: 2, text: content }], 'a'.repeat(64));
describe('source-aware native table context', () => {
  it('keeps native table columns and conditional rows together without rewriting text', () => {
    const contexts = documentContextSpans(map, content, 1000);
    expect(contexts.some(spans => content.slice(spans[0].start, spans.at(-1)!.end).includes(table))).toBe(true);
    const out = selectDocumentEvidence(content, 'Table 3-4 SPI voltage GPIO45 FORCE 1.8 V 3.3 V', 1000, [], 'coherent', map);
    expect(out.text).toContain('FORCE    GPIO45    TIEH');
    expect(out.text).toContain('Regulator 1.8 V      1        Ignored   0');
    expect(out.text.length).toBeLessThanOrEqual(1000);
    expect(out.spans.map(span => content.slice(span.start, span.end)).join('\n\n')).toBe(out.text);
  });
  it('leaves balanced, compact, unknown maps, empty queries and stale body maps on the existing path', () => {
    for (const mode of ['balanced', 'compact'] as const) expect(selectDocumentEvidence(content, 'SPI', 250, [], mode, map))
      .toEqual(selectEvidence(content, 'SPI', 250, [], mode));
    expect(selectDocumentEvidence(content, 'SPI', 250, [], 'coherent')).toEqual(selectEvidence(content, 'SPI', 250, [], 'coherent'));
    expect(selectDocumentEvidence(content + 'changed', 'SPI', 250, [], 'coherent', map))
      .toEqual(selectEvidence(content + 'changed', 'SPI', 250, [], 'coherent'));
    expect(selectDocumentEvidence(content, '', 250, [], 'coherent', map)).toEqual(selectEvidence(content, '', 250, [], 'coherent'));
  });
  it('does not treat a table-of-contents entry or an inline reference as a data table', () => {
    const text = 'Table 1. Voltage control ................. 12\n\nTable 2 lists unrelated material.\n\nOrdinary prose follows.';
    const source = buildDocumentSourceMap(text, [{ page: 1, text }], 'a'.repeat(64));
    expect(documentContextSpans(source, text, 1000)).toEqual([]);
  });
  it('handles continued columns and CRLF without crossing page boundaries', () => {
    const one = 'Specification    Value\r\nMemory type      HBM\r\nMemory size      80 GB';
    const two = 'Unrelated second page.';
    const text = one + '\r\n\r\n' + two;
    const source = buildDocumentSourceMap(text, [{ page: 1, text: one }, { page: 2, text: two }], 'b'.repeat(64));
    const contexts = documentContextSpans(source, text, 200);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].at(-1)!.end).toBe(one.length);
  });
  it('splits long native tables with a repeated header and respects excluded source spans', () => {
    const text = 'Table 9. Long samples\nField    Value\n' + Array.from({ length: 80 }, (_, n) => `sample_${n}    ${n}`).join('\n');
    const source = buildDocumentSourceMap(text, [{ page: 1, text }], 'c'.repeat(64));
    const contexts = documentContextSpans(source, text, 300);
    expect(contexts.length).toBeGreaterThan(2);
    expect(contexts.every(spans => spans.map(span => text.slice(span.start, span.end)).join('\n\n').length <= 300)).toBe(true);
    const first = selectDocumentEvidence(text, 'Table 9 sample_0', 300, [], 'coherent', source);
    expect(first.text).toContain('sample_0');
    const next = selectDocumentEvidence(text, 'Table 9 sample_75', 300, first.spans, 'coherent', source);
    expect(next.text).toContain('sample_75');
    expect(next.text).toContain('Field    Value');
    expect(next.text).not.toContain('sample_0');
  });
  it('returns no candidates for tiny/zero budgets and malformed source coordinates', () => {
    expect(documentContextSpans(map, content, 0)).toEqual([]);
    expect(selectDocumentEvidence(content, 'SPI', 0, [], 'coherent', map).text).toBe('');
    expect(documentContextSpans({ ...map, pages: [{ page: 1, start: -1, end: 4 }] }, content, 100)).toEqual([]);
  });
  it('preserves revision-bearing source margins rather than deleting source evidence', () => {
    const pages = Array.from({ length: 8 }, (_, n) => ({ page: n + 1,
      text: `Unrelated page ${n}.\n\nACME Chip Data Sheet v2 | ${n + 1}` }));
    pages[4].text = 'Table 1. Memory specifications\nField    Value\nMemory size    80 GB\nMemory type    HBM\n\nACME Chip Data Sheet v2 | 5';
    const text = pages.map(page => page.text).join('\n\n');
    const source = buildDocumentSourceMap(text, pages, 'd'.repeat(64));
    const selected = selectDocumentEvidence(text, 'ACME Chip Data Sheet memory size type', 600, [], 'coherent', source);
    expect(selected.text).toContain('80 GB');
    expect(selected.text).toContain('HBM');
    expect(selected.text).toContain('ACME Chip Data Sheet v2');
  });
  it('does not classify a repeated factual row near page margins as a document footer', () => {
    const pages = Array.from({ length: 3 }, (_, n) => ({ page: n + 1,
      text: `Model ${n + 1} is a different model.\nMemory size    80 GB` }));
    const text = pages.map(page => page.text).join('\n\n');
    const source = buildDocumentSourceMap(text, pages, 'e'.repeat(64));
    const out = selectDocumentEvidence(text, 'Memory size', 400, [], 'coherent', source);
    expect(out.text.match(/Memory size/g)?.length).toBe(3);
  });
  it('keeps distinct numeric facts that resemble changing page footers', () => {
    const pages = ['Alpha', 'Beta', 'Gamma'].map((name, n) => ({ page: n + 1,
      text: `Model ${name}.\nPower limit | ${(n + 1) * 100}` }));
    const text = pages.map(page => page.text).join('\n\n');
    const source = buildDocumentSourceMap(text, pages, 'f'.repeat(64));
    const out = selectDocumentEvidence(text, 'Beta power limit 200', 200, [], 'coherent', source);
    expect(out.text).toContain('Power limit | 200');
  });
  it('resets Markdown column headers at a verified single-LF page boundary', () => {
    const first = '| Model A | Voltage |\n| Alpha | 5 V |';
    const second = '| Model B | Current |\n| Beta | 3 A |';
    const text = first + '\n' + second;
    const source = buildDocumentSourceMap(text, [{ page: 1, text: first }, { page: 2, text: second }], 'a'.repeat(64));
    const out = selectDocumentEvidence(text, 'Beta 3 A', 44, [], 'coherent', source);
    expect(out.text).toContain('| Model B | Current |');
    expect(out.text).toContain('| Beta | 3 A |');
    expect(out.text).not.toContain('| Model A | Voltage |');
  });
});

describe('source-aware footnote context', () => {
  const main = 'Temperature was 1.09 [0.95 to 1.20] C5 in 2011-2020.';
  const note = '5  Ranges represent very likely intervals unless otherwise stated.';
  const make = (value: string) => buildDocumentSourceMap(value, [{ page: 3, text: value }], 'b'.repeat(64));

  it('binds a marked measurement to its same-page definition within the existing budget', () => {
    const value = main + '\n\n' + Array.from({ length: 8 }, () => 'Temperature measurements in 2011-2020 were compared to the earlier baseline.').join('\n\n') + '\n\n' + note;
    const query = 'Temperature 1.09 0.95 1.20 2011-2020';
    const before = selectEvidence(value, query, 220, [], 'coherent');
    expect(before.text).not.toContain('very likely');
    const out = selectDocumentEvidence(value, query, 220, [], 'coherent', make(value));
    expect(out.text).toContain(main);
    expect(out.text).toContain(note);
    expect(out.text.length).toBeLessThanOrEqual(220);
    expect(out.spans.map(span => value.slice(span.start, span.end)).join('\n\n')).toBe(out.text);
    expect(out.captured_hash).toBe(before.captured_hash);
  });

  it('supports explicit brackets, superscripts and symbol markers without rewriting text', () => {
    for (const [marker, definition] of [['[5]', '5.'], ['\u2075', '[5]'], ['*', '*'], ['\u2020', '\u2020']]) {
      const body = `Temperature was measured${marker} at the site.`;
      const value = body + '\n\n' + `${definition}  An interval applies only to daytime measurements.`;
      const out = selectDocumentEvidence(value, 'Temperature measured site', 180, [], 'coherent', make(value));
      expect(out.text).toContain(body);
      expect(out.text).toContain('only to daytime');
    }
  });

  it('does not bind an ordinary model suffix or a different superscript number', () => {
    for (const body of ['Model5 reports the temperature.', 'Temperature was measured\u00b9\u00b2 at the site.']) {
      const value = body + '\n\n1  This condition is not associated.\n\n5  This condition is also unrelated.';
      expect(selectDocumentEvidence(value, 'Model5 temperature measured site', 180, [], 'coherent', make(value)))
        .toEqual(selectEvidence(value, 'Model5 temperature measured site', 180, [], 'coherent'));
    }
  });

  it('does not bind definitions across pages or re-expose excluded notes', () => {
    const value = main + '\n\n' + note;
    const map = buildDocumentSourceMap(value, [{ page: 1, text: main }, { page: 2, text: note }], 'c'.repeat(64));
    const query = 'Temperature 1.09 2011-2020';
    expect(selectDocumentEvidence(value, query, 180, [], 'coherent', map).text).not.toContain(note);
    const excluded = [{ start: value.indexOf(note), end: value.length }];
    expect(selectDocumentEvidence(value, query, 180, excluded, 'coherent', make(value)).text).not.toContain(note);
  });

  it('does not change other modes or exceed tiny budgets for a related note', () => {
    const value = main + '\n\n' + note;
    for (const mode of ['balanced', 'compact'] as const) {
      expect(selectDocumentEvidence(value, 'Temperature', 180, [], mode, make(value)))
        .toEqual(selectEvidence(value, 'Temperature', 180, [], mode));
    }
    for (const budget of [0, 1, 40, 80]) {
      const out = selectDocumentEvidence(value, 'Temperature', budget, [], 'coherent', make(value));
      expect(out.text.length).toBeLessThanOrEqual(budget);
    }
  });

  it('leaves ambiguous repeated definition markers on the existing path', () => {
    const value = main + '\n\n5  First unrelated condition.\n\n5  A different condition uses the same marker.';
    expect(selectDocumentEvidence(value, 'Temperature 1.09', 180, [], 'coherent', make(value)))
      .toEqual(selectEvidence(value, 'Temperature 1.09', 180, [], 'coherent'));
  });

  it('keeps an exact requested table intact when its note cannot also fit', () => {
    const value = table.replace('RTC       3.3 V', 'RTC       3.3 V5') + '\n\n' + note;
    const source = make(value);
    const budget = table.length + 1;
    const out = selectDocumentEvidence(value, 'Table 3-4 SPI voltage GPIO45 FORCE', budget, [], 'coherent', source);
    expect(out.text).toContain('Regulator 1.8 V      1        Ignored   0');
    expect(out.text.length).toBeLessThanOrEqual(budget);
  });

  it('does not bind the last definition on an incomplete captured page', () => {
    const value = main + '\n\n5  The reported interval is valid only if';
    const source = buildDocumentSourceMap(value, [{ page: 1, text: value }], 'a'.repeat(64), false);
    const out = selectDocumentEvidence(value, 'Temperature 1.09', 200, [], 'coherent', source);
    expect(out.text).toContain(main);
    expect(out.text).not.toContain('only if');
  });

  it('does not mistake a multiplication operator or a memory standard for a note marker', () => {
    for (const [body, note] of [
      ['Temperature calibration uses 5*6 samples.', '*  An unrelated bullet condition.'],
      ['The platform uses 2 DDR5 modules.', '5  An unrelated timing condition.'],
    ]) {
      const value = body + '\n\n' + note;
      expect(selectDocumentEvidence(value, body, 200, [], 'coherent', make(value)))
        .toEqual(selectEvidence(value, body, 200, [], 'coherent'));
    }
  });

  it('retains a complete blank-terminated note before a later capture boundary', () => {
    const value = main + '\n\n' + note + '\n\n' + 'A later section is clipped here';
    const source = buildDocumentSourceMap(value, [{ page: 1, text: value }], 'a'.repeat(64), false);
    expect(selectDocumentEvidence(value, 'Temperature 1.09', 200, [], 'coherent', source).text).toContain(note);
  });
});

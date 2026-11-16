import { describe, expect, it } from 'vitest';
import { htmlToHwpDocument, hwpDocumentToMarkdown, type HwpDocument } from 'hwp-convert';
import { hwpIRToPlainText } from '../src/hwpText.js';
import { containsSensitiveContent } from '../src/research/inventory.js';

type Paragraph = HwpDocument['sections'][number]['paragraphs'][number];
const paragraph = (text: string): Paragraph => ({ text, paraShapeId: 0, styleId: 0, runs: [], controls: [] });
const document = (paragraphs: Paragraph[]): HwpDocument => ({ ...htmlToHwpDocument('<p>placeholder</p>'), sections: [{ paragraphs }] });

describe('shared native HWP representation', () => {
  it('preserves sections, empty paragraphs, tables and equations in the legacy plain-text order', () => {
    const p = paragraph('body');
    p.controls.push({ kind: 'table', rowCount: 1, colCount: 2, cells: [
      { row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [paragraph('cell A')] },
      { row: 0, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [paragraph('cell B')] },
    ] }, { kind: 'equation', script: 'a + b' });
    const doc = document([p, paragraph('')]); doc.sections.push({ paragraphs: [paragraph('next section')] });
    expect(hwpIRToPlainText(doc)).toBe('body\ncell A\ncell B\na + b\n\n\nnext section');
  });
  it.each(['body', 'header', 'footer', 'footnote', 'table', 'equation'] as const)
  ('scans unescaped %s text from the same parsed document', kind => {
    const token = `ghp_${'a'.repeat(36)}`, p = paragraph('safe');
    if (kind === 'body') p.text = token;
    else if (kind === 'equation') p.controls.push({ kind: 'equation', script: token });
    else if (kind === 'table') p.controls.push({ kind: 'table', rowCount: 1, colCount: 1,
      cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [paragraph(token)] }] });
    else p.controls.push({ kind, paragraphs: [paragraph(token)] });
    const doc = document([p]);
    expect(containsSensitiveContent(hwpIRToPlainText(doc))).toBe(true);
    expect(hwpIRToPlainText(doc)).toContain(token);
  });
  it('uses paragraph text rather than runs and keeps the Markdown representation separate', () => {
    const doc = htmlToHwpDocument('<p>Cedar <strong>8192</strong></p><table><tr><td>Native</td><td>8192</td></tr></table>');
    const p = paragraph('plain'); p.runs = [{ charShapeId: 0, text: 'not the plain source' }];
    expect(hwpIRToPlainText(document([p]))).toBe('plain');
    expect(hwpIRToPlainText(doc)).toContain('Native');
    expect(hwpDocumentToMarkdown(doc, { embedImages: false })).toContain('8192');
  });
});

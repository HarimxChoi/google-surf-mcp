import type { HwpDocument } from 'hwp-convert';

type Paragraph = HwpDocument['sections'][number]['paragraphs'][number];

function paragraphText(paragraph: Paragraph): string {
  const parts = paragraph.text.length ? [paragraph.text] : [];
  for (const control of paragraph.controls) {
    if (control.kind === 'table') {
      parts.push(control.cells.map(cell => cell.paragraphs.map(paragraphText).join('\n')).join('\n'));
    } else if (control.kind === 'header' || control.kind === 'footer' || control.kind === 'footnote') {
      parts.push(control.paragraphs.map(paragraphText).join('\n'));
    } else if (control.kind === 'equation' && control.script.length) parts.push(control.script);
  }
  return parts.join('\n');
}

export function hwpIRToPlainText(document: HwpDocument): string {
  return document.sections.map(section => section.paragraphs.map(paragraphText).join('\n')).join('\n\n');
}

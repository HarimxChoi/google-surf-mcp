import { getDocumentProxy, extractText } from 'unpdf';

export type PdfMode = 'full' | 'abstract' | 'metadata';

export interface PdfExtractResult {
  is_pdf: true;
  page_count: number;
  extraction_quality: 'full_text' | 'abstract' | 'metadata_only';
  content?: string;
  length?: number;
}

export function isPdfMagic(buf: Uint8Array | Buffer): boolean {
  if (buf.length < 4) return false;
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

export function isPdfContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  return ct.toLowerCase().includes('application/pdf');
}

export async function extractPdfTiered(
  buf: Uint8Array,
  mode: PdfMode,
  maxChars: number,
): Promise<PdfExtractResult> {
  const pdf = await getDocumentProxy(buf);
  try {
    const page_count = pdf.numPages;

    if (mode === 'metadata') {
      return { is_pdf: true, page_count, extraction_quality: 'metadata_only' };
    }

    let raw: string;
    if (mode === 'abstract') {
      const page = await (pdf as any).getPage(1);
      const content = await page.getTextContent();
      raw = (content.items as Array<{ str?: string; hasEOL?: boolean }>)
        .filter((it) => it.str != null)
        .map((it) => it.str + (it.hasEOL ? '\n' : ''))
        .join('');
    } else {
      const { text } = await extractText(pdf, { mergePages: true });
      raw = text;
    }
    const clipped = raw.slice(0, maxChars);

    return {
      is_pdf: true,
      page_count,
      extraction_quality: mode === 'abstract' ? 'abstract' : 'full_text',
      content: clipped,
      length: clipped.length,
    };
  } finally {
    await (pdf as any).destroy?.().catch(() => {});
  }
}

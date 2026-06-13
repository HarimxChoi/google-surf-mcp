import { LiteParse } from '@llamaindex/liteparse';

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
  const ocrEnabled = process.env.SURF_EXTRACT_OCR?.toLowerCase() === 'true';
  const { pages, text } = await new LiteParse({ ocrEnabled, quiet: true }).parse(buf);
  const page_count = pages.length;

  if (mode === 'metadata') {
    return { is_pdf: true, page_count, extraction_quality: 'metadata_only' };
  }

  const raw = mode === 'abstract' ? (pages[0]?.text ?? '') : text;
  const clipped = raw.slice(0, maxChars);
  return {
    is_pdf: true,
    page_count,
    extraction_quality: mode === 'abstract' ? 'abstract' : 'full_text',
    content: clipped,
    length: clipped.length,
  };
}

import type { ExtractResult, ExtractMode } from './extract.js';
import { extractionProvenance } from './extractionProvenance.js';
import { buildDocumentSourceMap } from './documentSourceMap.js';
import { documentOcrSettings } from './documentSettings.js';

export function isImageMagic(buf: Uint8Array): boolean {
  const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    || bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0]))
    || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]));
}

export async function extractImage(buf: Uint8Array, url: string, mode: ExtractMode, maxChars: number): Promise<ExtractResult> {
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(buf, { limitInputPixels: 32_000_000 }).metadata();
  if ((metadata.width ?? 0) * (metadata.height ?? 0) * (metadata.pages ?? 1) > 32_000_000) {
    throw new Error('image exceeds 32 million pixels; split multipage images or reduce resolution');
  }
  const base = { url, is_pdf: false, is_image: true, image_width: metadata.width, image_height: metadata.height,
    extraction_provenance: extractionProvenance(buf, 'image', 'sharp') };
  if (mode === 'metadata') return { ...base, extraction_quality: 'metadata_only' };
  const { policy, language } = documentOcrSettings();
  if (policy === 'off') {
    return { ...base, extraction_quality: 'metadata_only',
      quality_reason: 'image_text_not_read; enable SURF_EXTRACT_OCR=true to extract image text' };
  }
  const { LiteParse } = await import('@llamaindex/liteparse');
  const parser = new LiteParse({ ocrEnabled: true, quiet: true, numWorkers: 2,
    ocrLanguage: language,
    outputFormat: 'markdown', imageMode: 'off', targetPages: mode === 'abstract' ? '1' : undefined });
  try {
    const { text, totalPages, pages } = await parser.parse(buf);
    const raw = pages.some(page => page.text.trim()) ? text : '';
    const content = raw.slice(0, maxChars);
    return { ...base, page_count: totalPages, content_format: 'markdown', extraction_method: 'ocr',
      extraction_provenance: extractionProvenance(buf, 'image', 'liteparse', policy, language, 'markdown'),
      extraction_quality: raw.trim() ? mode === 'abstract' ? 'abstract' : 'full_text' : 'metadata_only',
      ...(!raw.trim() ? { quality_reason: 'image_ocr_returned_no_text' } : {}),
      ...(raw.trim() ? { source_map: buildDocumentSourceMap(content,
        pages.map(page => ({ page: page.pageNum, text: page.markdown, ocr: true })),
        base.extraction_provenance.source_sha256, raw.length <= maxChars) } : {}),
      content, length: content.length, source_length: raw.length, truncated: raw.length > maxChars };
  } finally { parser.close(); }
}

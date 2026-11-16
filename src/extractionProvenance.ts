import { createHash } from 'node:crypto';

export interface ExtractionProvenance {
  source_sha256: string;
  source_format: 'pdf' | 'image' | 'docx' | 'pptx' | 'hwp' | 'hwpx';
  parser: 'pdf-lib' | 'liteparse' | 'sharp' | 'officeparser' | 'xberg' | 'kreuzberg' | 'hwp-convert' | 'archive';
  ocr_policy: 'off' | 'enabled' | 'auto';
  ocr_language?: string;
  content_format?: 'text' | 'markdown';
}

export function extractionProvenance(
  bytes: Uint8Array,
  sourceFormat: ExtractionProvenance['source_format'],
  parser: ExtractionProvenance['parser'],
  ocrPolicy: ExtractionProvenance['ocr_policy'] = 'off',
  language?: string,
  contentFormat?: ExtractionProvenance['content_format'],
): ExtractionProvenance {
  return { source_sha256: createHash('sha256').update(bytes).digest('hex'),
    source_format: sourceFormat, parser, ocr_policy: ocrPolicy,
    ...(ocrPolicy !== 'off' && language ? { ocr_language: language.slice(0, 100) } : {}),
    ...(contentFormat ? { content_format: contentFormat } : {}) };
}

export function readExtractionProvenance(value: unknown): ExtractionProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.source_sha256)
    || !['pdf', 'image', 'docx', 'pptx', 'hwp', 'hwpx'].includes(String(row.source_format))
    || !['pdf-lib', 'liteparse', 'sharp', 'officeparser', 'xberg', 'kreuzberg', 'hwp-convert', 'archive'].includes(String(row.parser))
    || !['off', 'enabled', 'auto'].includes(String(row.ocr_policy))) return undefined;
  return { source_sha256: row.source_sha256, source_format: row.source_format as ExtractionProvenance['source_format'],
    parser: row.parser as ExtractionProvenance['parser'], ocr_policy: row.ocr_policy as ExtractionProvenance['ocr_policy'],
    ...(row.ocr_policy !== 'off' && typeof row.ocr_language === 'string'
      ? { ocr_language: row.ocr_language.slice(0, 100) } : {}),
    ...(row.content_format === 'text' || row.content_format === 'markdown' ? { content_format: row.content_format } : {}) };
}

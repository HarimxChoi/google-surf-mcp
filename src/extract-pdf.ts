import { PDFDocument } from 'pdf-lib';
import type { DocumentMetadata } from './extract-meta.js';
import { extractionProvenance, type ExtractionProvenance } from './extractionProvenance.js';
import { buildDocumentSourceMap, type DocumentSourceMap } from './documentSourceMap.js';
import { documentOcrSettings } from './documentSettings.js';

export type PdfMode = 'full' | 'abstract' | 'metadata';

export interface PdfExtractResult extends DocumentMetadata {
  is_pdf: true;
  page_count: number;
  extraction_quality: 'full_text' | 'abstract' | 'metadata_only';
  content?: string;
  length?: number;
  source_length?: number;
  truncated?: boolean;
  quality_reason?: string;
  content_format?: 'text' | 'markdown';
  extraction_provenance?: ExtractionProvenance;
  source_map?: DocumentSourceMap;
}

function metadataDate(value: Date | undefined): string | undefined {
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

function metadataKeywords(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const keywords = value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  return keywords.length ? keywords : undefined;
}

async function readPdfMetadata(buf: Uint8Array): Promise<DocumentMetadata & { page_count?: number }> {
  try {
    const pdf = await PDFDocument.load(buf, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    const title = pdf.getTitle()?.trim();
    const authors = pdf.getAuthor()?.trim();
    const subject = pdf.getSubject()?.trim();
    const keywords = metadataKeywords(pdf.getKeywords());
    const creator = pdf.getCreator()?.trim();
    const producer = pdf.getProducer()?.trim();
    const createdAt = metadataDate(pdf.getCreationDate());
    const modifiedAt = metadataDate(pdf.getModificationDate());
    return {
      page_count: pdf.getPageCount(),
      ...(title ? { title } : {}),
      ...(authors ? { authors } : {}),
      ...(subject ? { subject } : {}),
      ...(keywords ? { keywords } : {}),
      ...(creator ? { creator } : {}),
      ...(producer ? { producer } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(modifiedAt ? { modified_at: modifiedAt } : {}),
    };
  } catch {
    return {};
  }
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
  const { policy: ocrPolicy, language } = documentOcrSettings();
  let ocrEnabled = ocrPolicy === 'enabled';
  const metadataPromise = readPdfMetadata(buf);

  if (mode === 'metadata') {
    const metadata = await metadataPromise;
    if (metadata.page_count !== undefined) {
      return { ...metadata, is_pdf: true, page_count: metadata.page_count, extraction_quality: 'metadata_only',
        extraction_provenance: extractionProvenance(buf, 'pdf', 'pdf-lib') };
    }
  }

  const contentFormat = process.env.SURF_EXTRACT_PDF_FORMAT === 'markdown' ? 'markdown' : 'text';
  const { LiteParse } = await import('@llamaindex/liteparse');
  const config = { quiet: true, outputFormat: contentFormat,
    targetPages: mode === 'abstract' ? '1' : undefined, imageMode: 'off',
    ocrLanguage: language } as const;
  const parser = new LiteParse({ ...config, ocrEnabled, includeComplexity: ocrPolicy === 'auto' });
  const provenance = extractionProvenance(buf, 'pdf', 'liteparse',
    ocrPolicy, config.ocrLanguage, contentFormat);
  try {
    let parsed = await parser.parse(buf);
    const ocrPages = new Set<number>();
    if (ocrEnabled) for (const page of parsed.pages) {
      if (page.textItems.some(item => item.confidence !== undefined)) ocrPages.add(page.pageNum);
    }
    if (ocrPolicy === 'auto' && mode !== 'metadata') {
      const needed = parsed.pages.filter(page => page.complexity?.needsOcr).map(page => page.pageNum);
      if (needed.length) {
        ocrEnabled = true;
        const ocr = new LiteParse({ ...config, ocrEnabled: true, targetPages: needed.join(',') });
        try {
          const recovered = await ocr.parse(buf);
          for (const page of recovered.pages) if (page.textItems.some(item => item.confidence !== undefined)) ocrPages.add(page.pageNum);
          const byPage = new Map(recovered.pages.map(page => [page.pageNum, page]));
          const pages = parsed.pages.map(page => byPage.get(page.pageNum) ?? page);
          parsed = { ...parsed, pages, text: pages.map(page => contentFormat === 'markdown' ? page.markdown : page.text)
            .join(contentFormat === 'markdown' ? '\n\n-----\n\n' : '\n\n') };
        } finally { ocr.close(); }
      }
    }
    const { totalPages, pages, text } = parsed;
    const metadata = await metadataPromise;
    const page_count = totalPages;
    if (mode === 'metadata') return { ...metadata, is_pdf: true, page_count, extraction_quality: 'metadata_only',
      extraction_provenance: provenance };

    const raw = pages.some(page => page.text.trim()) ? text : '';
    const clipped = raw.slice(0, maxChars);
    const empty = !raw.trim();
    return {
      ...metadata,
      is_pdf: true,
      page_count,
      content_format: contentFormat,
      extraction_provenance: provenance,
      ...(!empty ? { source_map: buildDocumentSourceMap(clipped, pages.map(page => ({ page: page.pageNum,
        text: contentFormat === 'markdown' ? page.markdown : page.text, ocr: ocrPages.has(page.pageNum) })),
        provenance.source_sha256, raw.length <= maxChars) } : {}),
      extraction_quality: empty ? 'metadata_only' : mode === 'abstract' ? 'abstract' : 'full_text',
      ...(empty ? { quality_reason: ocrEnabled ? 'pdf_ocr_returned_no_text'
        : 'pdf_no_extractable_text; enable SURF_EXTRACT_OCR=true for image-only pages' } : {}),
      content: clipped,
      length: clipped.length,
      source_length: raw.length,
      truncated: raw.length > maxChars,
    };
  } finally {
    parser.close();
  }
}

import { LiteParse } from '@llamaindex/liteparse';
import { PDFDocument } from 'pdf-lib';
import type { DocumentMetadata } from './extract-meta.js';

export type PdfMode = 'full' | 'abstract' | 'metadata';

export interface PdfExtractResult extends DocumentMetadata {
  is_pdf: true;
  page_count: number;
  extraction_quality: 'full_text' | 'abstract' | 'metadata_only';
  content?: string;
  length?: number;
  source_length?: number;
  truncated?: boolean;
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
  const ocrEnabled = process.env.SURF_EXTRACT_OCR?.toLowerCase() === 'true';
  const parser = new LiteParse({ ocrEnabled, quiet: true });
  const metadataPromise = readPdfMetadata(buf);

  if (mode === 'metadata') {
    const metadata = await metadataPromise;
    const page_count = metadata.page_count
      ?? (await parser.parse(buf)).pages.length;
    return { ...metadata, is_pdf: true, page_count, extraction_quality: 'metadata_only' };
  }

  const [{ pages, text }, metadata] = await Promise.all([parser.parse(buf), metadataPromise]);
  const page_count = pages.length;

  const raw = mode === 'abstract' ? (pages[0]?.text ?? '') : text;
  const clipped = raw.slice(0, maxChars);
  return {
    ...metadata,
    is_pdf: true,
    page_count,
    extraction_quality: mode === 'abstract' ? 'abstract' : 'full_text',
    content: clipped,
    length: clipped.length,
    source_length: raw.length,
    truncated: raw.length > maxChars,
  };
}

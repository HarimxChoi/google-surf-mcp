import { afterEach, describe, it, expect, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfTiered, isPdfMagic, isPdfContentType } from '../src/extract-pdf.js';

async function metadataPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  page.drawText('Metadata test body', { x: 50, y: 700, font });
  pdf.setTitle('Metadata Test Paper');
  pdf.setAuthor('Ada Lovelace; Grace Hopper');
  pdf.setSubject('Graph retrieval');
  pdf.setKeywords(['graph RAG', 'lineage']);
  pdf.setCreator('Research Tool');
  pdf.setProducer('PDF Producer');
  pdf.setCreationDate(new Date('2026-08-25T01:02:03.000Z'));
  pdf.setModificationDate(new Date('2026-08-26T04:05:06.000Z'));
  return await pdf.save({ updateFieldAppearances: false });
}

describe('isPdfMagic', () => {
  it('detects the %PDF signature', () => {
    const buf = Buffer.from('%PDF-1.4\n...', 'binary');
    expect(isPdfMagic(buf)).toBe(true);
  });

  it('rejects HTML start', () => {
    expect(isPdfMagic(Buffer.from('<!DOCTYPE html>'))).toBe(false);
    expect(isPdfMagic(Buffer.from('<html>'))).toBe(false);
  });

  it('rejects buffers shorter than 4 bytes', () => {
    expect(isPdfMagic(Buffer.from(''))).toBe(false);
    expect(isPdfMagic(Buffer.from('%PD'))).toBe(false);
  });

  it('works with Uint8Array', () => {
    expect(isPdfMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(true);
    expect(isPdfMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
  });
});

describe('isPdfContentType', () => {
  it('accepts application/pdf', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
  });

  it('accepts application/pdf with charset', () => {
    expect(isPdfContentType('application/pdf; charset=binary')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPdfContentType('Application/PDF')).toBe(true);
  });

  it('rejects html', () => {
    expect(isPdfContentType('text/html')).toBe(false);
    expect(isPdfContentType('text/html; charset=utf-8')).toBe(false);
  });

  it('handles null/undefined/empty', () => {
    expect(isPdfContentType(null)).toBe(false);
    expect(isPdfContentType(undefined)).toBe(false);
    expect(isPdfContentType('')).toBe(false);
  });
});

describe('extractPdfTiered metadata', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([['abstract', 'text'], ['abstract', 'markdown'], ['full', 'text'], ['full', 'markdown']] as const)(
    'does not label an empty %s/%s extraction as readable text', async (mode, format) => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'false');
    vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', format);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const result = await extractPdfTiered(await pdf.save(), mode, 1500);
    expect(result).toMatchObject({ extraction_quality: 'metadata_only', content: '', length: 0 });
    expect(result.quality_reason).toContain('SURF_EXTRACT_OCR=true');
  });

  it('reads only the first page for abstract mode while reporting the source page count', async () => {
    vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', 'markdown');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('First page content', { x: 50, y: 700, font });
    pdf.addPage().drawText('Second page content', { x: 50, y: 700, font });
    const result = await extractPdfTiered(await pdf.save(), 'abstract', 1500);
    expect(result.page_count).toBe(2);
    expect(result.content).toContain('First page content');
    expect(result.content).not.toContain('Second page content');
    expect(result.content_format).toBe('markdown');
  });

  it('keeps an explicit plain text fallback and exact clipping metadata', async () => {
    vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', 'text');
    const result = await extractPdfTiered(await metadataPdf(), 'full', 8);
    expect(result.content_format).toBe('text');
    expect(result.content).toHaveLength(8);
    expect(result.length).toBe(8);
    expect(result.source_length).toBeGreaterThan(8);
    expect(result.truncated).toBe(true);
  });

  it('extracts readable PDF text with the automatic OCR policy', async () => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'auto');
    const result = await extractPdfTiered(await metadataPdf(), 'full', 1500);
    expect(result.content).toContain('Metadata test body');
    expect(result.extraction_quality).toBe('full_text');
  });

  it.each(['metadata', 'abstract', 'full'] as const)(
    'returns document metadata in %s mode',
    async (mode) => {
      const result = await extractPdfTiered(await metadataPdf(), mode, 50_000);

      expect(result).toMatchObject({
        is_pdf: true,
        page_count: 1,
        title: 'Metadata Test Paper',
        authors: 'Ada Lovelace; Grace Hopper',
        subject: 'Graph retrieval',
        keywords: ['graph RAG lineage'],
        creator: 'Research Tool',
        producer: 'PDF Producer',
        created_at: '2026-08-25T01:02:03.000Z',
        modified_at: '2026-08-26T04:05:06.000Z',
      });
      if (mode === 'metadata') expect(result.content).toBeUndefined();
      else expect(result.content).toContain('Metadata test body');
    },
  );
});

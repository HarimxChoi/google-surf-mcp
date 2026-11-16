import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractPdfTiered } from '../src/extract-pdf.js';

const reader = vi.hoisted(() => ({ parse: vi.fn(), close: vi.fn(), configs: [] as Record<string, unknown>[] }));
vi.mock('@llamaindex/liteparse', () => ({ LiteParse: class {
  constructor(config: Record<string, unknown>) { reader.configs.push(config); }
  parse = reader.parse;
  close = reader.close;
} }));

const page = (pageNum: number, text: string, needsOcr: boolean) => ({ pageNum, text, markdown: `**${text}**`, textItems: [], complexity: { needsOcr } });
async function document() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage();
  return pdf.save();
}

describe('page-targeted automatic PDF OCR', () => {
  beforeEach(() => { vi.stubEnv('SURF_EXTRACT_OCR', 'auto'); vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', 'text'); reader.configs.length = 0; });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

  it('OCRs only flagged pages and retains native text and source order', async () => {
    reader.parse.mockResolvedValueOnce({ totalPages: 3,
      pages: [page(1, 'Native first', false), page(2, '', true), page(3, 'Native third', false)], text: 'Native first\n\n\n\nNative third' });
    reader.parse.mockResolvedValueOnce({ totalPages: 3, pages: [page(2, 'OCR second', false)], text: 'OCR second' });
    const result = await extractPdfTiered(await document(), 'full', 1000);
    expect(result.content).toBe('Native first\n\nOCR second\n\nNative third');
    expect(result.page_count).toBe(3);
    expect(reader.configs[0]).toMatchObject({ ocrEnabled: false, includeComplexity: true });
    expect(reader.configs[1]).toMatchObject({ ocrEnabled: true, targetPages: '2' });
    expect(reader.close).toHaveBeenCalledTimes(2);
  });

  it('does not create an OCR parser for native pages', async () => {
    reader.parse.mockResolvedValueOnce({ totalPages: 3, pages: [page(1, 'Native first', false)], text: 'Native first' });
    const result = await extractPdfTiered(await document(), 'abstract', 1000);
    expect(result.content).toBe('Native first');
    expect(result.page_count).toBe(3);
    expect(reader.configs).toHaveLength(1);
    expect(reader.configs[0].targetPages).toBe('1');
  });

  it('retains optional Markdown page boundaries after targeted OCR', async () => {
    vi.stubEnv('SURF_EXTRACT_PDF_FORMAT', 'markdown');
    reader.parse.mockResolvedValueOnce({ totalPages: 3, pages: [page(1, 'Native', false), page(2, '', true)], text: '**Native**' });
    reader.parse.mockResolvedValueOnce({ totalPages: 3, pages: [page(2, 'OCR', false)], text: '**OCR**' });
    const result = await extractPdfTiered(await document(), 'full', 1000);
    expect(result.content).toBe('**Native**\n\n-----\n\n**OCR**');
    expect(result.content_format).toBe('markdown');
  });

  it('closes both parsers if a targeted OCR page fails', async () => {
    reader.parse.mockResolvedValueOnce({ totalPages: 3, pages: [page(2, '', true)], text: '' });
    reader.parse.mockRejectedValueOnce(new Error('OCR failed'));
    await expect(extractPdfTiered(await document(), 'full', 1000)).rejects.toThrow('OCR failed');
    expect(reader.close).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extract } from '../src/extract.js';

const LANDING_URL = 'https://example.com/paper';
const PDF_URL = 'https://example.com/paper.pdf';

async function paperPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage();
  page.drawText('Paper first page', { x: 50, y: 700, font });
  pdf.setTitle('Embedded title');
  pdf.setAuthor('Embedded author');
  pdf.setSubject('Graph retrieval');
  return await pdf.save();
}

describe('extract document metadata', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    originalFetch = global.fetch;
    process.env.SURF_ALLOW_PRIVATE = 'true';
    const pdf = await paperPdf();
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (url.toString() === LANDING_URL) {
        return new Response(`
          <meta name="citation_title" content="Landing title">
          <meta name="citation_author" content="Landing author">
          <meta name="citation_doi" content="10.1234/landing">
          <meta name="citation_pdf_url" content="${PDF_URL}">
        `, { headers: { 'content-type': 'text/html' } });
      }
      if (url.toString() === PDF_URL) {
        return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SURF_ALLOW_PRIVATE;
  });

  it.each(['metadata', 'abstract', 'full'] as const)(
    'merges landing and PDF metadata in %s mode',
    async (mode) => {
      const ctx = { newPage: async () => { throw new Error('browser should not be reached'); } } as any;
      const result = await extract(ctx, LANDING_URL, { mode });

      expect(result).toMatchObject({
        url: PDF_URL,
        title: 'Landing title',
        authors: 'Landing author',
        doi: '10.1234/landing',
        subject: 'Graph retrieval',
        page_count: 1,
        is_pdf: true,
      });
      if (mode === 'metadata') expect(result.content).toBeUndefined();
      else expect(result.content).toContain('Paper first page');
    },
  );

  it('returns webpage metadata without body text', async () => {
    const articleUrl = 'https://example.com/article';
    global.fetch = vi.fn(async () => new Response(`
      <title>Web article</title>
      <link rel="canonical" href="/canonical-article">
      <meta name="author" content="Web author">
      <meta property="og:site_name" content="Example News">
      <meta property="article:published_time" content="2026-08-26T10:00:00Z">
      <meta name="description" content="Article description">
    `, { headers: { 'content-type': 'text/html' } })) as typeof global.fetch;
    const ctx = { newPage: async () => { throw new Error('browser should not be reached'); } } as any;

    const result = await extract(ctx, articleUrl, { mode: 'metadata' });

    expect(result).toMatchObject({
      url: articleUrl,
      title: 'Web article',
      authors: 'Web author',
      publication: 'Example News',
      published_at: '2026-08-26T10:00:00Z',
      year: 2026,
      description: 'Article description',
      canonical_url: 'https://example.com/canonical-article',
      is_pdf: false,
      extraction_quality: 'metadata_only',
    });
    expect(result.content).toBeUndefined();
  });
});

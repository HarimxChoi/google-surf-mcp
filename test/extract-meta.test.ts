import { describe, it, expect } from 'vitest';
import {
  findCitationPdfUrl, findAbstractFromMeta, findTitle,
  domainPdfTransform, findPmcUrlFromPubmed,
} from '../src/extract-meta.js';

describe('findCitationPdfUrl', () => {
  it('returns absolute URL when meta is absolute', () => {
    const html = `<meta name="citation_pdf_url" content="https://arxiv.org/pdf/2310.06825">`;
    expect(findCitationPdfUrl(html, 'https://arxiv.org/abs/2310.06825')).toBe('https://arxiv.org/pdf/2310.06825');
  });

  it('resolves relative path against baseUrl', () => {
    const html = `<meta name="citation_pdf_url" content="/pdf?id=ABC">`;
    expect(findCitationPdfUrl(html, 'https://openreview.net/forum?id=ABC')).toBe('https://openreview.net/pdf?id=ABC');
  });

  it('returns null when meta is missing', () => {
    expect(findCitationPdfUrl('<html></html>', 'https://x.com')).toBeNull();
  });

  it('handles single-quoted attributes', () => {
    const html = `<meta name='citation_pdf_url' content='https://x.com/a.pdf'>`;
    expect(findCitationPdfUrl(html, 'https://x.com')).toBe('https://x.com/a.pdf');
  });
});

describe('findAbstractFromMeta', () => {
  const long = 'A'.repeat(200);

  it('prefers citation_abstract over other patterns', () => {
    const html =
      `<meta name="citation_abstract" content="${long}">` +
      `<meta name="description" content="${long}">`;
    expect(findAbstractFromMeta(html)?.source).toBe('citation_abstract');
  });

  it('falls through to dc.description, description, og:description', () => {
    const dc = `<meta name="dc.description" content="${long}">`;
    expect(findAbstractFromMeta(dc)?.source).toBe('dc.description');

    const desc = `<meta name="description" content="${long}">`;
    expect(findAbstractFromMeta(desc)?.source).toBe('description');

    const og = `<meta property="og:description" content="${long}">`;
    expect(findAbstractFromMeta(og)?.source).toBe('og:description');
  });

  it('rejects entries shorter than minLength', () => {
    const short = `<meta name="description" content="too short">`;
    expect(findAbstractFromMeta(short)).toBeNull();
    expect(findAbstractFromMeta(short, 5)).not.toBeNull();
  });

  it('returns null when no patterns match', () => {
    expect(findAbstractFromMeta('<html></html>')).toBeNull();
  });
});

describe('findTitle', () => {
  it('prefers citation_title', () => {
    const html =
      `<meta name="citation_title" content="Citation Title">` +
      `<meta property="og:title" content="OG Title">` +
      `<title>Page Title</title>`;
    expect(findTitle(html)).toBe('Citation Title');
  });

  it('falls back to og:title', () => {
    const html = `<meta property="og:title" content="OG Title"><title>Page Title</title>`;
    expect(findTitle(html)).toBe('OG Title');
  });

  it('falls back to <title>', () => {
    expect(findTitle('<title>Just A Title</title>')).toBe('Just A Title');
  });

  it('decodes HTML entities', () => {
    expect(findTitle('<title>A &amp; B</title>')).toBe('A & B');
  });

  it('returns undefined when nothing matches', () => {
    expect(findTitle('<html></html>')).toBeUndefined();
  });
});

describe('domainPdfTransform', () => {
  it('openreview forum → pdf', () => {
    expect(domainPdfTransform('https://openreview.net/forum?id=FDX7EB9CDv'))
      .toBe('https://openreview.net/pdf?id=FDX7EB9CDv');
  });

  it('biorxiv content → .full.pdf', () => {
    expect(domainPdfTransform('https://www.biorxiv.org/content/10.1101/X.Yv1'))
      .toBe('https://www.biorxiv.org/content/10.1101/X.Yv1.full.pdf');
  });

  it('medrxiv same as biorxiv', () => {
    expect(domainPdfTransform('https://www.medrxiv.org/content/10.1101/X.Yv1'))
      .toBe('https://www.medrxiv.org/content/10.1101/X.Yv1.full.pdf');
  });

  it('nature articles → .pdf', () => {
    expect(domainPdfTransform('https://www.nature.com/articles/s41586-024-07566-y'))
      .toBe('https://www.nature.com/articles/s41586-024-07566-y.pdf');
  });

  it('returns null for already-.pdf URLs', () => {
    expect(domainPdfTransform('https://www.biorxiv.org/content/X.full.pdf')).toBeNull();
    expect(domainPdfTransform('https://www.nature.com/articles/X.pdf')).toBeNull();
  });

  it('returns null for unknown domains', () => {
    expect(domainPdfTransform('https://example.com/article')).toBeNull();
  });

  it('returns null for openreview non-forum paths', () => {
    expect(domainPdfTransform('https://openreview.net/about')).toBeNull();
  });

  it('handles malformed URLs', () => {
    expect(domainPdfTransform('not-a-url')).toBeNull();
  });
});

describe('findPmcUrlFromPubmed', () => {
  it('extracts PMC ID and builds article URL', () => {
    const html = `<a href="/articles/PMC11609310/">Free PMC article</a>`;
    expect(findPmcUrlFromPubmed(html)).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC11609310/');
  });

  it('returns first PMC ID when multiple appear', () => {
    const html = `<a href="/articles/PMC1">x</a><a href="/articles/PMC2">y</a>`;
    expect(findPmcUrlFromPubmed(html)).toBe('https://pmc.ncbi.nlm.nih.gov/articles/PMC1/');
  });

  it('returns null when no PMC reference', () => {
    expect(findPmcUrlFromPubmed('<html></html>')).toBeNull();
  });
});

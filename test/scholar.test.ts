import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  assertScholarParseCoverage,
  classifyScholarBlock,
  parseScholarResultsInBrowser,
} from '../src/scholar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture() {
  const html = readFileSync(resolve(__dirname, 'fixtures', 'scholar-results.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://scholar.google.com/scholar?q=transformers' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('URL', dom.window.URL);
}

afterEach(() => vi.unstubAllGlobals());

describe('parseScholarResultsInBrowser', () => {
  it('parses paper metadata and Scholar action links', () => {
    loadFixture();
    const [paper] = parseScholarResultsInBrowser({ limit: 10 });

    expect(paper).toMatchObject({
      rank: 1,
      title: 'Attention is all you need',
      url: 'https://example.org/paper-1',
      authors: 'A Vaswani, N Shazeer, N Parmar',
      publication: 'Advances in Neural Information Processing Systems',
      year: 2017,
      source: 'proceedings.neurips.cc',
      snippet: 'Transformer models replace recurrence with attention.',
      cited_by_count: 145321,
      versions_count: 42,
      full_text_url: 'https://example.org/paper-1.pdf',
      scholar_id: 'paper-1',
    });
    expect(paper.cited_by_url).toContain('cites=123456');
    expect(paper.related_articles_url).toContain('related:abc');
    expect(paper.versions_url).toContain('cluster=123456');
  });

  it('keeps citation-only records without inventing a URL', () => {
    loadFixture();
    const paper = parseScholarResultsInBrowser({ limit: 10 })[1];

    expect(paper.title).toBe('A citation-only record');
    expect(paper.url).toBeUndefined();
    expect(paper.year).toBe(2021);
    expect(paper.cited_by_count).toBe(0);
  });

  it('supports the current gs_ggs full-text container and limit', () => {
    loadFixture();
    const papers = parseScholarResultsInBrowser({ limit: 3 });

    expect(papers).toHaveLength(3);
    expect(papers[2]).toMatchObject({
      rank: 3,
      title: 'A current Scholar result',
      full_text_url: 'https://arxiv.org/pdf/2401.00001',
      publication: 'Proceedings of ExampleConf',
      year: 2024,
      source: 'arxiv.org',
    });
    expect(parseScholarResultsInBrowser({ limit: 1 })).toHaveLength(1);
  });
});

describe('classifyScholarBlock', () => {
  it('separates CAPTCHA from Scholar rate limiting', () => {
    expect(classifyScholarBlock(429, '', false)).toBe('rate_limited');
    expect(classifyScholarBlock(200, 'Our systems have detected unusual traffic', false))
      .toBe('rate_limited');
    expect(classifyScholarBlock(200, '\ube44\uc815\uc0c1\uc801\uc778 \ud2b8\ub798\ud53d\uc744 \uac10\uc9c0\ud588\uc2b5\ub2c8\ub2e4', false))
      .toBe('rate_limited');
    expect(classifyScholarBlock(429, '', true)).toBe('captcha');
    expect(classifyScholarBlock(200, 'Scholar results', false)).toBeNull();
  });
});

describe('assertScholarParseCoverage', () => {
  it('accepts complete and empty result containers', () => {
    expect(() => assertScholarParseCoverage(10, 10, 10, true)).not.toThrow();
    expect(() => assertScholarParseCoverage(0, 0, 10, true)).not.toThrow();
  });

  it('rejects partial parsing and missing containers', () => {
    expect(() => assertScholarParseCoverage(10, 3, 10, true)).toThrow(/parsed 3\/10/);
    expect(() => assertScholarParseCoverage(0, 0, 10, false)).toThrow(/container missing/);
  });
});

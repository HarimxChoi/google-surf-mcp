import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseResults } from '../src/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');

function loadDom(html: string) {
  const dom = new JSDOM(html, { url: 'https://www.google.com/search?q=test' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('URL', dom.window.URL);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('parseResults', () => {
  it('parses a basic SERP into title/url/description', () => {
    loadDom(fixture('serp-basic.html'));
    const out = parseResults(10);
    expect(out.results).toHaveLength(3);
    expect(out.results[0]).toMatchObject({
      title: 'Example Article One',
      url: 'https://example.com/article-one',
    });
    expect(out.results[0].description).toContain('First example article snippet');
  });

  it('returns h3Count alongside results for parser-stale detection', () => {
    loadDom(fixture('serp-basic.html'));
    const out = parseResults(10);
    expect(out.h3Count).toBeGreaterThanOrEqual(3);
  });

  it('keeps google.com subdomains, drops bare www/accounts.google.com', () => {
    loadDom(fixture('serp-subdomains.html'));
    const out = parseResults(10);
    const urls = out.results.map(r => r.url);
    expect(urls).toContain('https://cloud.google.com/pricing');
    expect(urls).toContain('https://groups.google.com/g/foo');
    expect(urls).toContain('https://support.google.com/help');
    expect(urls).not.toContain('https://www.google.com/maps');
    expect(urls).not.toContain('https://accounts.google.com/signin');
  });

  it('returns empty results array on a SERP with no result blocks', () => {
    loadDom(fixture('serp-empty.html'));
    const out = parseResults(10);
    expect(out.results).toEqual([]);
    expect(out.h3Count).toBe(0);
  });

  it('filters out sponsored ads (top, bottom, inline)', () => {
    loadDom(fixture('serp-with-ads.html'));
    const out = parseResults(10);
    const urls = out.results.map(r => r.url);
    expect(urls).not.toContain('https://sponsor-top.example.com/ad');
    expect(urls).not.toContain('https://sponsor-bottom.example.com/ad');
    expect(urls).not.toContain('https://sponsor-inline.example.com/ad');
    // organic still present
    expect(urls).toContain('https://organic.example.com/page');
  });
});

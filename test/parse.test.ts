import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseResults, parseResultsInBrowser, STRATEGIES, pickBestAttempt } from '../src/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');

function loadDom(html: string) {
  const dom = new JSDOM(html, { url: 'https://www.google.com/search?q=test' });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('URL', dom.window.URL);
  vi.stubGlobal('window', dom.window);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('parseResults (compat shim)', () => {
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
    expect(urls).toContain('https://organic.example.com/page');
  });
});

describe('parseResultsInBrowser (multi-strategy)', () => {
  it('returns ParseSignals alongside results', () => {
    loadDom(fixture('serp-basic.html'));
    const out = parseResultsInBrowser({ strategy: STRATEGIES[1], max: 10 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.signals).toMatchObject({
      h3Count: expect.any(Number),
      externalLinkCount: expect.any(Number),
      hveidCount: expect.any(Number),
      classTokenSize: expect.any(Number),
      layoutSignature: expect.any(String),
    });
    expect(out.signals.layoutSignature.length).toBeGreaterThan(0);
  });

  it('STRATEGIES has at least 3 entries with unique IDs', () => {
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(3);
    const ids = STRATEGIES.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('STRATEGIES first entry uses data-ved (most stable per SearXNG)', () => {
    expect(STRATEGIES[0].id).toContain('data-ved');
    expect(STRATEGIES[0].blockSelector).toContain('data-ved');
  });

  it('different strategies on same page can yield different result counts', () => {
    loadDom(fixture('serp-basic.html'));
    const attempts = STRATEGIES.map((strategy) => ({
      strategy,
      output: parseResultsInBrowser({ strategy, max: 10 }),
    }));
    expect(attempts.some(a => a.output.results.length > 0)).toBe(true);
  });

  it('layoutSignature is deterministic for same DOM', () => {
    loadDom(fixture('serp-basic.html'));
    const out1 = parseResultsInBrowser({ strategy: STRATEGIES[0], max: 10 });
    const out2 = parseResultsInBrowser({ strategy: STRATEGIES[0], max: 10 });
    expect(out1.signals.layoutSignature).toBe(out2.signals.layoutSignature);
  });
});

describe('pickBestAttempt', () => {
  it('picks attempt with most results', () => {
    const attempts = [
      { strategy: STRATEGIES[0], output: { results: [], signals: {} as any } },
      { strategy: STRATEGIES[1], output: { results: [{ title: 'a', url: 'https://x.com', description: '' }], signals: {} as any } },
      { strategy: STRATEGIES[2], output: { results: [], signals: {} as any } },
    ];
    const best = pickBestAttempt(attempts);
    expect(best.strategy.id).toBe(STRATEGIES[1].id);
  });

  it('handles all-empty attempts (returns first)', () => {
    const attempts = STRATEGIES.map((strategy) => ({
      strategy,
      output: { results: [], signals: {} as any },
    }));
    const best = pickBestAttempt(attempts);
    expect(best.strategy.id).toBe(STRATEGIES[0].id);
  });
});

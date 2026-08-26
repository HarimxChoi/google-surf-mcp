import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseResultsInBrowser, STRATEGIES } from '../src/parse.js';
import { getAdMarker } from '../src/score.js';

// Real google.com/search responses, scripts and styles stripped. The synthetic
// serp-*.html fixtures only contain div.g, which live Google no longer emits.
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
const LIVE = fixture('serp-live.html');
const LIVE_ADS = fixture('serp-live-ads.html');

let dom: JSDOM;
function load(html: string, query: string) {
  dom = new JSDOM(html, { url: `https://www.google.com/search?q=${query}` });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('URL', dom.window.URL);
  vi.stubGlobal('window', dom.window);
}
const loadLive = () => load(LIVE, 'github+actions');
const loadLiveAds = () => load(LIVE_ADS, 'vpn');

afterEach(() => { vi.unstubAllGlobals(); });

const byId = (id: string) => {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`missing strategy ${id}`);
  return s;
};

describe('live SERP fixture', () => {
  it('has no div.g, so any strategy relying on it alone would return nothing', () => {
    loadLive();
    expect(document.querySelectorAll('div.g')).toHaveLength(0);
    expect(document.querySelectorAll('div.MjjYud').length).toBeGreaterThan(0);
  });

  it('reports the SERP language google actually served', () => {
    loadLive();
    const out = parseResultsInBrowser({ strategy: byId('class-mjjyud-v1'), max: 10 });
    expect(out.signals.lang).toBe('ko');
  });

  it('every strategy still extracts results from live markup', () => {
    loadLive();
    for (const strategy of STRATEGIES) {
      const out = parseResultsInBrowser({ strategy, max: 10 });
      expect(out.results.length, `${strategy.id} extracted nothing`).toBeGreaterThanOrEqual(5);
      expect(out.results[0].title.length).toBeGreaterThan(0);
      expect(out.results[0].url).toMatch(/^https?:\/\//);
    }
  });

  it('data-ved-anchor over-matches: an order of magnitude more blocks for the same results', () => {
    loadLive();
    const broad = document.querySelectorAll(byId('data-ved-anchor-v1').blockSelector).length;
    const tight = document.querySelectorAll(byId('class-mjjyud-v1').blockSelector).length;
    expect(broad).toBeGreaterThan(tight * 5);
  });

  it('skips google-owned hosts', () => {
    loadLive();
    const out = parseResultsInBrowser({ strategy: byId('class-mjjyud-v1'), max: 10 });
    for (const r of out.results) {
      expect(new URL(r.url).hostname).not.toBe('www.google.com');
    }
  });
});

describe('live SERP fixture with ads', () => {
  it('carries real ad blocks, unlike the ad-free capture', () => {
    loadLiveAds();
    const adLinks = document.querySelectorAll('#tads a[href^="http"]');
    expect(adLinks.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('[data-text-ad]').length).toBeGreaterThan(0);
  });

  it('drops ad blocks before scoring, because they carry no h3', () => {
    loadLiveAds();
    const adHrefs = new Set(
      Array.from(document.querySelectorAll('#tads a[href^="http"]'))
        .map((a) => (a as HTMLAnchorElement).href),
    );
    const out = parseResultsInBrowser({ strategy: byId('class-mjjyud-v1'), max: 10 });
    expect(out.results.length).toBeGreaterThanOrEqual(5);
    for (const r of out.results) expect(adHrefs.has(r.url)).toBe(false);
  });

  it('keeps organic Korean results whose text merely mentions the ad term', () => {
    loadLiveAds();
    const out = parseResultsInBrowser({ strategy: byId('class-mjjyud-v1'), max: 10 });
    const marker = getAdMarker(out.signals.lang);
    const mentions = out.results.filter((r) => /\uAD11\uACE0/.test(r.title) || /\uAD11\uACE0/.test(r.description));
    expect(mentions.length).toBeGreaterThan(0);
    for (const r of mentions) {
      expect(marker.test(r.title) || marker.test(r.description)).toBe(false);
    }
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  verifyResultsGeometricInBrowser,
  aggregateConfidence,
  isStale,
  regionStats,
} from '../src/verify.js';

// jsdom returns zeroed rects; patch the prototype to inject synthetic coords.

interface RectOverride { x: number; y: number; w: number; h: number }

function loadDomWithRects(
  html: string,
  rectMap: Map<string, RectOverride>,
  viewportWidth = 1366,
) {
  const dom = new JSDOM(html, { url: 'https://www.google.com/search?q=test' });
  const doc = dom.window.document;

  // selector → rect override
  const origGetBCR = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function () {
    for (const [selector, rect] of rectMap.entries()) {
      try {
        if (this.matches(selector) || (this as Element).closest(selector) === this) {
          return {
            x: rect.x, y: rect.y, width: rect.w, height: rect.h,
            left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h,
            toJSON: () => ({}),
          } as DOMRect;
        }
      } catch { /* invalid selector or matches issue */ }
    }
    return origGetBCR.call(this);
  };

  // window.innerWidth
  Object.defineProperty(dom.window, 'innerWidth', { value: viewportWidth, writable: true });

  vi.stubGlobal('document', doc);
  vi.stubGlobal('URL', dom.window.URL);
  vi.stubGlobal('window', dom.window);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('verifyResultsGeometricInBrowser', () => {
  it('marks organic-region blocks with high confidence', () => {
    const html = `<html><body>
      <div class="result" id="r1"><h3>Title 1</h3><a href="https://example.com/a">link</a><span>desc</span></div>
      <div class="result" id="r2"><h3>Title 2</h3><a href="https://example.com/b">link</a></div>
    </body></html>`;
    const rects = new Map<string, RectOverride>([
      ['#r1', { x: 100, y: 200, w: 600, h: 80 }],
      ['#r2', { x: 100, y: 300, w: 600, h: 80 }],
    ]);
    loadDomWithRects(html, rects);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.result' });
    expect(v).toHaveLength(2);
    expect(v[0].signals.inOrganicRegion).toBe(true);
    expect(v[0].signals.hasH3).toBe(true);
    expect(v[0].signals.hasExternalLink).toBe(true);
    expect(v[0].confidence).toBeGreaterThan(0.5);
  });

  it('rejects ad-region overlap', () => {
    const html = `<html><body>
      <div id="tads"><div class="result" id="ad1"><h3>Ad</h3><a href="https://ad.com">link</a></div></div>
    </body></html>`;
    const rects = new Map<string, RectOverride>([
      ['#tads', { x: 100, y: 100, w: 600, h: 200 }],
      ['#ad1', { x: 100, y: 150, w: 600, h: 80 }],
    ]);
    loadDomWithRects(html, rects);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.result' });
    expect(v[0].signals.overlapsAdRegion).toBe(true);
    expect(v[0].confidence).toBeLessThan(0.5);
  });

  it('rejects right sidebar overlap (knowledge_panel detection)', () => {
    const html = `<html><body>
      <div id="rhs"><div class="kp-card"><h3>KP</h3><a href="https://wiki.org">link</a></div></div>
    </body></html>`;
    const rects = new Map<string, RectOverride>([
      ['#rhs', { x: 1000, y: 200, w: 300, h: 400 }],
      ['.kp-card', { x: 1010, y: 220, w: 280, h: 100 }],
    ]);
    loadDomWithRects(html, rects);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.kp-card' });
    expect(v[0].signals.overlapsRightSidebar).toBe(true);
    expect(v[0].confidence).toBeLessThan(0.7);
  });

  it('detects missing h3 (likely not organic result)', () => {
    const html = `<html><body>
      <div class="result" id="r1"><a href="https://x.com">link</a><span>desc only</span></div>
    </body></html>`;
    const rects = new Map<string, RectOverride>([
      ['#r1', { x: 100, y: 300, w: 600, h: 50 }],
    ]);
    loadDomWithRects(html, rects);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.result' });
    expect(v[0].signals.hasH3).toBe(false);
  });

  it('marks google.com internal links as not external', () => {
    const html = `<html><body>
      <div class="result" id="r1"><h3>Internal</h3><a href="https://www.google.com/maps">link</a></div>
    </body></html>`;
    const rects = new Map<string, RectOverride>([
      ['#r1', { x: 100, y: 300, w: 600, h: 80 }],
    ]);
    loadDomWithRects(html, rects);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.result' });
    expect(v[0].signals.hasExternalLink).toBe(false);
  });

  it('viewport-relative thresholds work for different viewports', () => {
    const html = `<html><body>
      <div class="result" id="r1"><h3>T</h3><a href="https://x.com">link</a></div>
    </body></html>`;
    // Same absolute coord becomes sidebar in a smaller viewport.
    const rects = new Map<string, RectOverride>([
      ['#r1', { x: 700, y: 300, w: 300, h: 80 }],
    ]);
    loadDomWithRects(html, rects, 1024);

    const v = verifyResultsGeometricInBrowser({ blockSelector: '.result' });
    // x=700 / 1024 = 0.68 > organicLeftRatio default 0.65
    expect(v[0].signals.inOrganicRegion).toBe(false);
  });
});

describe('aggregateConfidence', () => {
  it('returns 0 for empty', () => {
    expect(aggregateConfidence([])).toBe(0);
  });

  it('computes mean confidence', () => {
    const verifs = [
      { confidence: 0.9 } as any,
      { confidence: 0.5 } as any,
      { confidence: 0.7 } as any,
    ];
    expect(aggregateConfidence(verifs)).toBeCloseTo(0.7, 2);
  });
});

describe('isStale', () => {
  it('returns true on empty (no blocks at all)', () => {
    expect(isStale([])).toBe(true);
  });

  it('returns true when aggregate < threshold', () => {
    const verifs = [{ confidence: 0.3 }, { confidence: 0.2 }] as any[];
    expect(isStale(verifs, 0.5)).toBe(true);
  });

  it('returns false when aggregate >= threshold', () => {
    const verifs = [{ confidence: 0.8 }, { confidence: 0.9 }] as any[];
    expect(isStale(verifs, 0.5)).toBe(false);
  });
});

describe('regionStats (drift forecasting input)', () => {
  it('computes ratio of each region signal', () => {
    const verifs = [
      { signals: { inOrganicRegion: true, overlapsAdRegion: false, overlapsRightSidebar: false } },
      { signals: { inOrganicRegion: true, overlapsAdRegion: false, overlapsRightSidebar: false } },
      { signals: { inOrganicRegion: false, overlapsAdRegion: true, overlapsRightSidebar: false } },
      { signals: { inOrganicRegion: false, overlapsAdRegion: false, overlapsRightSidebar: true } },
    ] as any[];
    const stats = regionStats(verifs);
    expect(stats.organicRatio).toBe(0.5);
    expect(stats.adOverlapRatio).toBe(0.25);
    expect(stats.sidebarOverlapRatio).toBe(0.25);
  });

  it('returns 0s for empty', () => {
    expect(regionStats([])).toEqual({ organicRatio: 0, adOverlapRatio: 0, sidebarOverlapRatio: 0 });
  });
});

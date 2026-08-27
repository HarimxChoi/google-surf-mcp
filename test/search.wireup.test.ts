import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { pickAndScoreResults } from '../src/search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');
const loadFixture = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), 'utf-8');

let ctx: BrowserContext;
let page: Page;

beforeAll(async () => {
  ctx = await chromium.launchPersistentContext('/tmp/wireup-vitest-profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  page = await ctx.newPage();
}, 30_000);

afterAll(async () => {
  await ctx?.close().catch(() => {});
});

describe('wire-up: pickAndScoreResults', () => {
  it('returns kept results for serp-basic.html (organic+unknown)', async () => {
    await page.setContent(loadFixture('serp-basic.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.results).toHaveLength(3);
    expect(outcome.results.map((r) => r.title)).toEqual([
      'Example Article One',
      'Other Page Two',
      'Documentation Guide',
    ]);
    expect(outcome.dropped).toBe(0);
    expect(outcome.dropped_reasons).toEqual([]);
  });

  it('drops sponsored results (serp-with-ads.html)', async () => {
    await page.setContent(loadFixture('serp-with-ads.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    for (const r of outcome.results) {
      expect(r.url).not.toMatch(/sponsor-(top|inline|bottom)/);
    }
  });

  it('returns 3 results for serp-subdomains.html', async () => {
    await page.setContent(loadFixture('serp-subdomains.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.results).toHaveLength(3);
  });

  it('resolves opaque /goto result links from the current data-snc layout', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://modelcontextprotocol.io/docs/getting-started/intro' },
    })) as typeof fetch;
    try {
      await page.setContent(loadFixture('serp-live-goto.html'), { waitUntil: 'domcontentloaded' });
      const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
      expect(outcome.results).toEqual([expect.objectContaining({
        title: 'Model Context Protocol',
        url: 'https://modelcontextprotocol.io/docs/getting-started/intro',
      })]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns empty results for serp-empty.html without throwing', async () => {
    await page.setContent(loadFixture('serp-empty.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.results).toEqual([]);
    expect(outcome.dropped).toBe(0);
  });

  // Google serves Korean by IP even when we ask for en-US. The organic result
  // uses the ad term as ordinary vocabulary; only the ad carries it as a label.
  const koSerp = `
    <!DOCTYPE html>
    <html lang="ko"><body>
      <div id="search">
        <div class="MjjYud">
          <a href="https://ad.example.com/x"><h3>\uAD11\uACE0 · ad.example.com</h3></a>
          <div class="VwiC3b">This sponsored description is long enough to pass the threshold.</div>
        </div>
        <div class="MjjYud">
          <a href="https://organic.example.com/y"><h3>\uAD11\uACE0 \uC5C6\uB294 \uBB34\uB8CC VPN \uCD94\uCC9C</h3></a>
          <div class="VwiC3b">This organic result description is long enough to pass the threshold.</div>
        </div>
      </div>
    </body></html>`;

  it('picks ad markers from the SERP language, not the configured locale', async () => {
    await page.setContent(koSerp, { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.results.map((r) => r.url)).toEqual(['https://organic.example.com/y']);
    expect(outcome.dropped_reasons).toContain('sponsored');
  });

  it('keeps an organic result that merely mentions the Korean ad term', async () => {
    await page.setContent(koSerp, { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'ko-KR' });
    expect(outcome.results.map((r) => r.title)).toContain('\uAD11\uACE0 \uC5C6\uB294 \uBB34\uB8CC VPN \uCD94\uCC9C');
  });

  // The leader finds one result, the peer finds five: broken but never empty.
  it('flags partial degradation when a peer strategy finds far more', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `
      <div data-hveid="h${i}" jscontroller="c${i}">
        <a href="https://peer.example.com/${i}"><h3>Peer Result ${i}</h3></a>
        <div class="VwiC3b">peer snippet long enough to pass the description threshold</div>
      </div>`).join('');
    const html = `
      <!DOCTYPE html>
      <html><body><div id="search">
        <div class="MjjYud">
          <a href="https://leader.example.com/only"><h3>Leader Result</h3></a>
          <div class="VwiC3b">leader snippet long enough to pass the description threshold</div>
        </div>
        ${rows}
      </div></body></html>`;
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.degraded_reasons).toContain('peer_strategy_outperforms');
  });

  it('reports no degradation on a plain healthy page', async () => {
    await page.setContent(loadFixture('serp-basic.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.degraded_reasons).toBeUndefined();
  });

  it('aligns verify entries with filtered results when ads precede organics', async () => {
    const html = `
      <!DOCTYPE html>
      <html><head><style>
        body { margin: 0; padding: 0; }
        #search { position: relative; width: 800px; }
        #tads { position: absolute; top: 0; left: 100px; width: 600px; height: 100px; }
        .top-ad { position: absolute; top: 0; left: 100px; width: 600px; height: 100px; }
        .organic { position: absolute; top: 300px; left: 100px; width: 600px; height: 100px; }
      </style></head>
      <body>
        <div id="search">
          <div id="tads">
            <div class="g top-ad">
              <a href="https://sponsor.example.com/x"><h3>Sponsored Result</h3></a>
              <div class="VwiC3b">ad snippet</div>
            </div>
          </div>
          <div class="g organic">
            <a href="https://organic.example.com/y"><h3>Organic Result</h3></a>
            <div class="VwiC3b">organic snippet long enough to pass the description threshold</div>
          </div>
        </div>
      </body></html>`;
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].title).toBe('Organic Result');
    expect(outcome.results[0].url).toBe('https://organic.example.com/y');
  });
});

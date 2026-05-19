import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { pickAndScoreResults } from '../src/search.js';
import { STRATEGIES } from '../src/parse.js';
import { StrategyHealing, _resetStrategyHealing } from '../src/strategyHealing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures');
const loadFixture = (name: string) => readFileSync(resolve(FIXTURE_DIR, name), 'utf-8');

let ctx: BrowserContext;
let page: Page;

beforeAll(async () => {
  ctx = await chromium.launchPersistentContext('/tmp/healing-vitest-profile', {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  page = await ctx.newPage();
}, 30_000);

afterAll(async () => {
  await ctx?.close().catch(() => {});
});

describe('integration: search wires through StrategyHealing', () => {
  let healDir: string;
  let healFile: string;

  beforeEach(() => {
    healDir = mkdtempSync(join(tmpdir(), 'heal-int-'));
    healFile = join(healDir, '.heal', 'strategy-order.json');
  });

  afterEach(() => {
    rmSync(healDir, { recursive: true, force: true });
    _resetStrategyHealing();
  });

  it('records exactly one win + accounts for every strategy on a real SERP', async () => {
    const healing = new StrategyHealing(healFile, true, STRATEGIES.map((s) => s.id), 0);
    await healing.load();

    await page.setContent(loadFixture('serp-basic.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US', healing });

    expect(outcome.results.length).toBeGreaterThan(0);
    const stats = healing.getStats();
    const totalWins = Object.values(stats).reduce((a, s) => a + s.wins, 0);
    expect(totalWins).toBe(1);
    for (const s of Object.values(stats)) {
      expect(s.wins + s.losses + s.zeros).toBeGreaterThan(0);
    }
  });

  it('records zero for every strategy on an empty SERP', async () => {
    const healing = new StrategyHealing(healFile, true, STRATEGIES.map((s) => s.id), 0);
    await healing.load();

    await page.setContent(loadFixture('serp-empty.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US', healing });

    expect(outcome.results).toEqual([]);
    const stats = healing.getStats();
    const totalWins = Object.values(stats).reduce((a, s) => a + s.wins, 0);
    expect(totalWins).toBe(0);
    const totalZeros = Object.values(stats).reduce((a, s) => a + s.zeros, 0);
    expect(totalZeros).toBeGreaterThan(0);
  });

  it('reorders strategy trial sequence after enough wins, persisted across loads', async () => {
    {
      const h = new StrategyHealing(healFile, true, STRATEGIES.map((s) => s.id), 0);
      await h.load();
      for (let i = 0; i < 4; i++) {
        await page.setContent(loadFixture('serp-basic.html'), { waitUntil: 'domcontentloaded' });
        await pickAndScoreResults(page, 10, { locale: 'en-US', healing: h });
      }
      await h.flush();
      h.shutdown();
    }

    expect(existsSync(healFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(healFile, 'utf8'));
    const winnerId = Object.entries(persisted.stats)
      .sort((a, b) => (b[1] as { wins: number }).wins - (a[1] as { wins: number }).wins)[0][0];

    const h2 = new StrategyHealing(healFile, true, STRATEGIES.map((s) => s.id), 0);
    await h2.load();
    const order = h2.getOrderedStrategyIds(STRATEGIES.map((s) => s.id));
    expect(order[0]).toBe(winnerId);
  });

  it('omitting healing leaves STRATEGIES order untouched', async () => {
    const peek = new StrategyHealing(healFile, true, STRATEGIES.map((s) => s.id), 0);
    await peek.load();

    await page.setContent(loadFixture('serp-basic.html'), { waitUntil: 'domcontentloaded' });
    const outcome = await pickAndScoreResults(page, 10, { locale: 'en-US' });

    expect(outcome.results.length).toBeGreaterThan(0);
    expect(Object.keys(peek.getStats())).toHaveLength(0);
  });
});

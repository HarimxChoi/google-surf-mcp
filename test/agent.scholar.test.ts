import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { scholarSearchTool, type Deps } from '../src/agent.js';
import { UnifiedCache } from '../src/cache.js';
import { createCascadeState } from '../src/cascade.js';
import { loadConfig } from '../src/config.js';
import { RateLimiter } from '../src/limiter.js';
import type { ScholarResult } from '../src/scholar.js';
import { StrategyHealing } from '../src/strategyHealing.js';
import { Telemetry } from '../src/telemetry.js';

function makeDeps(root: string): Deps {
  const config = loadConfig({ SURF_PROFILE_ROOT: root });
  return {
    config,
    cache: new UnifiedCache(config.cacheRoot),
    cascade: createCascadeState(),
    limiter: new RateLimiter(config.rateLimitPerMin),
    tel: new Telemetry(config.telemetryRoot, false),
    healing: new StrategyHealing(config.selfHealingFile, false, []),
    acquireSeqCtx: vi.fn(async () => { throw new Error('browser should not be acquired'); }),
    acquirePool: vi.fn(async () => { throw new Error('pool should not be acquired'); }),
    closeSeq: vi.fn(async () => {}),
    resetPool: vi.fn(async () => {}),
    recoverHuman: vi.fn(async () => {}),
    getPoolHealth: () => ({ warmFailures: 0, fallback: false }),
  };
}

describe('scholarSearchTool', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scholar-tool-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns Scholar results from the isolated cache namespace', async () => {
    const deps = makeDeps(root);
    const query = 'attention is all you need';
    const result: ScholarResult = {
      rank: 1,
      title: 'Attention is all you need',
      snippet: 'Transformer paper',
      cited_by_count: 100,
      metadata: 'A Vaswani - NeurIPS, 2017',
    };
    const key = deps.cache.searchKey(query, deps.config.locale, 10);
    await deps.cache.set('scholar', key, {
      results: [result],
      meta: { strategy: 'scholar-v1', stealth_mode: 'off' },
    });

    const out = await scholarSearchTool({ query }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.results).toEqual([result]);
    expect(data.meta.cache).toBe('hit');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });

  it('rejects an empty query before acquiring a browser', async () => {
    const deps = makeDeps(root);
    const out = await scholarSearchTool({ query: '   ' }, deps);

    expect(out.isError).toBe(true);
    expect((out.structuredContent as Record<string, any>).error.code).toBe('INTERNAL');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });

  it('returns a structured cooldown for Scholar 429 responses', async () => {
    const deps = makeDeps(root);
    deps.config.cascadeDisabled = true;
    deps.config.humanlikeMode = 'off';
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.route('https://scholar.google.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<form action="/scholar"><input name="q"></form>',
        });
        return;
      }
      await route.fulfill({
        status: 429,
        contentType: 'text/html',
        body: '<p>Our systems have detected unusual traffic</p>',
      });
    });
    deps.acquireSeqCtx = vi.fn(async () => context);

    try {
      const out = await scholarSearchTool({ query: 'transformers' }, deps);
      const error = (out.structuredContent as Record<string, any>).error;

      expect(out.isError).toBe(true);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retry_after_ms).toBe(15 * 60_000);

      const repeated = await scholarSearchTool({ query: 'different query' }, deps);
      const repeatedError = (repeated.structuredContent as Record<string, any>).error;
      expect(repeatedError.code).toBe('RATE_LIMITED');
      expect(deps.acquireSeqCtx).toHaveBeenCalledTimes(1);
    } finally {
      await browser.close();
    }
  });

  it('does not retry Scholar CAPTCHA through the search cascade', async () => {
    const deps = makeDeps(root);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.route('https://scholar.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<form id="gs_captcha_f"></form>',
      });
    });
    deps.acquireSeqCtx = vi.fn(async () => context);

    try {
      const out = await scholarSearchTool({ query: 'transformers' }, deps);
      const error = (out.structuredContent as Record<string, any>).error;

      expect(out.isError).toBe(true);
      expect(error.code).toBe('CAPTCHA_RECOVER_FAIL');
      expect(error.user_action).toContain('SURF_HEADLESS=false');
      expect(deps.acquireSeqCtx).toHaveBeenCalledTimes(1);
      expect(deps.closeSeq).not.toHaveBeenCalled();
      expect(deps.recoverHuman).not.toHaveBeenCalled();

      const repeated = await scholarSearchTool({ query: 'different query' }, deps);
      const repeatedError = (repeated.structuredContent as Record<string, any>).error;
      expect(repeatedError.code).toBe('RATE_LIMITED');
      expect(repeatedError.retry_after_ms).toBeGreaterThan(0);
      expect(deps.acquireSeqCtx).toHaveBeenCalledTimes(1);
    } finally {
      await browser.close();
    }
  });
});

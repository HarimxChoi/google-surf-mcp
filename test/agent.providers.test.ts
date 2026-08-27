import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scholarSearchTool, searchParallelTool, searchTool, type Deps, type PoolHandle,
} from '../src/agent.js';
import { UnifiedCache } from '../src/cache.js';
import { createCascadeState } from '../src/cascade.js';
import { loadConfig } from '../src/config.js';
import { RateLimiter } from '../src/limiter.js';
import { CaptchaError } from '../src/search.js';
import type { SearchApiHandle } from '../src/searchApi.js';
import type { NativeBrowserHandle } from '../src/nativeBrowser.js';
import { StrategyHealing } from '../src/strategyHealing.js';
import { Telemetry } from '../src/telemetry.js';

function makeDeps(root: string, env: NodeJS.ProcessEnv = {}): Deps {
  const config = loadConfig({ SURF_PROFILE_ROOT: root, ...env });
  return {
    config,
    cache: new UnifiedCache(config.cacheRoot),
    cascade: createCascadeState(),
    limiter: new RateLimiter(config.rateLimitPerMin),
    tel: new Telemetry(config.telemetryRoot, false),
    healing: new StrategyHealing(config.selfHealingFile, false, []),
    acquireSeqCtx: vi.fn(async () => { throw new Error('browser unavailable'); }),
    acquirePool: vi.fn(async () => { throw new Error('pool unavailable'); }),
    closeSeq: vi.fn(async () => {}),
    resetPool: vi.fn(async () => {}),
    recoverHuman: vi.fn(async () => {}),
    getPoolHealth: () => ({ warmFailures: 0, fallback: false }),
  };
}

function fakeSearchApi(): SearchApiHandle {
  return {
    searchGoogle: vi.fn(async (query) => [{
      title: `API ${query}`,
      url: `https://example.com/${encodeURIComponent(query)}`,
      description: 'SearchApi result',
    }]),
    searchScholar: vi.fn(async () => [{
      rank: 1,
      title: 'API paper',
      snippet: 'Scholar result',
      cited_by_count: 10,
      metadata: 'Author - Venue, 2026',
    }]),
  };
}

function fakeNativeBrowser(): NativeBrowserHandle {
  const browser: NativeBrowserHandle = {
    search: vi.fn(async (query) => ({
      results: [{
        title: `Native ${query}`,
        url: `https://native.test/${encodeURIComponent(query)}`,
        description: 'Native Chrome result',
      }],
      dropped: 0,
      dropped_reasons: [],
    })),
    searchMany: vi.fn(async (queries, limit, opts) => await Promise.all(queries.map(async (query) => ({
      query,
      outcome: await browser.search(query, limit, opts),
    })))),
    scholar: vi.fn(async () => [{
      rank: 1,
      title: 'Native paper',
      snippet: 'Scholar result',
      cited_by_count: 20,
      metadata: 'Author - Venue, 2026',
    }]),
    close: vi.fn(async () => {}),
  };
  return browser;
}

describe('provider routing', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'provider-tool-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps browser as the default and never calls SearchApi on browser failure', async () => {
    const deps = makeDeps(root);
    deps.searchApi = fakeSearchApi();

    const out = await searchTool({ query: 'default route' }, deps);

    expect(out.isError).toBe(true);
    expect(deps.searchApi.searchGoogle).not.toHaveBeenCalled();
  });

  it('runs search and Scholar primary modes without acquiring a browser', async () => {
    const deps = makeDeps(root, {
      SURF_SEARCH_PROVIDER: 'searchapi',
      SURF_SCHOLAR_PROVIDER: 'searchapi',
    });
    deps.searchApi = fakeSearchApi();

    const search = await searchTool({ query: 'primary search' }, deps);
    const scholar = await scholarSearchTool({ query: 'primary scholar' }, deps);

    expect((search.structuredContent as Record<string, any>).meta.provider).toBe('searchapi');
    expect((scholar.structuredContent as Record<string, any>).meta.provider).toBe('searchapi');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });

  it('routes search, parallel, and Scholar through native Chrome without legacy contexts', async () => {
    const deps = makeDeps(root);
    deps.nativeBrowser = fakeNativeBrowser();

    const search = await searchTool({ query: 'native search' }, deps);
    const parallel = await searchParallelTool({ queries: ['one', 'two'] }, deps);
    const scholar = await scholarSearchTool({ query: 'native scholar' }, deps);

    expect((search.structuredContent as Record<string, any>).meta.browser_engine).toBe('native');
    expect((parallel.structuredContent as Record<string, any>).meta.browser_engine).toBe('native');
    expect((scholar.structuredContent as Record<string, any>).meta.browser_engine).toBe('native');
    expect(deps.nativeBrowser.search).toHaveBeenCalledTimes(3);
    expect(deps.nativeBrowser.scholar).toHaveBeenCalledTimes(1);
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
    expect(deps.acquirePool).not.toHaveBeenCalled();
  });

  it('accepts 12 parallel queries and rejects larger batches', async () => {
    const deps = makeDeps(root);
    deps.nativeBrowser = fakeNativeBrowser();
    deps.limiter = new RateLimiter(1_000);
    const queries = Array.from({ length: 12 }, (_, index) => `query ${index}`);

    const accepted = await searchParallelTool({ queries }, deps);
    const rejected = await searchParallelTool({ queries: [...queries, 'query 12'] }, deps);

    expect((accepted.structuredContent as Record<string, any>).results).toHaveLength(12);
    expect((rejected.structuredContent as Record<string, any>).error.message)
      .toBe('queries must contain at most 12 items');
    expect(deps.nativeBrowser.search).toHaveBeenCalledTimes(12);
  });

  it('falls back from native Chrome CAPTCHA without acquiring Playwright', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'fallback' });
    deps.searchApi = fakeSearchApi();
    deps.nativeBrowser = fakeNativeBrowser();
    deps.nativeBrowser.search = vi.fn(async () => { throw new CaptchaError('native'); });

    const out = await searchTool({ query: 'native captcha' }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.meta.provider).toBe('searchapi');
    expect(data.meta.fallback_reason).toBe('CAPTCHA_RECOVER_FAIL');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });

  it('falls back directly when the browser profile is unavailable', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'fallback' });
    deps.searchApi = fakeSearchApi();

    const out = await searchTool(
      { query: 'fallback search' },
      deps,
      { browserUnavailable: 'profile missing' },
    );
    const data = out.structuredContent as Record<string, any>;

    expect(data.meta.provider).toBe('searchapi');
    expect(data.meta.fallback_reason).toBe('PROFILE_MISSING');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });

  it('falls back from browser CAPTCHA for search and Scholar', async () => {
    const deps = makeDeps(root, {
      SURF_SEARCH_PROVIDER: 'fallback',
      SURF_SCHOLAR_PROVIDER: 'fallback',
    });
    deps.searchApi = fakeSearchApi();
    deps.acquireSeqCtx = vi.fn(async () => { throw new CaptchaError('captcha'); });

    const search = await searchTool({ query: 'captcha search' }, deps);
    const scholar = await scholarSearchTool({ query: 'captcha scholar' }, deps);

    expect((search.structuredContent as Record<string, any>).meta.fallback_reason)
      .toBe('CAPTCHA_RECOVER_FAIL');
    expect((scholar.structuredContent as Record<string, any>).meta.fallback_reason)
      .toBe('CAPTCHA_RECOVER_FAIL');
    expect(deps.searchApi.searchGoogle).toHaveBeenCalledTimes(1);
    expect(deps.searchApi.searchScholar).toHaveBeenCalledTimes(1);
    expect(deps.recoverHuman).not.toHaveBeenCalled();
  });

  it('supports SearchApi primary for parallel search in cloud mode', async () => {
    const deps = makeDeps(root, {
      SURF_SEARCH_PROVIDER: 'searchapi',
      SURF_CLOUD_MODE: 'true',
    });
    deps.searchApi = fakeSearchApi();

    const out = await searchParallelTool({ queries: ['one', 'two'] }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.results).toHaveLength(2);
    expect(data.meta.provider).toBe('searchapi');
    expect(deps.acquirePool).not.toHaveBeenCalled();
  });

  it('replaces only failed parallel rows in fallback mode', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'fallback' });
    deps.searchApi = fakeSearchApi();
    const pool: PoolHandle = {
      runMany: vi.fn(async () => [
        { query: 'good', results: [{ title: 'Browser', url: 'https://browser.test', description: 'ok' }] },
        { query: 'failed', results: [], error: 'parser stale' },
      ]),
      searchOne: vi.fn(),
      extractOne: vi.fn(),
    };
    deps.acquirePool = vi.fn(async () => pool);
    deps.config.cascadeDisabled = true;

    const out = await searchParallelTool({ queries: ['good', 'failed'] }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.results[0]).toMatchObject({ query: 'good', provider: 'browser' });
    expect(data.results[1]).toMatchObject({ query: 'failed', provider: 'searchapi' });
    expect(deps.searchApi.searchGoogle).toHaveBeenCalledTimes(1);
    expect(deps.searchApi.searchGoogle).toHaveBeenCalledWith('failed', 10, 'en-US');
    expect(data.meta.provider).toBe('mixed');
  });

  it('falls back from pool CAPTCHA without waiting for human recovery', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'fallback' });
    deps.searchApi = fakeSearchApi();
    deps.acquirePool = vi.fn(async () => ({
      runMany: vi.fn(async () => { throw new CaptchaError('captcha'); }),
      searchOne: vi.fn(),
      extractOne: vi.fn(),
    }));

    const out = await searchParallelTool({ queries: ['one', 'two'] }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.meta.provider).toBe('searchapi');
    expect(data.results).toHaveLength(2);
    expect(deps.recoverHuman).not.toHaveBeenCalled();
  });

  it('does not repeat a normal empty browser response', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'fallback' });
    deps.searchApi = fakeSearchApi();
    const pool: PoolHandle = {
      runMany: vi.fn(async () => [{ query: 'empty', results: [] }]),
      searchOne: vi.fn(),
      extractOne: vi.fn(),
    };
    deps.acquirePool = vi.fn(async () => pool);
    deps.config.cascadeDisabled = true;

    const out = await searchParallelTool({ queries: ['empty'] }, deps);
    const data = out.structuredContent as Record<string, any>;

    expect(data.results[0]).toMatchObject({ query: 'empty', provider: 'browser', results: [] });
    expect(deps.searchApi.searchGoogle).not.toHaveBeenCalled();
  });

  it('returns a structured error when an enabled SearchApi mode has no key', async () => {
    const deps = makeDeps(root, { SURF_SEARCH_PROVIDER: 'searchapi' });
    const out = await searchTool({ query: 'missing key' }, deps);
    const error = (out.structuredContent as Record<string, any>).error;

    expect(error.code).toBe('API_KEY_MISSING');
    expect(deps.acquireSeqCtx).not.toHaveBeenCalled();
  });
});

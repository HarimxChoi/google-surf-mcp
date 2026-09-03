import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyParallelSearchExtraction, applySearchExtraction, extractTool, shapeExtractionResponse,
  type Deps, type PoolHandle,
} from '../src/agent.js';
import { UnifiedCache } from '../src/cache.js';
import { createCascadeState } from '../src/cascade.js';
import { loadConfig } from '../src/config.js';
import { RateLimiter } from '../src/limiter.js';
import { formatToolResponse } from '../src/response.js';
import { StrategyHealing } from '../src/strategyHealing.js';
import { Telemetry } from '../src/telemetry.js';

function makeDeps(root: string, pool: PoolHandle): Deps {
  const config = loadConfig({ SURF_PROFILE_ROOT: root });
  return {
    config,
    cache: new UnifiedCache(config.cacheRoot),
    cascade: createCascadeState(),
    limiter: new RateLimiter(config.rateLimitPerMin),
    tel: new Telemetry(config.telemetryRoot, false),
    healing: new StrategyHealing(config.selfHealingFile, false, []),
    acquireSeqCtx: vi.fn(),
    acquirePool: vi.fn(async () => pool),
    closeSeq: vi.fn(async () => {}),
    resetPool: vi.fn(async () => {}),
    recoverHuman: vi.fn(async () => {}),
    getPoolHealth: () => ({ warmFailures: 0, fallback: false }),
  };
}

function makePool(): PoolHandle {
  return {
    runMany: vi.fn(),
    searchOne: vi.fn(),
    extractOne: vi.fn(async (url, maxChars, mode) => ({
      url,
      content: `${mode}:${maxChars}:${url}`,
      extraction_quality: mode === 'full' ? 'full_text' : 'abstract',
    })),
  };
}

describe('integrated search extraction', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'surf-integrated-extract-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not acquire an extraction worker by default', async () => {
    const pool = makePool();
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      query: 'q',
      results: [{ title: 'A', url: 'https://a.test', description: 'a' }],
      elapsed_ms: 10,
    });

    const result = await applySearchExtraction(input, {}, deps);

    expect(result).toBe(input);
    expect(deps.acquirePool).not.toHaveBeenCalled();
  });

  it('extracts only the requested top URLs and isolates failures', async () => {
    const pool = makePool();
    pool.extractOne = vi.fn(async (url) => url.includes('bad')
      ? { url, error: 'blocked' }
      : { url, content: 'body', extraction_quality: 'abstract' });
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      query: 'q',
      results: [
        { title: 'A', url: 'https://a.test', description: 'a' },
        { title: 'B', url: 'https://bad.test', description: 'b' },
        { title: 'C', url: 'https://c.test', description: 'c' },
      ],
      elapsed_ms: 10,
    });

    const result = await applySearchExtraction(input, {
      extract_mode: 'abstract', extract_limit: 2,
    }, deps);
    const rows = result.structuredContent?.results as Array<Record<string, unknown>>;

    expect(pool.extractOne).toHaveBeenCalledTimes(2);
    expect(rows[0].content).toBe('body');
    expect(rows[1].extract_error).toBe('blocked');
    expect(rows[2]).not.toHaveProperty('content');
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.meta).toMatchObject({
      extraction: {
        mode: 'abstract', requested: 2, applied: 2, succeeded: 1, failed: 1,
        skipped: 1, truncated: true, total_chars: 4,
        remaining_urls: ['https://c.test'],
      },
    });
  });

  it('applies one round-robin extraction limit across parallel queries', async () => {
    const pool = makePool();
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      results: [
        { query: 'one', results: [
          { title: 'Shared', url: 'https://shared.test', description: 'shared' },
          { title: 'One second', url: 'https://one.test/2', description: 'one' },
        ] },
        { query: 'two', results: [
          { title: 'Shared again', url: 'https://shared.test#section', description: 'shared' },
          { title: 'Two second', url: 'https://two.test/2', description: 'two' },
        ] },
        { query: 'three', results: [
          { title: 'Three', url: 'https://three.test', description: 'three' },
        ] },
      ],
      elapsed_ms: 20,
    });

    const result = await applyParallelSearchExtraction(input, {
      extract_mode: 'abstract', extract_limit: 2,
    }, deps);
    const groups = result.structuredContent?.results as Array<Record<string, any>>;

    expect(pool.extractOne).toHaveBeenCalledTimes(2);
    expect(pool.extractOne).toHaveBeenCalledWith('https://shared.test', 1500, 'abstract');
    expect(pool.extractOne).toHaveBeenCalledWith('https://three.test', 1500, 'abstract');
    expect(groups[0].results[0].content).toContain('https://shared.test');
    expect(groups[1].results[0].content).toContain('https://shared.test');
    expect(groups[2].results[0].content).toContain('https://three.test');
    expect(groups[0].results[1]).not.toHaveProperty('content');
  });

  it('allows 20 abstract extractions but keeps full extraction at 10', async () => {
    const pool = makePool();
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({ results: [], elapsed_ms: 0 });

    await expect(applyParallelSearchExtraction(input, {
      extract_mode: 'abstract', extract_limit: 20,
    }, deps)).resolves.toBeDefined();
    await expect(applyParallelSearchExtraction(input, {
      extract_mode: 'full', extract_limit: 11,
    }, deps)).rejects.toThrow(
      'extract_limit must be an integer between 1 and 10 for full parallel; received 11',
    );
    expect(deps.acquirePool).not.toHaveBeenCalled();
  });

  it('captures up to 1000000 characters for research storage', async () => {
    const pool = makePool();
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      query: 'q',
      results: [{ title: 'A', url: 'https://a.test', description: 'a' }],
      elapsed_ms: 10,
    });

    await applySearchExtraction(input, { extract_mode: 'full', extract_limit: 1 }, deps);

    expect(pool.extractOne).toHaveBeenCalledWith('https://a.test', 1_000_000, 'full');
  });

  it('keeps extracted document metadata on search results', async () => {
    const pool = makePool();
    pool.extractOne = vi.fn(async (url) => ({
      url,
      content: 'paper body',
      is_pdf: true as const,
      page_count: 12,
      extraction_quality: 'abstract' as const,
      authors: 'Ada Lovelace',
      publication: 'Systems Journal',
      year: 2026,
      doi: '10.1234/example',
      keywords: ['retrieval'],
    }));
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      query: 'q',
      results: [{ title: 'Paper', url: 'https://paper.test', description: 'result' }],
      elapsed_ms: 10,
    });

    const result = await applySearchExtraction(input, {
      extract_mode: 'abstract', extract_limit: 1,
    }, deps);
    const row = (result.structuredContent?.results as Array<Record<string, unknown>>)[0];

    expect(row).toMatchObject({
      title: 'Paper',
      authors: 'Ada Lovelace',
      publication: 'Systems Journal',
      year: 2026,
      doi: '10.1234/example',
      keywords: ['retrieval'],
      page_count: 12,
    });
  });

  it('uses mode-specific capture limits for direct extraction', async () => {
    const pool = makePool();
    const deps = makeDeps(root, pool);

    await extractTool({ url: 'https://abstract.test', mode: 'abstract' }, deps);
    await extractTool({ url: 'https://full.test', mode: 'full' }, deps);

    expect(pool.extractOne).toHaveBeenNthCalledWith(1, 'https://abstract.test', 1_500, 'abstract');
    expect(pool.extractOne).toHaveBeenNthCalledWith(2, 'https://full.test', 1_000_000, 'full');
  });

  it('returns a compact response after retaining extracted character counts', async () => {
    const pool = makePool();
    pool.extractOne = vi.fn(async (url) => ({
      url,
      content: 'x'.repeat(2_000),
      length: 2_000,
      extraction_quality: 'full_text' as const,
    }));
    const deps = makeDeps(root, pool);
    const input = formatToolResponse({
      query: 'q',
      results: [{ title: 'A', url: 'https://a.test', description: 'a' }],
      elapsed_ms: 0,
    });

    const extracted = await applySearchExtraction(input, {
      extract_mode: 'full', extract_limit: 1,
    }, deps);
    const shaped = shapeExtractionResponse(extracted, {}, 'summary');
    const row = (shaped.structuredContent?.results as Array<Record<string, unknown>>)[0];

    expect((row.content as string)).toHaveLength(1_500);
    expect(row.length).toBe(2_000);
    expect(shaped.structuredContent?.meta).toMatchObject({
      extraction: { total_chars: 2_000, response_content: 'summary', truncated: true },
    });
  });

  it('enforces one aggregate response budget across parallel groups', () => {
    const groups = Array.from({ length: 12 }, (_, group) => ({
      query: `query-${group}`,
      results: Array.from({ length: 20 }, (_, rank) => ({
        title: `result-${group}-${rank}`,
        url: `https://example.com/${group}/${rank}`,
        description: 'large description '.repeat(200),
      })),
    }));
    const shaped = shapeExtractionResponse(formatToolResponse({ results: groups }), {}, 'summary');
    const returned = (shaped.structuredContent?.results as Array<Record<string, any>>)
      .reduce((count, group) => count + group.results.length, 0);

    expect(returned).toBe(36);
    expect(JSON.stringify(shaped.structuredContent).length).toBeLessThan(30_000);
    expect(shaped.structuredContent?.meta).toMatchObject({
      response: {
        format: 'bounded_ranked_results',
        returned_results: 36,
        omitted_results: 204,
      },
    });
  });
});

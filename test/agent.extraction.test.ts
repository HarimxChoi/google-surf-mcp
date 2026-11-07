import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyParallelSearchExtraction, applySearchExtraction, extractTool, readCachedExtraction, retainSourceResponse, shapeExtractionResponse,
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

  it('reuses captured bodies without worker startup and rejects mismatched handles', async () => {
    const pool = makePool();
    pool.extractOne = vi.fn(async (url) => ({ url, content: 'Alpha constraint is stable.\nBeta constraint is separate.', extraction_quality: 'full_text' }));
    const deps = makeDeps(root, pool);
    deps.config.researchEnabled = false;
    const first = await extractTool({ url: 'https://example.com/body', max_chars: 200 }, deps);
    const handle = String(first.structuredContent?.body_handle);
    expect(handle).toMatch(/^transient:/);
    const again = await extractTool({ url: 'https://example.com/body', body_handle: handle, query: 'Beta' }, deps);
    expect(again.structuredContent?.meta).toMatchObject({ body_cache: 'hit' });
    expect(pool.extractOne).toHaveBeenCalledTimes(1);
    expect(pool.extractOne).toHaveBeenCalledWith('https://example.com/body', 50_000, 'full');
    const mismatch = await extractTool({ url: 'https://other.test/body', body_handle: handle }, deps);
    expect(mismatch.isError).toBe(true);
    expect(pool.extractOne).toHaveBeenCalledTimes(1);
    await extractTool({ url: 'https://example.com/body', refresh: true }, deps);
    expect(pool.extractOne).toHaveBeenCalledTimes(2);
    expect((await extractTool({ url: 'https://example.com/body', refresh: true, body_handle: handle }, deps)).isError).toBe(true);
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

    expect(row.content).toBeUndefined();
    expect(String(row.description).length).toBeLessThanOrEqual(1_500);
    expect(row.captured_length).toBe(2_000);
    expect(row.length).toBeUndefined();
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

  it('refreshes a source handle when repository preparation replaces the body', () => {
    const deps = makeDeps(root, makePool()), url = 'https://github.com/example/repo';
    const first = retainSourceResponse(formatToolResponse({ url, title: 'Repository', content: 'Original GitHub page.' }), 'full', deps);
    const handle = String(first.structuredContent?.body_handle);
    const unchanged = retainSourceResponse(first, 'full', deps);
    expect(unchanged.structuredContent?.body_handle).toBe(handle);
    const prepared = retainSourceResponse(formatToolResponse({ ...first.structuredContent, content: 'README implementation details.' }), 'full', deps);
    expect(prepared.structuredContent?.body_handle).not.toBe(handle);
    const read = readCachedExtraction({ url, body_handle: String(prepared.structuredContent?.body_handle) }, deps);
    expect(read?.structuredContent?.content).toContain('README implementation details.');
    expect(read?.structuredContent?.content).not.toContain('Original GitHub page.');
  });

  it('does not expose project-local result bodies through the public source cache', () => {
    const deps = makeDeps(root, makePool()), url = 'https://example.org/private-note';
    const result = retainSourceResponse(formatToolResponse({ results: [{ query: 'note', results: [
      { url, content: 'Project-local context.', source_family: 'document', document_id: 'local-id' },
    ] }] }), 'full', deps);
    expect(result.structuredContent?.results).toBeDefined();
    expect(readCachedExtraction({ url }, deps)).toBeUndefined();
  });

  it('references only identical same-source summaries without dropping source receipts', () => {
    const content = 'A source constraint requires one writer and the same host. '.repeat(12);
    const row = { title: 'Constraint', url: 'https://example.org/constraint', content,
      captured_at: '2026-11-06T00:00:00Z', body_expires_at: '2026-11-06T00:05:00Z', body_handle: 'transient:test' };
    const result = shapeExtractionResponse(formatToolResponse({ results: [
      { query: 'constraint host', results: [row] }, { query: 'constraint host', results: [row] },
    ] }), { response_content: 'summary' }, 'summary');
    const groups = result.structuredContent!.results as Array<{ results: Array<Record<string, unknown>> }>;
    const first = groups[0].results[0], second = groups[1].results[0];
    expect(second.description).toBe(''); expect(second.evidence_ref).toBe(first.url);
    expect(first.evidence_ranges).toBeDefined(); expect(first.evidence_spans).toBeUndefined();
    expect(first.captured_hash).toBe(second.captured_hash);
    expect(first.captured_at).toBeUndefined(); expect(first.body_expires_at).toBeUndefined();
    expect(first.body_handle).toBe('transient:test');
    expect(result.structuredContent!.meta).toMatchObject({ response: { omitted_duplicate_chars: expect.any(Number) } });
  });

  it('round-trips compact ranges into a detailed follow-up without losing offsets', () => {
    const source = 'Alpha condition has one writer.\nBeta condition requires the same host.';
    const result = shapeExtractionResponse(formatToolResponse({ query: 'Alpha', results: [{ url: 'https://example.org', content: source }] }), {}, 'summary');
    const row = (result.structuredContent!.results as Array<Record<string, unknown>>)[0];
    const next = shapeExtractionResponse(formatToolResponse({ url: row.url, content: source }), {
      query: 'Beta', exclude_ranges: row.evidence_ranges as Array<[number, number]>,
    }, 'full');
    expect(next.structuredContent!.content).toContain('Beta'); expect(next.structuredContent!.content).not.toContain('Alpha');
    expect(next.structuredContent!.evidence_spans).toBeDefined(); expect(next.structuredContent!.evidence_ranges).toBeUndefined();
    expect(next.structuredContent!.captured_hash).toBe(row.captured_hash);
  });
});

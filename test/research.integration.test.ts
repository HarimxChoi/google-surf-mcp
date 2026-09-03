import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatToolResponse } from '../src/response.js';
import {
  attachReceipt, attachRetrievalMode, compactRankedResults, fuseSearchResponse, localSearchResponse,
} from '../src/research/integration.js';
import {
  runParallelWithResearch, runSearchWithResearch,
} from '../src/research/orchestrator.js';
import { ResearchService } from '../src/research/service.js';

describe('research search integration', () => {
  it('compacts the legacy 12-result memory payload without losing ranked metadata', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      title: `WarpQuant result ${index}`,
      url: `https://example.com/warpquant/${index}`,
      description: `VPTQ Llama result ${index} ${'description '.repeat(80)}`,
      content: `terminal experiment evidence ${index} ${'full body '.repeat(2_000)}`,
      document_id: `document-${index}`,
      retrieval_families: ['bm25', 'vector', 'graph'],
      score: 1 / (index + 1),
    }));
    const compact = compactRankedResults('WarpQuant VPTQ Llama terminal experiment', rows);

    expect(compact).toHaveLength(12);
    expect(compact.every((row) => row.content === undefined)).toBe(true);
    expect(compact.map((row) => row.document_id)).toEqual(rows.map((row) => row.document_id));
    expect(JSON.stringify(compact).length).toBeLessThan(20_000);
  });

  it('caps duplicate cross-family votes and keeps unique live results', () => {
    const live = formatToolResponse({
      query: 'graph',
      results: [
        { title: 'Same', url: 'https://example.com/same', description: 'live same' },
        { title: 'Fresh', url: 'https://example.com/fresh', description: 'fresh live' },
      ],
    });
    const local = [{
      title: 'Same',
      url: 'https://example.com/same',
      description: 'local same',
      content: 'local body',
      document_id: 'same',
      source_family: 'document' as const,
      score: 1,
    }];

    const result = fuseSearchResponse(live, local, 2);
    const rows = result.structuredContent?.results as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.url)).toContain('https://example.com/fresh');
    expect(rows.filter((row) => row.url === 'https://example.com/same')).toHaveLength(1);
  });

  it('adds only the one-line receipt to a search response', () => {
    const result = attachReceipt(localSearchResponse('q', []), {
      project_id: 'inbox',
      stored: 0,
      rag_active: 0,
      rag_inactive: 0,
      excluded: 0,
      summary: 'Project: Inbox | Session: unspecified | Stored: none | Status: ready',
    });

    expect(result.structuredContent?.memory).toBe(
      'Project: Inbox | Session: unspecified | Stored: none | Status: ready',
    );
    expect(result.structuredContent).not.toHaveProperty('receipt');
  });

  it('reports the configured retrieval branch', () => {
    const result = attachRetrievalMode(localSearchResponse('q', []), 'hybrid');

    expect(result.structuredContent?.meta).toMatchObject({ retrieval_mode: 'hybrid' });
  });

  it('returns only bounded summaries after research reranking', async () => {
    const service = new ResearchService({ enabled: false, root: 'unused', endpoint: 'mem://' });
    vi.spyOn(service, 'rerankCandidates').mockImplementation(async (_query, rows) => rows);
    const result = await runSearchWithResearch({
      query: 'needle result',
      limit: 10,
      retrieval_mode: 'hybrid',
    }, service, async () => formatToolResponse({
      query: 'needle result',
      results: [{
        title: 'Result',
        url: 'https://example.com/result',
        description: 'needle summary',
        content: `needle body ${'large payload '.repeat(2_000)}`,
      }],
    }));
    const row = (result.structuredContent?.results as Array<Record<string, unknown>>)[0];

    expect(row.description).toContain('needle');
    expect(String(row.description).length).toBeLessThanOrEqual(1_200);
    expect(row.content).toBeUndefined();
    expect(result.structuredContent?.meta).toMatchObject({ response_format: 'ranked_summaries' });
  });

  it('returns local evidence with a receipt when live search fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-orchestrator-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    try {
      await service.createProject('Fallback', 'fallback');
      await service.capture({
        tool: 'extract',
        project_id: 'fallback',
        payload: {
          title: 'Fallback evidence',
          url: 'https://example.com/fallback',
          content: 'localonlyterm is available without the live provider.',
          extraction_quality: 'full_text',
        },
      });
      const result = await runSearchWithResearch({
        query: 'localonlyterm',
        limit: 10,
        project_id: 'fallback',
        retrieval_mode: 'hybrid',
      }, service, async () => formatToolResponse(null, {
        code: 'PROFILE_MISSING', message: 'browser unavailable', retryable: false,
      }));

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.memory).toContain('Stored:');
      expect(result.structuredContent?.results).toHaveLength(1);
      expect(result.structuredContent?.meta).toMatchObject({ retrieval_mode: 'hybrid' });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps live result order when project_id is omitted', async () => {
    const service = new ResearchService({ enabled: false, root: 'unused', endpoint: 'mem://' });
    const result = await runSearchWithResearch({
      query: 'fresh results',
      limit: 10,
      retrieval_mode: 'hybrid',
    }, service, async () => formatToolResponse({
      query: 'fresh results',
      results: [
        { title: 'First', url: 'https://example.com/first', description: 'first' },
        { title: 'Second', url: 'https://example.com/second', description: 'second' },
      ],
    }));
    const rows = result.structuredContent?.results as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.title)).toEqual(['First', 'Second']);
    expect(result.structuredContent?.memory).toBe('Memory: disabled');
  });

  it('skips project retrieval in live mode while preserving capture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-live-router-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    try {
      await service.createProject('Live router', 'live-router');
      const search = vi.spyOn(service, 'search');
      const result = await runSearchWithResearch({
        query: 'fresh result',
        limit: 10,
        project_id: 'live-router',
        retrieval_mode: 'live',
      }, service, async () => formatToolResponse({
        query: 'fresh result',
        results: [{
          title: 'Fresh',
          url: 'https://example.com/fresh',
          description: 'fresh',
        }],
      }));

      expect(search).not.toHaveBeenCalled();
      expect(result.structuredContent?.results).toHaveLength(1);
      expect(result.structuredContent?.memory).toContain('Stored:');
      expect(result.structuredContent?.meta).toMatchObject({ retrieval_mode: 'live' });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the live branch for both search entry points', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-live-entrypoints-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    try {
      await service.createProject('Live entrypoints', 'live-entrypoints');
      const search = vi.spyOn(service, 'search');
      const live = () => Promise.resolve(formatToolResponse({
        query: 'q',
        results: [{ title: 'Live', url: 'https://example.com/live', description: 'live' }],
      }));
      const single = await runSearchWithResearch({
        query: 'q',
        limit: 10,
        project_id: 'live-entrypoints',
        extract_mode: 'abstract',
        retrieval_mode: 'live',
      }, service, live);
      const parallel = await runParallelWithResearch({
        queries: ['q'],
        limit: 10,
        project_id: 'live-entrypoints',
        extract_mode: 'abstract',
        retrieval_mode: 'live',
      }, service, () => Promise.resolve(formatToolResponse({
        results: [{ query: 'q', results: [{
          title: 'Live', url: 'https://example.com/live', description: 'live',
        }] }],
      })));
      expect(search).not.toHaveBeenCalled();
      expect(single.structuredContent?.meta).toMatchObject({ retrieval_mode: 'live' });
      expect(parallel.structuredContent?.meta).toMatchObject({ retrieval_mode: 'live' });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands live discovery when the first web page only repeats local evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-live-expand-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    try {
      await service.createProject('Live expansion', 'live-expansion');
      await service.capture({
        tool: 'extract',
        project_id: 'live-expansion',
        payload: {
          title: 'Existing evidence',
          url: 'https://example.com/existing',
          content: 'adaptivequery is already stored.',
          extraction_quality: 'full_text',
        },
      });
      const calls: number[] = [];
      const result = await runSearchWithResearch({
        query: 'adaptivequery',
        limit: 10,
        project_id: 'live-expansion',
        retrieval_mode: 'hybrid',
      }, service, async (limit = 10) => {
        calls.push(limit);
        return formatToolResponse({
          query: 'adaptivequery',
          results: limit > 10 ? [
            { title: 'Existing', url: 'https://example.com/existing', description: 'duplicate' },
            { title: 'Fresh one', url: 'https://example.com/fresh-one', description: 'new evidence' },
            { title: 'Fresh two', url: 'https://example.com/fresh-two', description: 'new evidence' },
          ] : [
            { title: 'Existing', url: 'https://example.com/existing', description: 'duplicate' },
          ],
        });
      });
      const urls = (result.structuredContent?.results as Array<{ url: string }>).map((row) => row.url);

      expect(calls).toEqual([10, 20]);
      expect(urls).toContain('https://example.com/fresh-one');
      expect(urls).toContain('https://example.com/fresh-two');
      expect(result.structuredContent?.meta).toMatchObject({ research_rounds: 2 });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns compact prior search context before capturing the current search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-search-context-'));
    const service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    try {
      await service.createProject('Search context', 'search-context');
      await service.capture({
        tool: 'search',
        project_id: 'search-context',
        query: 'graph rag architecture overview',
        payload: {
          results: [{
            title: 'Graph RAG overview',
            url: 'https://example.com/overview',
            description: 'Community summaries and graph retrieval basics.',
          }],
        },
      });

      const result = await runSearchWithResearch({
        query: 'graph rag architecture bottlenecks',
        limit: 10,
        project_id: 'search-context',
        retrieval_mode: 'hybrid',
      }, service, async () => formatToolResponse({
        query: 'graph rag architecture bottlenecks',
        results: [{
          title: 'New bottleneck study',
          url: 'https://example.com/bottlenecks',
          description: 'A new branch.',
        }],
      }));
      const context = result.structuredContent?.research_context as Record<string, any>;

      expect(context.prior_searches).toHaveLength(1);
      expect(context.prior_searches[0]).toMatchObject({
        query: 'graph rag architecture overview',
        relation: 'related',
        results: 1,
      });
      expect(context.prior_searches[0].surface).toContain('Community summaries');
      expect(context.prior_searches[0].query).not.toContain('bottlenecks');
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

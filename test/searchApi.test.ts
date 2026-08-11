import { describe, expect, it, vi } from 'vitest';
import {
  mapSearchApiGoogleResults,
  mapSearchApiScholarResults,
  SearchApiClient,
  SearchApiConfigError,
  SearchApiError,
} from '../src/searchApi.js';

describe('SearchApi mappings', () => {
  it('maps Google organic results to the search schema', () => {
    expect(mapSearchApiGoogleResults({
      organic_results: [
        { title: 'OpenAI', link: 'https://openai.com/', snippet: 'AI research' },
        { title: 'Missing URL' },
      ],
    }, 10)).toEqual([
      { title: 'OpenAI', url: 'https://openai.com/', description: 'AI research' },
    ]);
  });

  it('maps Scholar metadata, links, authors, and resources', () => {
    const [paper] = mapSearchApiScholarResults({
      organic_results: [{
        position: 1,
        title: 'Attention is all you need',
        data_cid: 'abc123',
        link: 'https://example.com/paper',
        publication: 'A Vaswani, N Shazeer - Advances in Neural Information Processing Systems, 2017',
        snippet: 'Transformer architecture',
        authors: [{ name: 'A Vaswani' }, { name: 'N Shazeer' }],
        inline_links: {
          cited_by: { total: 150000, link: 'https://scholar.google.com/citations' },
          versions: { total: 42, link: 'https://scholar.google.com/versions' },
          related_articles_link: 'https://scholar.google.com/related',
        },
        resource: { name: 'PDF', link: 'https://example.com/paper.pdf' },
      }],
    }, 10);

    expect(paper).toMatchObject({
      rank: 1,
      title: 'Attention is all you need',
      authors: 'A Vaswani, N Shazeer',
      publication: 'Advances in Neural Information Processing Systems',
      year: 2017,
      snippet: 'Transformer architecture',
      cited_by_count: 150000,
      versions_count: 42,
      full_text_url: 'https://example.com/paper.pdf',
      scholar_id: 'abc123',
    });
  });
});

describe('SearchApiClient', () => {
  it('uses bearer auth, keeps the key out of the URL, and paginates Google', async () => {
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input.toString());
      const page = Number(url.searchParams.get('page'));
      return new Response(JSON.stringify({
        search_metadata: { status: 'Success' },
        organic_results: Array.from({ length: 10 }, (_, index) => ({
          title: `Result ${page}-${index}`,
          link: `https://example.com/${page}/${index}`,
          snippet: 'Snippet',
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new SearchApiClient('secret-key', fetchFn);

    const results = await client.searchGoogle('OpenAI', 12, 'en-US');

    expect(results).toHaveLength(12);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchFn.mock.calls) {
      expect(input.toString()).not.toContain('secret-key');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-key');
    }
  });

  it('sends Scholar limit and locale', async () => {
    const fetchFn = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input.toString());
      expect(url.searchParams.get('engine')).toBe('google_scholar');
      expect(url.searchParams.get('num')).toBe('3');
      expect(url.searchParams.get('hl')).toBe('ko');
      return new Response(JSON.stringify({
        search_metadata: { status: 'Success' },
        organic_results: [{ position: 1, title: 'Paper', snippet: 'Text' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const results = await new SearchApiClient('key', fetchFn).searchScholar('query', 3, 'ko-KR');
    expect(results[0].title).toBe('Paper');
  });

  it('rejects missing keys and preserves HTTP status', async () => {
    await expect(new SearchApiClient().searchGoogle('query', 1, 'en-US'))
      .rejects.toBeInstanceOf(SearchApiConfigError);

    const fetchFn = vi.fn(async () => new Response(
      JSON.stringify({ error: 'quota exceeded' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    )) as unknown as typeof fetch;
    const error = await new SearchApiClient('key', fetchFn)
      .searchGoogle('query', 1, 'en-US')
      .catch((caught) => caught as SearchApiError);
    expect(error).toBeInstanceOf(SearchApiError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(30_000);
  });
});

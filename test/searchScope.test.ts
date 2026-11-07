import { describe, expect, it } from 'vitest';
import { enforceSearchSiteScope } from '../src/searchScope.js';
import { formatToolResponse } from '../src/response.js';

const rows = ['https://example.org/a', 'https://docs.example.org/b', 'https://notexample.org/c', 'https://example.org.evil.test/d']
  .map(url => ({ title: 'Source', url, description: 'Evidence' }));

describe('explicit search site scope', () => {
  it('keeps the exact host and subdomains before extraction', () => {
    const result = enforceSearchSiteScope(formatToolResponse({ query: 'site:example.org evidence', results: rows }));
    expect(result.structuredContent?.results).toEqual(rows.slice(0, 2));
    expect(result.structuredContent?.meta).toMatchObject({ site_scope: [{ domain: 'example.org', removed: 2 }], degraded_reasons: ['site_scope_mismatch'] });
  });

  it('checks each parallel query independently and reports empty scoped results', () => {
    const result = enforceSearchSiteScope(formatToolResponse({ results: [
      { query: 'site:example.org evidence', results: rows },
      { query: 'site:another.test evidence', results: rows },
      { query: 'ordinary search', results: rows },
    ] }));
    const groups = result.structuredContent?.results as Array<{ results: unknown[] }>;
    expect(groups.map(group => group.results.length)).toEqual([2, 0, 4]);
  });

  it.each(['ordinary search', '"site:example.org" examples', '-site:example.org examples',
    'site:example.org OR other', '(site:example.org other)', 'site:example.org site:another.test',
    'site:example.org/docs reference', 'site:example.org:8080 reference'])('does not reinterpret an unsupported query: %s', query => {
    const response = formatToolResponse({ query, results: rows });
    expect(enforceSearchSiteScope(response)).toBe(response);
  });

  it('normalizes case, trailing dots and international domain names', () => {
    const result = enforceSearchSiteScope(formatToolResponse({ query: 'SITE:https://BÜCHER.example./ books', results: [
      { url: 'https://xn--bcher-kva.example/book' }, { url: 'https://example.org/book' },
    ] }));
    expect(result.structuredContent?.results).toEqual([{ url: 'https://xn--bcher-kva.example/book' }]);
  });

  it('preserves provider errors and matching results unchanged', () => {
    const response = formatToolResponse({ query: 'site:example.org', results: rows.slice(0, 2) });
    expect(enforceSearchSiteScope(response)).toBe(response);
    const error = formatToolResponse(null, { code: 'INTERNAL', message: 'unavailable', retryable: false });
    expect(enforceSearchSiteScope(error)).toBe(error);
  });

  it('recovers only explicit same-domain references without another search',()=>{
    const response=enforceSearchSiteScope(formatToolResponse({ query:'site:example.org license', results:[
      { url:'https://other.test/thread', title:'Discussion', description:'Source: https://example.org/license. Also https://example.org.evil.test/' },
    ] }));
    expect(response.structuredContent?.results).toEqual([{ title:'Referenced source: /license',url:'https://example.org/license',description:'',discovery:'serp_reference',discovered_from:'https://other.test/thread' }]);
    expect(response.structuredContent?.meta).toMatchObject({ site_scope:[{ recovered_references:1,removed:1 }] });
  });

  it('does not invent a source or bypass an excluded site for recovery',()=>{
    const response=enforceSearchSiteScope(formatToolResponse({ query:'site:example.org -site:sub.example.org policy',results:[
      { url:'https://other.test',description:'https://sub.example.org/private' },
    ] }));
    expect(response.structuredContent?.results).toEqual([]);
  });
});

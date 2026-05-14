import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedCache, _resetCache, getCache } from '../src/cache.js';

describe('UnifiedCache', () => {
  let tmpDir: string;
  let cache: UnifiedCache;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'surf-cache-test-'));
    cache = new UnifiedCache(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _resetCache();
  });

  it('returns null on cache miss', async () => {
    expect(await cache.get('search', 'nonexistent')).toBeNull();
  });

  it('stores and retrieves a value', async () => {
    await cache.set('search', 'k1', { results: ['a', 'b'] });
    const got = await cache.get<{ results: string[] }>('search', 'k1');
    expect(got).toEqual({ results: ['a', 'b'] });
  });

  it('isolates namespaces', async () => {
    await cache.set('search', 'shared-key', 'search-value');
    await cache.set('extract', 'shared-key', 'extract-value');
    expect(await cache.get('search', 'shared-key')).toBe('search-value');
    expect(await cache.get('extract', 'shared-key')).toBe('extract-value');
  });

  it('respects TTL (lazy eviction on read)', async () => {
    await cache.set('search', 'expires-soon', 'value', 50);
    expect(await cache.get('search', 'expires-soon')).toBe('value');
    await new Promise(r => setTimeout(r, 100));
    expect(await cache.get('search', 'expires-soon')).toBeNull();
  });

  it('null TTL means never expire', async () => {
    await cache.set('fingerprint', 'forever', 'value', null);
    await new Promise(r => setTimeout(r, 50));
    expect(await cache.get('fingerprint', 'forever')).toBe('value');
  });

  it('delete removes the entry', async () => {
    await cache.set('search', 'to-delete', 'v');
    expect(await cache.get('search', 'to-delete')).toBe('v');
    await cache.delete('search', 'to-delete');
    expect(await cache.get('search', 'to-delete')).toBeNull();
  });

  it('clear removes all entries in a namespace', async () => {
    await cache.set('search', 'a', '1');
    await cache.set('search', 'b', '2');
    await cache.set('extract', 'c', '3');
    const cleared = await cache.clear('search');
    expect(cleared).toBe(2);
    expect(await cache.get('search', 'a')).toBeNull();
    expect(await cache.get('search', 'b')).toBeNull();
    expect(await cache.get('extract', 'c')).toBe('3');
  });

  it('size reports entry count per namespace', async () => {
    await cache.set('search', 'a', '1');
    await cache.set('search', 'b', '2');
    await cache.set('search', 'c', '3');
    expect(await cache.size('search')).toBe(3);
    expect(await cache.size('extract')).toBe(0);
  });

  it('atomic write (no partial state on power loss)', async () => {
    // sequential writes shouldn't corrupt
    await Promise.all([
      cache.set('search', 'race1', { v: 1 }),
      cache.set('search', 'race1', { v: 2 }),
      cache.set('search', 'race1', { v: 3 }),
    ]);
    const got = await cache.get<{ v: number }>('search', 'race1');
    // any of the writes may win, but result must parse as valid JSON
    expect(got).not.toBeNull();
    expect([1, 2, 3]).toContain(got!.v);
  });

  it('searchKey helper composes query + locale + limit', () => {
    const k = cache.searchKey('hello world', 'en-US', 10);
    expect(k).toBe('hello world|en-US|10');
  });

  it('getCache singleton returns same instance', () => {
    const c1 = getCache(tmpDir);
    const c2 = getCache(tmpDir);
    expect(c1).toBe(c2);
  });
});

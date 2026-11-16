import { describe, expect, it } from 'vitest';
import { RetrievalReadCache, retrievalBodyBytes } from '../src/research/retrievalReadCache.js';

describe('request-scoped retrieval body cache', () => {
  it('shares in-flight batches and nested scopes without changing requested keys', async () => {
    const cache = new RetrievalReadCache();
    const loads: string[][] = [];
    const load = async (keys: string[]) => {
      loads.push(keys);
      await new Promise<void>(resolve => setImmediate(resolve));
      return new Map(keys.map(key => [key, key.toUpperCase()]));
    };
    await cache.run(async () => {
      const [first, second] = await Promise.all([
        cache.read('body', ['a', 'b', 'a'], load, value => value.length),
        cache.run(() => cache.read('body', ['b', 'c'], load, value => value.length)),
      ]);
      expect([...first]).toEqual([['a', 'A'], ['b', 'B']]);
      expect([...second]).toEqual([['b', 'B'], ['c', 'C']]);
    });
    expect(loads).toEqual([['a', 'b'], ['c']]);
    await cache.run(() => cache.read('body', ['a'], load, value => value.length));
    expect(loads.at(-1)).toEqual(['a']);
  });

  it('keeps concurrent requests and namespaces separate', async () => {
    const cache = new RetrievalReadCache();
    let loads = 0;
    const load = async (keys: string[]) => { loads++; return new Map(keys.map(key => [key, loads])); };
    await Promise.all([cache.run(() => cache.read('a', ['x'], load, () => 1)),
      cache.run(() => cache.read('a', ['x'], load, () => 1))]);
    expect(loads).toBe(2);
    await cache.run(async () => {
      await cache.read('a', ['x'], load, () => 1);
      await cache.read('b', ['x'], load, () => 1);
    });
    expect(loads).toBe(4);
  });

  it('does not retain misses or failed reads', async () => {
    const cache = new RetrievalReadCache();
    let present = false;
    let calls = 0;
    const load = async () => { calls++; return new Map(present ? [['x', 'body']] : []); };
    await cache.run(async () => {
      expect((await cache.read('body', ['x'], load, () => 1)).size).toBe(0);
      present = true;
      expect((await cache.read('body', ['x'], load, () => 1)).get('x')).toBe('body');
      await expect(cache.read('body', ['bad'], async () => { throw new Error('read failed'); }, () => 1)).rejects.toThrow('read failed');
      expect((await cache.read('body', ['bad'], async () => new Map([['bad', 'recovered']]), () => 1)).get('bad')).toBe('recovered');
    });
    expect(calls).toBe(2);
  });

  it('bounds retained bytes and entries without dropping requested values', async () => {
    const cache = new RetrievalReadCache(80, 1);
    const calls: string[][] = [];
    const load = async (keys: string[]) => { calls.push(keys); return new Map(keys.map(key => [key, key.repeat(100)])); };
    await cache.run(async () => {
      expect((await cache.read('body', ['a', 'b'], load, () => 100)).size).toBe(2);
      expect((await cache.read('body', ['a', 'b'], load, () => 100)).size).toBe(2);
    });
    expect(calls).toEqual([['a', 'b'], ['a', 'b']]);
    const entryCache = new RetrievalReadCache(1000, 1);
    calls.length = 0;
    await entryCache.run(async () => {
      await entryCache.read('body', ['a', 'b'], load, () => 1);
      await entryCache.read('body', ['a', 'b'], load, () => 1);
    });
    expect(calls).toEqual([['a', 'b'], ['b']]);
  });

  it('does not allocate a read for empty input and accounts for UTF-16 and metadata', async () => {
    const cache = new RetrievalReadCache();
    expect(await cache.read('body', [], async () => { throw new Error('unexpected read'); }, () => 1)).toEqual(new Map());
    expect(retrievalBodyBytes('abc')).toBe(262);
    expect(retrievalBodyBytes('한글', { page: 1 })).toBeGreaterThan(retrievalBodyBytes('한글'));
  });
});

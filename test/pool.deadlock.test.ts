import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SearchPool } from '../src/pool.js';

const ORIG_WAITER_TIMEOUT = (SearchPool as any).WAITER_TIMEOUT_MS;

describe('SearchPool deadlock prevention', () => {
  beforeEach(() => {
    (SearchPool as any).WAITER_TIMEOUT_MS = 50;
  });
  afterEach(() => {
    (SearchPool as any).WAITER_TIMEOUT_MS = ORIG_WAITER_TIMEOUT;
    vi.useRealTimers();
  });

  it('throws after MAX_REBUILD_FAILURES consecutive rebuild failures', async () => {
    const pool = new SearchPool(2);
    const deadCtx = {
      pages: () => { throw new Error('ctx disposed'); },
      close: async () => {},
    } as never;
    (pool as any).workers = [
      { ctx: deadCtx, busy: false },
      { ctx: deadCtx, busy: false },
    ];
    (pool as any).warmed = true;
    (pool as any).rebuildWorker = async () => { throw new Error('rebuild fail'); };

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<unknown>;

    let lastError: Error | null = null;
    for (let i = 0; i < 6; i++) {
      try { await acquire(); }
      catch (e) { lastError = e as Error; }
    }
    expect(lastError).toBeInstanceOf(Error);
    expect(lastError!.message).toMatch(/rebuild failure/);
  });

  it('waiter rejects with timeout when no worker frees up', async () => {
    const pool = new SearchPool(1);
    const aliveCtx = { pages: () => [], close: async () => {} } as never;
    (pool as any).workers = [{ ctx: aliveCtx, busy: false }];
    (pool as any).warmed = true;

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<unknown>;

    await acquire();
    const queued = acquire();
    let rejected: Error | null = null;
    queued.catch((e: Error) => { rejected = e; });

    await new Promise(r => setTimeout(r, 150));

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toMatch(/waiter timeout/);
    expect((pool as any).waiters.length).toBe(0);
  });

  it('rebuildFailureCount resets after a successful rebuild', async () => {
    const pool = new SearchPool(1);
    const deadCtx = {
      pages: () => { throw new Error('disposed'); },
      close: async () => {},
    } as never;
    (pool as any).workers = [{ ctx: deadCtx, busy: false }];
    (pool as any).warmed = true;

    let rebuildCallCount = 0;
    (pool as any).rebuildWorker = async () => {
      rebuildCallCount++;
      if (rebuildCallCount <= 2) throw new Error('rebuild fail');
      return { ctx: { pages: () => [], close: async () => {} }, busy: false };
    };

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<unknown>;

    let acquiredOk = 0;
    for (let i = 0; i < 5; i++) {
      try { await acquire(); acquiredOk++; }
      catch { /* waiter timeout */ }
    }
    expect(acquiredOk).toBeGreaterThan(0);
    expect((pool as any).rebuildFailureCount).toBe(0);
  });
});

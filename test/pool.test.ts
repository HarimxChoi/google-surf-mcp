import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserContext } from 'playwright';
import { SearchPool, wireWorkerDeadOnClose } from '../src/pool.js';

// no real chrome; mocks worker objects directly
describe('SearchPool acquire/release queue', () => {
  it('queues acquires when all workers are busy and unblocks on release', async () => {
    const pool = new SearchPool(2);
    // mock ctx must satisfy isContextAlive() → ctx.pages() returns array
    const fakeCtx = { pages: () => [], close: async () => {} } as never;
    (pool as any).workers = [
      { ctx: fakeCtx, busy: false },
      { ctx: fakeCtx, busy: false },
    ];
    (pool as any).warmed = true;

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<any>;
    const release = (pool as any).release.bind(pool) as (w: any) => void;

    const w1 = await acquire();
    const w2 = await acquire();
    expect(w1.busy).toBe(true);
    expect(w2.busy).toBe(true);

    let thirdResolved = false;
    const thirdPromise = acquire().then(w => { thirdResolved = true; return w; });
    await new Promise(r => setTimeout(r, 30));
    expect(thirdResolved).toBe(false);

    release(w1);
    const third = await thirdPromise;
    expect(thirdResolved).toBe(true);
    expect(third).toBe(w1);
    expect(third.busy).toBe(true);
  });

  it('rejects pending waiters when pool closes', async () => {
    const pool = new SearchPool(1);
    const fakeCtx = { pages: () => [], close: async () => {} } as never;
    (pool as any).workers = [{ ctx: fakeCtx, busy: false }];
    (pool as any).warmed = true;

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<any>;

    // hold the only worker
    await acquire();
    // queue a second acquire that waits
    const queued = acquire();
    let rejected: Error | null = null;
    queued.catch(e => { rejected = e; });

    await new Promise(r => setTimeout(r, 20));
    await pool.close();
    await new Promise(r => setTimeout(r, 20));

    expect(rejected).toBeInstanceOf(Error);
    expect(rejected!.message).toMatch(/pool closed/);
  });

  it('throws when acquire is called after close', async () => {
    const pool = new SearchPool(1);
    const fakeCtx = { pages: () => [], close: async () => {} } as never;
    (pool as any).workers = [{ ctx: fakeCtx, busy: false }];
    (pool as any).warmed = true;

    await pool.close();

    const acquire = (pool as any).acquire.bind(pool) as () => Promise<any>;
    await expect(acquire()).rejects.toThrow(/pool closing/);
  });
});

describe('wireWorkerDeadOnClose', () => {
  it('marks worker dead when its ctx emits close', () => {
    const ctx = new EventEmitter() as unknown as BrowserContext;
    const w = { ctx, busy: false, dead: false };
    wireWorkerDeadOnClose(w);
    expect(w.dead).toBe(false);
    (ctx as unknown as EventEmitter).emit('close');
    expect(w.dead).toBe(true);
  });

  it('only marks once even on multiple close emits', () => {
    const ctx = new EventEmitter() as unknown as BrowserContext;
    const w = { ctx, busy: false, dead: false };
    wireWorkerDeadOnClose(w);
    (ctx as unknown as EventEmitter).emit('close');
    w.dead = false;
    (ctx as unknown as EventEmitter).emit('close');
    expect(w.dead).toBe(false);
  });
});

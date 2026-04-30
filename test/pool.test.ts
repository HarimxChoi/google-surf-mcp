import { describe, it, expect } from 'vitest';
import { SearchPool } from '../src/pool.js';

// Probe the pool's promise-queue acquire/release without launching real Chrome.
// Pre-populate fake workers and call private methods through `as any`.
describe('SearchPool acquire/release queue', () => {
  it('queues acquires when all workers are busy and unblocks on release', async () => {
    const pool = new SearchPool(2);
    const fakeCtx = {} as never;
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
});

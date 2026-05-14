import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, RateLimitedError } from '../src/limiter.js';

describe('RateLimiter', () => {
  it('grants up to perMin immediately', async () => {
    const rl = new RateLimiter(3);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(rl.recentCount).toBe(3);
    expect(rl.queueSize).toBe(0);
  });

  it('queues requests beyond perMin', async () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(2, 70_000);
    await rl.acquire();
    await rl.acquire();
    let granted = false;
    const p = rl.acquire().then(() => { granted = true; });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(rl.queueSize).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    await p;
    expect(granted).toBe(true);
    expect(rl.queueSize).toBe(0);
    vi.useRealTimers();
  });

  it('grants queued requests once the sliding window clears', async () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(2, 200_000);
    await rl.acquire();
    await rl.acquire();
    const order: number[] = [];
    const a = rl.acquire().then(() => order.push(1));
    const b = rl.acquire().then(() => order.push(2));
    await Promise.resolve();
    expect(rl.queueSize).toBe(2);
    await vi.advanceTimersByTimeAsync(61_000);
    await a;
    await b;
    expect(order).toEqual([1, 2]);
    expect(rl.queueSize).toBe(0);
    vi.useRealTimers();
  });

  it('rejects with RateLimitedError when maxWaitMs is exceeded', async () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(1, 1_000);
    await rl.acquire();
    const result = rl.acquire().then(() => 'granted', (e) => e);
    await vi.advanceTimersByTimeAsync(1_100);
    const e = await result;
    expect(e).toBeInstanceOf(RateLimitedError);
    expect((e as RateLimitedError).retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(rl.queueSize).toBe(0);
    vi.useRealTimers();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { withBackoff } from '../src/backoff.js';

const noSleep = async () => {};

describe('withBackoff', () => {
  it('returns immediately on success', async () => {
    const op = vi.fn(async () => 'ok');
    const result = await withBackoff(op, {
      initialMs: 1, maxAttempts: 3, factor: 2, sleep: noSleep,
    });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries until success', async () => {
    let n = 0;
    const op = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error(`fail ${n}`);
      return 'ok';
    });
    const result = await withBackoff(op, {
      initialMs: 1, maxAttempts: 5, factor: 2, sleep: noSleep,
    });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts', async () => {
    const op = vi.fn(async () => { throw new Error('always'); });
    await expect(withBackoff(op, {
      initialMs: 1, maxAttempts: 3, factor: 2, sleep: noSleep,
    })).rejects.toThrow('always');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('respects isRetryable: non-retryable errors propagate immediately', async () => {
    class FatalError extends Error {}
    const op = vi.fn(async () => { throw new FatalError('fatal'); });
    await expect(withBackoff(op, {
      initialMs: 1, maxAttempts: 5, factor: 2, sleep: noSleep,
      isRetryable: (e) => !(e instanceof FatalError),
    })).rejects.toThrow('fatal');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('computes exponential delays with factor', async () => {
    const delays: number[] = [];
    const op = vi.fn(async () => { throw new Error('x'); });
    await expect(withBackoff(op, {
      initialMs: 100, maxAttempts: 4, factor: 2,
      sleep: async (ms) => { delays.push(ms); },
    })).rejects.toThrow('x');
    // 3 retries with delays after attempts 1, 2, 3: 100, 200, 400.
    expect(delays).toEqual([100, 200, 400]);
  });

  it('factor=1 keeps delay constant (IP cooldown pattern)', async () => {
    const delays: number[] = [];
    const op = vi.fn(async () => { throw new Error('blocked'); });
    await expect(withBackoff(op, {
      initialMs: 60_000, maxAttempts: 3, factor: 1,
      sleep: async (ms) => { delays.push(ms); },
    })).rejects.toThrow('blocked');
    expect(delays).toEqual([60_000, 60_000]);
  });

  it('invokes onRetry with attempt number and delay', async () => {
    const calls: Array<{ attempt: number; delayMs: number; err: string }> = [];
    const op = vi.fn(async () => { throw new Error('nope'); });
    await expect(withBackoff(op, {
      initialMs: 10, maxAttempts: 3, factor: 2, sleep: noSleep,
      onRetry: (attempt, delayMs, err) => {
        calls.push({ attempt, delayMs, err: (err as Error).message });
      },
    })).rejects.toThrow('nope');
    expect(calls).toEqual([
      { attempt: 1, delayMs: 10, err: 'nope' },
      { attempt: 2, delayMs: 20, err: 'nope' },
    ]);
  });
});

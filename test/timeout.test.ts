import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../src/timeout.js';

describe('withTimeout', () => {
  it('resolves before timeout without calling cleanup', async () => {
    const cleanup = vi.fn(async () => {});
    const result = await withTimeout(
      Promise.resolve('ok'),
      1000,
      'test',
      cleanup,
    );
    expect(result).toBe('ok');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('rejects with timeout error and calls cleanup when underlying op exceeds ms', async () => {
    const cleanup = vi.fn(async () => {});
    const slowOp = new Promise<string>(resolve => setTimeout(() => resolve('late'), 200));

    await expect(
      withTimeout(slowOp, 50, 'slow', cleanup),
    ).rejects.toThrow(/slow timeout after 50ms/);

    // cleanup must be called synchronously after timeout fires (before throw propagates)
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does NOT call cleanup when underlying op rejects with non-timeout error', async () => {
    const cleanup = vi.fn(async () => {});
    const failingOp = Promise.reject(new Error('domain failure'));

    await expect(
      withTimeout(failingOp, 1000, 'fail', cleanup),
    ).rejects.toThrow(/domain failure/);

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('swallows cleanup errors (does not mask original timeout)', async () => {
    const cleanup = vi.fn(async () => { throw new Error('cleanup-broken'); });
    const slowOp = new Promise<string>(resolve => setTimeout(() => resolve('late'), 200));

    await expect(
      withTimeout(slowOp, 50, 'slow', cleanup),
    ).rejects.toThrow(/slow timeout/);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('works without cleanup parameter', async () => {
    const slowOp = new Promise<string>(resolve => setTimeout(() => resolve('late'), 200));
    await expect(
      withTimeout(slowOp, 50, 'slow'),
    ).rejects.toThrow(/slow timeout/);
  });
});

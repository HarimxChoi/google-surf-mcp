import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock browser.js so the test exercises mutex logic without real Chrome launch.
const launchMock = vi.fn();
const getPageMock = vi.fn();
const closeMock = vi.fn();

vi.mock('../src/browser.js', () => ({
  launch: launchMock,
  getPage: getPageMock,
  PROFILE_MAIN: '/tmp/test-profile',
  isBlocked: (u: string) => u.includes('/sorry/'),
}));

describe('recoverFromCaptcha mutex', () => {
  beforeEach(() => {
    launchMock.mockReset();
    getPageMock.mockReset();
    closeMock.mockReset();
    // closeMock must return a Promise for `await ctx.close().catch(...)` to work
    closeMock.mockResolvedValue(undefined);

    // launch returns ctx with close()
    launchMock.mockImplementation(async () => ({
      close: closeMock,
    }));
    // getPage returns page that immediately reports /search? URL
    // → polling loop exits on first iteration after a 2s sleep
    getPageMock.mockImplementation(async () => ({
      url: () => 'https://www.google.com/search?q=test',
      goto: async () => null,
    }));
  });

  it('two concurrent calls share a single recovery (only one launch)', async () => {
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');

    const [r1, r2] = await Promise.all([
      recoverFromCaptcha({ timeoutMs: 60_000, graceMs: 0 }),
      recoverFromCaptcha({ timeoutMs: 60_000, graceMs: 0 }),
    ]);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(launchMock).toHaveBeenCalledTimes(1);
    // ctx.close() called once for the single launch
    expect(closeMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('sequential calls each get their own launch (mutex cleared after completion)', async () => {
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');

    await recoverFromCaptcha({ timeoutMs: 60_000, graceMs: 0 });
    await recoverFromCaptcha({ timeoutMs: 60_000, graceMs: 0 });

    expect(launchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('swallows ctx.close errors so they do not mask success', async () => {
    closeMock.mockRejectedValueOnce(new Error('ctx already closed'));
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');

    await expect(recoverFromCaptcha({ timeoutMs: 60_000, graceMs: 0 })).resolves.toBeUndefined();
  }, 10_000);
});

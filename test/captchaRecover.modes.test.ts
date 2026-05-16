import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/browser.js', () => ({
  launch: vi.fn(async () => ({
    pages: () => [], newPage: async () => ({
      goto: async () => {}, url: () => 'https://www.google.com/search?q=x',
      bringToFront: async () => {},
    }),
    close: async () => {},
  })),
  getPage: vi.fn(async (ctx: any) => (await ctx.newPage())),
  PROFILE_MAIN: '/tmp/profile-main',
  isBlocked: (u: string) => u.includes('/sorry/'),
}));

vi.mock('../src/notify.js', () => ({
  osNotify: vi.fn(async () => {}),
}));

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.clearAllMocks(); });

describe('recoverFromCaptcha modes', () => {
  it('cloud_fail_fast throws CaptchaError immediately', async () => {
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');
    const { CaptchaError } = await import('../src/search.js');
    await expect(recoverFromCaptcha({ mode: 'cloud_fail_fast' })).rejects.toBeInstanceOf(CaptchaError);
  });

  it('remote_debug emits guidance and throws CaptchaError', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');
    const { CaptchaError } = await import('../src/search.js');
    await expect(recoverFromCaptcha({ mode: 'remote_debug' })).rejects.toBeInstanceOf(CaptchaError);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/DevTools|chrome:\/\/inspect/i);
    errSpy.mockRestore();
  });

  it('notify_spawn invokes osNotify', async () => {
    const notify = await import('../src/notify.js');
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');
    await recoverFromCaptcha({ mode: 'notify_spawn', timeoutMs: 5_000 });
    expect(notify.osNotify).toHaveBeenCalledOnce();
  });

  it('always_headed skips notification but still recovers', async () => {
    const notify = await import('../src/notify.js');
    const { recoverFromCaptcha } = await import('../src/captchaRecover.js');
    await recoverFromCaptcha({ mode: 'always_headed', timeoutMs: 5_000 });
    expect(notify.osNotify).not.toHaveBeenCalled();
  });
});

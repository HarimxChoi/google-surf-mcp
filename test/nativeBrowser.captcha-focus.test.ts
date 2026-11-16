import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { detectBlock } from '../src/browser.js';
import { NativeChromeBrowser } from '../src/nativeBrowser.js';
import { CaptchaError } from '../src/search.js';

function fixture() {
  const page = { isClosed: vi.fn(() => false), url: () => 'https://www.google.com/search?q=test',
    evaluate: vi.fn(async () => false), bringToFront: vi.fn(async () => {}) };
  const guard = { kill: vi.fn(), stdin: { end: vi.fn() } };
  const resumedGuard = { kill: vi.fn(), stdin: { end: vi.fn() } };
  const session = { child: { pid: 4321, exitCode: null }, browser: { isConnected: () => true },
    pages: [page], captchaPage: undefined as typeof page | undefined,
    windowGuard: guard as typeof guard | undefined, dead: false };
  const setWindowState = vi.fn(async () => {});
  const startWindowGuard = vi.fn(async () => resumedGuard as never);
  const browser = new NativeChromeBrowser({ executablePath: 'unused', profileDir: 'unused', setWindowState, startWindowGuard });
  const internal = browser as unknown as { session: typeof session;
    exposeCaptcha: (session: typeof session, page: typeof page) => Promise<void>;
    prepareForSearch: () => Promise<void> };
  internal.session = session;
  return { page, guard, resumedGuard, session, setWindowState, startWindowGuard, internal };
}

describe('native CAPTCHA context ownership', () => {
  it('focuses the challenged tab before maximizing its existing window', async () => {
    const f = fixture();
    await f.internal.exposeCaptcha(f.session, f.page);
    expect(f.page.bringToFront).toHaveBeenCalledOnce();
    expect(f.setWindowState).toHaveBeenCalledWith(4321, 3);
    expect(f.guard.kill).toHaveBeenCalledOnce();
    expect(f.session.captchaPage).toBe(f.page);
  });

  it('keeps the first open CAPTCHA tab when parallel lanes also fail', async () => {
    const f = fixture();
    const second = { ...f.page, bringToFront: vi.fn(async () => {}) };
    await Promise.all([f.internal.exposeCaptcha(f.session, f.page), f.internal.exposeCaptcha(f.session, second)]);
    expect(f.session.captchaPage).toBe(f.page);
    expect(second.bringToFront).not.toHaveBeenCalled();
    expect(f.setWindowState).toHaveBeenCalledOnce();
  });

  it('allows a replacement tab only after the previous CAPTCHA tab closed', async () => {
    const f = fixture();
    await f.internal.exposeCaptcha(f.session, f.page);
    f.page.isClosed.mockReturnValue(true);
    const second = { ...f.page, isClosed: vi.fn(() => false), bringToFront: vi.fn(async () => {}) };
    await f.internal.exposeCaptcha(f.session, second);
    expect(f.session.captchaPage).toBe(second);
    expect(second.bringToFront).toHaveBeenCalledOnce();
  });

  it('keeps the same context blocked until the user clears the challenge', async () => {
    const f = fixture();
    f.session.captchaPage = f.page;
    f.page.evaluate.mockResolvedValue(true);
    await expect(f.internal.prepareForSearch()).rejects.toBeInstanceOf(CaptchaError);
    expect(f.startWindowGuard).not.toHaveBeenCalled();
    expect(f.session.captchaPage).toBe(f.page);
    expect(f.internal.session).toBe(f.session);
  });

  it('does not mistake an unreadable challenge page for successful recovery', async () => {
    const f = fixture();
    f.session.captchaPage = f.page;
    f.page.evaluate.mockRejectedValue(new Error('Execution context was destroyed'));
    await expect(f.internal.prepareForSearch()).rejects.toBeInstanceOf(CaptchaError);
    expect(f.startWindowGuard).not.toHaveBeenCalled();
    expect(f.session.captchaPage).toBe(f.page);
  });

  it('hides the same session and restores its guard only after a clear page', async () => {
    const f = fixture();
    f.session.captchaPage = f.page;
    await f.internal.prepareForSearch();
    expect(f.session.captchaPage).toBeUndefined();
    expect(f.internal.session).toBe(f.session);
    expect(f.resumedGuard.stdin.end).toHaveBeenCalledWith('4321\n');
    expect(f.setWindowState).toHaveBeenCalledWith(4321, 0);
  });
});

describe('strict recovery checks', () => {
  it('preserves permissive triage but propagates failures for recovery decisions', async () => {
    const page = { url: () => 'https://www.google.com/search?q=test',
      evaluate: vi.fn(async () => { throw new Error('unreadable'); }) } as unknown as Page;
    await expect(detectBlock(page)).resolves.toBe(false);
    await expect(detectBlock(page, true)).rejects.toThrow('unreadable');
  });
});

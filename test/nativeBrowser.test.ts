import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleSearchUrl, buildNativeChromeArgs, buildScholarSearchUrl, NativeChromeBrowser,
} from '../src/nativeBrowser.js';
import { CaptchaError } from '../src/search.js';

describe('native Chrome search route', () => {
  const readiness = () => {
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    return native as unknown as { verifyPageAutomationState: (page: never) => Promise<void> };
  };

  it('does not retry a successful automation-state read', async () => {
    const page = { evaluate: vi.fn(async () => false), isClosed: vi.fn(() => false), waitForLoadState: vi.fn() };
    await readiness().verifyPageAutomationState(page as never);
    expect(page.evaluate).toHaveBeenCalledOnce(); expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('rechecks the same page after a navigation destroys its execution context', async () => {
    const page = { evaluate: vi.fn().mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation'))
      .mockResolvedValue(false), isClosed: vi.fn(() => false), waitForLoadState: vi.fn(async () => {}) };
    await readiness().verifyPageAutomationState(page as never);
    expect(page.evaluate).toHaveBeenCalledTimes(2); expect(page.waitForLoadState).toHaveBeenCalledOnce();
  });

  it('retains the failure for an actual exposed automation flag', async () => {
    const page = { evaluate: vi.fn(async () => true), isClosed: vi.fn(() => false), waitForLoadState: vi.fn() };
    await expect(readiness().verifyPageAutomationState(page as never)).rejects.toThrow('exposed navigator.webdriver');
    expect(page.evaluate).toHaveBeenCalledOnce(); expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('preserves closed-page errors instead of misreporting an automation flag', async () => {
    const error = new Error('Target page, context or browser has been closed');
    const page = { evaluate: vi.fn().mockRejectedValue(error), isClosed: vi.fn(() => true), waitForLoadState: vi.fn() };
    await expect(readiness().verifyPageAutomationState(page as never)).rejects.toBe(error);
    expect(page.evaluate).toHaveBeenCalledOnce(); expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it('bounds repeated execution-context failures without relaunching Chrome', async () => {
    const error = new Error('Execution context was destroyed');
    const page = { evaluate: vi.fn().mockRejectedValue(error), isClosed: vi.fn(() => false), waitForLoadState: vi.fn(async () => {}) };
    await expect(readiness().verifyPageAutomationState(page as never)).rejects.toBe(error);
    expect(page.evaluate).toHaveBeenCalledTimes(3); expect(page.waitForLoadState).toHaveBeenCalledTimes(2);
  });

  it('builds direct Google and Scholar URLs without changing operators', () => {
    const google = new URL(buildGoogleSearchUrl('site:github.com filetype:md graph rag', 20, 'ko-KR'));
    const scholar = new URL(buildScholarSearchUrl('graph rag lineage', 10, 'en-US'));

    expect(google.hostname).toBe('www.google.com');
    expect(google.searchParams.get('q')).toBe('site:github.com filetype:md graph rag');
    expect(google.searchParams.get('num')).toBe('20');
    expect(google.searchParams.get('hl')).toBe('ko');
    expect(scholar.hostname).toBe('scholar.google.com');
    expect(scholar.searchParams.get('q')).toBe('graph rag lineage');
    expect(scholar.searchParams.get('hl')).toBe('en');
  });

  it('uses a dedicated profile and fixed local debugging port with minimal flags', () => {
    const args = buildNativeChromeArgs('C:\\surf\\native', 9223, 'https://www.google.com/search?q=test');
    const joined = args.join(' ');

    expect(args).toContain('--user-data-dir=C:\\surf\\native');
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--start-minimized');
    expect(args).toContain('--window-position=-32000,-32000');
    expect(args).toContain('--window-size=1366,768');
    expect(args).not.toContain('--new-window');
    expect(joined).not.toMatch(/headless|no-sandbox|AutomationControlled|enable-automation/i);
  });

  it('rejects port zero', () => {
    expect(() => buildNativeChromeArgs('profile', 0, 'https://www.google.com/'))
      .toThrow('fixed non-zero port');
  });

  it('reuses one native page across sequential searches', async () => {
    let currentUrl = 'https://www.google.com/search?q=one';
    const page = {
      goto: vi.fn(async (url: string) => { currentUrl = url; }),
      isClosed: vi.fn(() => false),
      url: vi.fn(() => currentUrl),
      once: vi.fn(),
    };
    const session = {
      child: { exitCode: null, once: vi.fn() },
      browser: { isConnected: vi.fn(() => true), once: vi.fn(), contexts: vi.fn() },
      pages: [page],
      dead: false,
    };
    const native = new NativeChromeBrowser({
      executablePath: 'chrome',
      profileDir: 'profile',
    });
    const internal = native as unknown as {
      startSession: (targetUrl: string, hostname: string) => Promise<typeof session>;
      withPage: <T>(targetUrl: string, hostname: string, lane: number, read: (value: typeof page) => Promise<T>) => Promise<T>;
    };
    vi.spyOn(internal, 'startSession').mockResolvedValue(session);

    const first = await internal.withPage(currentUrl, 'www.google.com', 0, async (value) => value.url());
    const secondUrl = 'https://scholar.google.com/scholar?q=two';
    const second = await internal.withPage(secondUrl, 'scholar.google.com', 0, async (value) => value.url());

    expect(first).toBe('https://www.google.com/search?q=one');
    expect(second).toBe(secondUrl);
    expect(internal.startSession).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith(secondUrl, {
      waitUntil: 'domcontentloaded', timeout: 12_000,
    });
  });

  it('navigates a restored same-host tab to the actual first query', async () => {
    let currentUrl = 'https://www.google.com/search?q=old+query&num=3&hl=en';
    const page = { goto: vi.fn(async (url: string) => { currentUrl = url; }),
      isClosed: vi.fn(() => false), url: vi.fn(() => currentUrl), once: vi.fn() };
    const session = { child: { exitCode: null }, browser: { isConnected: () => true }, pages: [page], dead: false };
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    const internal = native as unknown as { startSession: () => Promise<typeof session>;
      withPage: <T>(url: string, host: string, lane: number, read: (value: typeof page) => Promise<T>) => Promise<T> };
    vi.spyOn(internal, 'startSession').mockResolvedValue(session);
    const target = 'https://www.google.com/search?q=new+query&num=3&hl=en';
    expect(await internal.withPage(target, 'www.google.com', 0, async value => value.url())).toBe(target);
    expect(page.goto).toHaveBeenCalledOnce();
  });

  it.each(['https://consent.google.com/m?continue=search', 'https://www.google.com/sorry/index'])
  ('retains a first-request consent or CAPTCHA gate: %s', async currentUrl => {
    const page = { goto: vi.fn(), isClosed: vi.fn(() => false), url: () => currentUrl, once: vi.fn() };
    const session = { child: { exitCode: null }, browser: { isConnected: () => true }, pages: [page], dead: false };
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    const internal = native as unknown as { startSession: () => Promise<typeof session>;
      withPage: <T>(url: string, host: string, lane: number, read: (value: typeof page) => Promise<T>) => Promise<T> };
    vi.spyOn(internal, 'startSession').mockResolvedValue(session);
    expect(await internal.withPage('https://www.google.com/search?q=new', 'www.google.com', 0,
      async value => value.url())).toBe(currentUrl);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('uses at most four persistent lanes for a continuous query queue', async () => {
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    const internal = native as unknown as {
      searchOnPage: (query: string, limit: number, opts: object, lane: number) => Promise<{
        results: []; dropped: number; dropped_reasons: [];
      }>;
    };
    const searchOnPage = vi.spyOn(internal, 'searchOnPage').mockResolvedValue({
      results: [], dropped: 0, dropped_reasons: [],
    });

    const rows = await native.searchMany(
      Array.from({ length: 12 }, (_, index) => `query ${index}`),
      10,
    );

    expect(rows).toHaveLength(12);
    expect(new Set(searchOnPage.mock.calls.map((call) => call[3])))
      .toEqual(new Set([0, 1, 2, 3]));
  });

  it('does not restart a dead session inside the same search call', async () => {
    const page = {
      url: () => 'https://www.google.com/search?q=one',
      isClosed: vi.fn(() => false),
      once: vi.fn(),
    };
    const session = {
      child: { exitCode: null, once: vi.fn() },
      browser: { isConnected: vi.fn(() => true), once: vi.fn(), contexts: vi.fn() },
      pages: [page],
      dead: false,
    };
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    const internal = native as unknown as {
      startSession: (targetUrl: string, hostname: string) => Promise<typeof session>;
      disposeSession: (value: typeof session) => Promise<void>;
      withPage: <T>(targetUrl: string, hostname: string, lane: number, read: (value: typeof page) => Promise<T>) => Promise<T>;
    };
    const startSession = vi.spyOn(internal, 'startSession').mockResolvedValue(session);
    const disposeSession = vi.spyOn(internal, 'disposeSession').mockResolvedValue();

    await expect(internal.withPage(
      'https://www.google.com/search?q=one',
      'www.google.com',
      0,
      async () => {
        session.dead = true;
        throw new Error('browser closed');
      },
    )).rejects.toThrow('browser closed');

    expect(startSession).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledWith(session);
  });

  it('keeps the native session and exposes its window on CAPTCHA', async () => {
    const page = { url: () => 'https://www.google.com/search?q=one', isClosed: vi.fn(() => false), once: vi.fn() };
    const session = {
      child: { exitCode: null, once: vi.fn() },
      browser: { isConnected: vi.fn(() => true), once: vi.fn(), contexts: vi.fn() },
      pages: [page],
      dead: false,
    };
    const native = new NativeChromeBrowser({ executablePath: 'chrome', profileDir: 'profile' });
    const internal = native as unknown as {
      startSession: (targetUrl: string, hostname: string) => Promise<typeof session>;
      exposeCaptcha: (value: typeof session, target: typeof page) => Promise<void>;
      disposeSession: (value: typeof session) => Promise<void>;
      withPage: <T>(targetUrl: string, hostname: string, lane: number, read: (value: typeof page) => Promise<T>) => Promise<T>;
    };
    vi.spyOn(internal, 'startSession').mockResolvedValue(session);
    const exposeCaptcha = vi.spyOn(internal, 'exposeCaptcha').mockResolvedValue();
    const disposeSession = vi.spyOn(internal, 'disposeSession').mockResolvedValue();

    await expect(internal.withPage(
      'https://www.google.com/search?q=one',
      'www.google.com',
      0,
      async () => { throw new CaptchaError('test'); },
    )).rejects.toBeInstanceOf(CaptchaError);

    expect(exposeCaptcha).toHaveBeenCalledWith(session, page);
    expect(disposeSession).not.toHaveBeenCalled();
  });

  it('restores the background window guard after CAPTCHA is cleared', async () => {
    const guard = {
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    };
    const startWindowGuard = vi.fn(async () => guard as never);
    const setWindowState = vi.fn(async () => {});
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => 'https://www.google.com/search?q=cleared'),
      evaluate: vi.fn(async () => false),
    };
    const session = {
      child: { pid: 4321, exitCode: null, once: vi.fn() },
      browser: { isConnected: vi.fn(() => true), once: vi.fn(), contexts: vi.fn() },
      pages: [page],
      captchaPage: page,
      dead: false,
    };
    const native = new NativeChromeBrowser({
      executablePath: 'chrome',
      profileDir: 'profile',
      startWindowGuard,
      setWindowState,
    });
    const internal = native as unknown as {
      session: typeof session;
      prepareForSearch: () => Promise<void>;
    };
    internal.session = session;

    await internal.prepareForSearch();

    expect(startWindowGuard).toHaveBeenCalledOnce();
    expect(guard.stdin.end).toHaveBeenCalledWith('4321\n');
    expect(setWindowState).toHaveBeenCalledWith(4321, 0);
    expect(session.captchaPage).toBeUndefined();
  });

  it('closes the session when the Windows guard cannot restart', async () => {
    if (process.platform !== 'win32') return;
    const setWindowState = vi.fn(async () => {});
    const page = {
      isClosed: vi.fn(() => false),
      url: vi.fn(() => 'https://www.google.com/search?q=cleared'),
      evaluate: vi.fn(async () => false),
    };
    const session = {
      child: { pid: 4321, exitCode: null, once: vi.fn() },
      browser: { isConnected: vi.fn(() => true), once: vi.fn(), contexts: vi.fn() },
      pages: [page],
      captchaPage: page,
      dead: false,
    };
    const native = new NativeChromeBrowser({
      executablePath: 'chrome',
      profileDir: 'profile',
      startWindowGuard: async () => undefined,
      setWindowState,
    });
    const internal = native as unknown as {
      session: typeof session;
      disposeSession: (value: typeof session) => Promise<void>;
      prepareForSearch: () => Promise<void>;
    };
    internal.session = session;
    const disposeSession = vi.spyOn(internal, 'disposeSession').mockResolvedValue();

    await expect(internal.prepareForSearch()).rejects.toThrow('window guard failed to restart');

    expect(setWindowState).toHaveBeenCalledWith(4321, 0);
    expect(disposeSession).toHaveBeenCalledWith(session);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleSearchUrl, buildNativeChromeArgs, buildScholarSearchUrl, NativeChromeBrowser,
} from '../src/nativeBrowser.js';
import { CaptchaError } from '../src/search.js';

describe('native Chrome search route', () => {
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
    const page = { isClosed: vi.fn(() => false), once: vi.fn() };
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
});

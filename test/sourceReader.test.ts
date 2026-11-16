import { chromium, type BrowserContext } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { extract } from '../src/extract.js';
import { SourceReader } from '../src/sourceReader.js';

vi.mock('../src/extract.js', () => ({ extract: vi.fn(), checkUrlAsync: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
vi.mock('../src/browser.js', () => ({ detectSystemChrome: () => 'system-chrome' }));
const mockedExtract = vi.mocked(extract);
const context = {} as BrowserContext;
const config = () => loadConfig({ SURF_IDLE_CLOSE_MS: '100' });
const readers: SourceReader[] = [];
beforeEach(() => { vi.useFakeTimers(); mockedExtract.mockReset(); vi.mocked(chromium.launch).mockReset(); });
afterEach(async () => { for (const reader of readers.splice(0)) await reader.dispose(); vi.useRealTimers(); });

describe('isolated source reader lifecycle', () => {
  it('blocks service workers and automatic downloads in the default reader', async () => {
    const sourceContext = { route: vi.fn(async () => {}), routeWebSocket: vi.fn(async () => {}) } as unknown as BrowserContext;
    const browser = { newContext: vi.fn(async () => sourceContext), close: vi.fn(async () => {}) };
    vi.mocked(chromium.launch).mockResolvedValueOnce(browser as never);
    mockedExtract.mockImplementation(async lazy => {
      await (lazy as () => Promise<BrowserContext>)();
      return { url: 'https://example.org', content: 'Fact' };
    });
    const reader = new SourceReader(config()); readers.push(reader);
    await reader.read('https://example.org', 500);
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    expect(vi.mocked(chromium.launch).mock.calls[0][0]?.executablePath).toBeUndefined();
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: 'block', acceptDownloads: false }));
    expect(sourceContext.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(sourceContext.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('falls back to system Chrome only when the bundled executable is missing', async () => {
    const sourceContext = { route: vi.fn(async () => {}), routeWebSocket: vi.fn(async () => {}) } as unknown as BrowserContext;
    const browser = { newContext: vi.fn(async () => sourceContext), close: vi.fn(async () => {}) };
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error("Executable doesn't exist at bundled/chrome"))
      .mockResolvedValueOnce(browser as never);
    mockedExtract.mockImplementation(async lazy => {
      await (lazy as () => Promise<BrowserContext>)(); return { url: 'https://example.org', content: 'Fact' };
    });
    const reader = new SourceReader(config()); readers.push(reader);
    await reader.read('https://example.org', 500);
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chromium.launch).mock.calls[1][0]).toMatchObject({ executablePath: 'system-chrome', headless: true });
  });

  it.each([false, true])('does not retry unrelated or explicitly configured executable failures (%s)', async explicit => {
    const settings = config();
    if (explicit) settings.chromePath = 'configured-chrome';
    const error = new Error(explicit ? "Executable doesn't exist at configured-chrome" : 'browser crashed');
    vi.mocked(chromium.launch).mockRejectedValueOnce(error);
    mockedExtract.mockImplementation(async lazy => {
      await (lazy as () => Promise<BrowserContext>)(); return { url: 'https://example.org' };
    });
    const reader = new SourceReader(settings); readers.push(reader);
    await expect(reader.read('https://example.org', 500)).rejects.toBe(error);
    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(reader.stats()).toMatchObject({ initialized: false, active: 0 });
  });

  it('does not initialize a browser for HTTP-only metadata', async () => {
    const create = vi.fn(async () => ({ context, close: vi.fn(async () => {}) }));
    mockedExtract.mockResolvedValue({ url: 'https://example.org', title: 'Title', extraction_quality: 'metadata_only' });
    const reader = new SourceReader(config(), create); readers.push(reader);
    await reader.read('https://example.org', 500, 'metadata');
    expect(create).not.toHaveBeenCalled();
    expect(reader.stats()).toMatchObject({ initialized: false, active: 0, headless: true });
  });

  it('shares one context, bounds concurrency and closes it after idle', async () => {
    const close = vi.fn(async () => {}), create = vi.fn(async () => ({ context, close }));
    const releases: Array<() => void> = [];
    mockedExtract.mockImplementation(async (lazy, url) => {
      expect(await (lazy as () => Promise<BrowserContext>)()).toBe(context);
      await new Promise<void>(resolve => releases.push(resolve));
      return { url, content: 'A source fact.', extraction_quality: 'full_text' };
    });
    const reader = new SourceReader(config(), create); readers.push(reader);
    const first = reader.read('https://example.org/1', 500);
    const second = reader.read('https://example.org/2', 500);
    const third = reader.read('https://example.org/3', 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.stats()).toMatchObject({ active: 2, queued: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    releases.shift()!(); await first; await vi.advanceTimersByTimeAsync(0);
    expect(reader.stats()).toMatchObject({ active: 2, queued: 0 });
    releases.splice(0).forEach(release => release()); await Promise.all([second, third]);
    await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reader.stats()).toMatchObject({ initialized: false, active: 0 });
  });

  it('retries a failed browser creation without leaking an active slot', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('launch failed')).mockResolvedValue({ context, close: vi.fn(async () => {}) });
    mockedExtract.mockImplementation(async lazy => {
      await (lazy as () => Promise<BrowserContext>)();
      return { url: 'https://example.org', content: 'Fact' };
    });
    const reader = new SourceReader(config(), create); readers.push(reader);
    await expect(reader.read('https://example.org', 500)).rejects.toThrow('launch failed');
    expect(reader.stats()).toMatchObject({ initialized: false, active: 0 });
    await expect(reader.read('https://example.org', 500)).resolves.toMatchObject({ content: 'Fact' });
    expect(create).toHaveBeenCalledTimes(2);
  });
});

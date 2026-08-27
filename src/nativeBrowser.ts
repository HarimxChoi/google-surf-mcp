import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import {
  clearProfileLocks, detectBlock, dismissConsent, killZombieChromium,
} from './browser.js';
import {
  CaptchaError, pickAndScoreResults, type SearchOptions, type SearchOutcome,
} from './search.js';
import { readScholarResultsPage, type ScholarResult } from './scholar.js';

const GOOGLE_HOST = 'www.google.com';
const SCHOLAR_HOST = 'scholar.google.com';
const NATIVE_CAPTCHA_ACTION =
  'Wait before retrying, change the network route, or configure SearchApi fallback.';
const WINDOWS_WINDOW_GUARD = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SurfNativeWindow {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  public static void Minimize(int processId) {
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == (uint)processId && IsWindowVisible(hWnd)) {
        ShowWindowAsync(hWnd, GetForegroundWindow() == hWnd ? 6 : 7);
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[Console]::Out.WriteLine('ready')
$line = [Console]::In.ReadLine()
$targetProcessId = 0
if (-not [int]::TryParse($line, [ref]$targetProcessId)) { exit 0 }
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  try { [System.Diagnostics.Process]::GetProcessById($targetProcessId) | Out-Null } catch { break }
  [SurfNativeWindow]::Minimize($targetProcessId)
  Start-Sleep -Milliseconds 15
}
`;

export interface NativeBrowserHandle {
  search(query: string, limit: number, opts?: SearchOptions): Promise<SearchOutcome>;
  scholar(query: string, limit: number, locale?: string): Promise<ScholarResult[]>;
  close(): Promise<void>;
}

export interface NativeChromeOptions {
  executablePath: string;
  profileDir: string;
  settleMs?: number;
}

export function buildGoogleSearchUrl(query: string, limit: number, locale?: string): string {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(limit));
  const language = locale?.split(/[-_]/)[0];
  if (language) url.searchParams.set('hl', language);
  return url.toString();
}

export function buildScholarSearchUrl(query: string, limit: number, locale?: string): string {
  const url = new URL('https://scholar.google.com/scholar');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(limit));
  const language = locale?.split(/[-_]/)[0];
  if (language) url.searchParams.set('hl', language);
  return url.toString();
}

export function buildNativeChromeArgs(
  profileDir: string,
  port: number,
  targetUrl: string,
): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Chrome debugging port must be a fixed non-zero port');
  }
  return [
    '--start-minimized',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    targetUrl,
  ];
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (port === 0) throw new Error('failed to reserve Chrome debugging port');
  return port;
}

async function startWindowsWindowGuard(): Promise<ChildProcess | undefined> {
  if (process.platform !== 'win32') return undefined;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const child = spawn(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_WINDOW_GUARD],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  );
  const ready = await new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      child.removeListener('error', failed);
      child.removeListener('exit', failed);
      child.stdout?.removeListener('data', onData);
      resolve(value);
    };
    const failed = () => finish(false);
    const onData = (chunk: Buffer) => {
      if (!chunk.toString().includes('ready')) return;
      finish(true);
    };
    const timer = setTimeout(failed, 3_000);
    child.once('error', failed);
    child.once('exit', failed);
    child.stdout?.on('data', onData);
  });
  if (ready) return child;
  child.kill();
  return undefined;
}

async function waitForTarget(port: number, hostnames: string[], child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 12_000;
  let launchError: Error | undefined;
  child.once('error', (error) => { launchError = error; });
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Chrome exited before search loaded (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      });
      const targets = await response.json() as Array<{ type?: string; url?: string }>;
      if (targets.some((target) => target.type === 'page' && target.url
        && hostnames.includes(new URL(target.url).hostname))) return;
    } catch {}
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome did not load ${hostnames[0]} before timeout`);
}

async function targetPage(browser: Browser, hostnames: string[]): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => {
    try { return hostnames.includes(new URL(candidate.url()).hostname); } catch { return false; }
  });
  if (!page) throw new Error(`Chrome target page missing for ${hostnames[0]}`);
  return page;
}

export class NativeChromeBrowser implements NativeBrowserHandle {
  private readonly executablePath: string;
  private readonly profileDir: string;
  private readonly settleMs: number;
  private queue: Promise<void> = Promise.resolve();
  private active = new Set<ChildProcess>();

  constructor(options: NativeChromeOptions) {
    this.executablePath = options.executablePath;
    this.profileDir = options.profileDir;
    this.settleMs = options.settleMs ?? 2_500;
  }

  async search(query: string, limit: number, opts: SearchOptions = {}): Promise<SearchOutcome> {
    return await this.exclusive(async () => {
      const url = buildGoogleSearchUrl(query, limit, opts.locale);
      return await this.withPage(url, GOOGLE_HOST, async (page) => {
        await dismissConsent(page);
        await page.waitForSelector('h3, #search, [id="rso"]', { timeout: 8_000 }).catch(() => {});
        if (await detectBlock(page)) {
          throw new CaptchaError('native-after-search', NATIVE_CAPTCHA_ACTION);
        }
        return await pickAndScoreResults(page, limit, {
          locale: opts.locale,
          healing: opts.healing,
        });
      });
    });
  }

  async scholar(query: string, limit: number, locale?: string): Promise<ScholarResult[]> {
    return await this.exclusive(async () => {
      const url = buildScholarSearchUrl(query, limit, locale);
      return await this.withPage(url, SCHOLAR_HOST, async (page) => {
        await dismissConsent(page);
        try {
          return await readScholarResultsPage(page, limit);
        } catch (error) {
          if (error instanceof CaptchaError) {
            throw new CaptchaError('native-scholar', NATIVE_CAPTCHA_ACTION);
          }
          throw error;
        }
      });
    });
  }

  async close(): Promise<void> {
    for (const child of this.active) {
      if (child.exitCode === null) child.kill();
    }
    this.active.clear();
    killZombieChromium(this.profileDir);
    await clearProfileLocks(this.profileDir);
  }

  private async exclusive<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await op();
    } finally {
      release();
    }
  }

  private async withPage<T>(
    targetUrl: string,
    hostname: string,
    read: (page: Page) => Promise<T>,
  ): Promise<T> {
    await mkdir(this.profileDir, { recursive: true });
    killZombieChromium(this.profileDir);
    await clearProfileLocks(this.profileDir);
    const port = await reservePort();
    const windowGuard = await startWindowsWindowGuard();
    const child = spawn(
      this.executablePath,
      buildNativeChromeArgs(this.profileDir, port, targetUrl),
      { stdio: 'ignore', windowsHide: false },
    );
    if (child.pid) windowGuard?.stdin?.end(String(child.pid));
    this.active.add(child);
    let browser: Browser | undefined;
    try {
      const hostnames = [hostname, 'consent.google.com'];
      await waitForTarget(port, hostnames, child);
      await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 7_500 });
      const page = await targetPage(browser, hostnames);
      const webdriver = await page.evaluate(() => navigator.webdriver).catch(() => true);
      if (webdriver) throw new Error('native Chrome exposed navigator.webdriver');
      return await read(page);
    } finally {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) child.kill();
      this.active.delete(child);
      killZombieChromium(this.profileDir);
      await clearProfileLocks(this.profileDir);
      windowGuard?.kill();
    }
  }
}

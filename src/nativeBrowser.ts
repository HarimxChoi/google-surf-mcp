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
const NATIVE_MAX_PAGES = 4;
const NATIVE_NAVIGATION_GAP_MS = 750;
const NATIVE_CAPTCHA_ACTION =
  'Solve the CAPTCHA in the maximized native Chrome window, then retry.';
const WINDOWS_SET_WINDOW_STATE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SurfNativeWindowState {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  public static void SetState(int processId, int command) {
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == (uint)processId && IsWindowVisible(hWnd)) {
        ShowWindowAsync(hWnd, command);
        if (command == 3) SetForegroundWindow(hWnd);
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[SurfNativeWindowState]::SetState(__PID__, __COMMAND__)
`;
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
  searchMany(
    queries: string[],
    limit: number,
    opts?: SearchOptions,
  ): Promise<Array<{ query: string; outcome?: SearchOutcome; error?: string }>>;
  scholar(query: string, limit: number, locale?: string): Promise<ScholarResult[]>;
  close(): Promise<void>;
}

export interface NativeChromeOptions {
  executablePath: string;
  profileDir: string;
  settleMs?: number;
}

interface NativeSession {
  child: ChildProcess;
  browser: Browser;
  pages: Array<Page | undefined>;
  captchaPage?: Page;
  windowGuard?: ChildProcess;
  dead: boolean;
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

async function setWindowsWindowState(pid: number, command: 3 | 7): Promise<void> {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const script = WINDOWS_SET_WINDOW_STATE
    .replace('__PID__', String(pid))
    .replace('__COMMAND__', String(command));
  const child = spawn(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { stdio: 'ignore', windowsHide: true },
  );
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  private navigationQueue: Promise<void> = Promise.resolve();
  private nextNavigationAt = 0;
  private active = new Set<ChildProcess>();
  private session?: NativeSession;
  private sessionPromise?: Promise<NativeSession>;

  constructor(options: NativeChromeOptions) {
    this.executablePath = options.executablePath;
    this.profileDir = options.profileDir;
    this.settleMs = options.settleMs ?? 2_500;
  }

  async search(query: string, limit: number, opts: SearchOptions = {}): Promise<SearchOutcome> {
    return await this.exclusive(async () => {
      await this.prepareForSearch();
      return await this.searchOnPage(query, limit, opts, 0);
    });
  }

  async searchMany(
    queries: string[],
    limit: number,
    opts: SearchOptions = {},
  ): Promise<Array<{ query: string; outcome?: SearchOutcome; error?: string }>> {
    return await this.exclusive(async () => {
      await this.prepareForSearch();
      const rows = new Array<{ query: string; outcome?: SearchOutcome; error?: string }>(queries.length);
      const workerCount = Math.min(NATIVE_MAX_PAGES, queries.length);
      let cursor = 0;
      let fatal: Error | undefined;
      await Promise.all(Array.from({ length: workerCount }, async (_, lane) => {
        while (!fatal) {
          const index = cursor++;
          if (index >= queries.length) return;
          const query = queries[index];
          try {
            rows[index] = { query, outcome: await this.searchOnPage(query, limit, opts, lane) };
          } catch (error) {
            if (error instanceof CaptchaError) {
              fatal = error;
              return;
            }
            rows[index] = { query, error: (error as Error).message };
            if (!this.session) {
              fatal = error as Error;
              return;
            }
          }
        }
      }));
      if (fatal) throw fatal;
      return rows;
    });
  }

  async scholar(query: string, limit: number, locale?: string): Promise<ScholarResult[]> {
    return await this.exclusive(async () => {
      await this.prepareForSearch();
      const url = buildScholarSearchUrl(query, limit, locale);
      return await this.withPage(url, SCHOLAR_HOST, 0, async (page) => {
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
    await this.disposeSession();
    for (const child of this.active) {
      if (child.exitCode === null) child.kill();
    }
    this.active.clear();
    await this.terminateProfileProcesses();
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

  private async searchOnPage(
    query: string,
    limit: number,
    opts: SearchOptions,
    lane: number,
  ): Promise<SearchOutcome> {
    const url = buildGoogleSearchUrl(query, limit, opts.locale);
    return await this.withPage(url, GOOGLE_HOST, lane, async (page) => {
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
  }

  private async withPage<T>(
    targetUrl: string,
    hostname: string,
    lane: number,
    read: (page: Page) => Promise<T>,
  ): Promise<T> {
    const { session, created } = await this.ensureSession(targetUrl, hostname);
    let page: Page | undefined;
    try {
      page = await this.pageForLane(session, lane);
      if (!created || lane !== 0) {
        await this.waitForNavigationSlot();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      }
      return await read(page);
    } catch (error) {
      if (error instanceof CaptchaError) {
        if (page) await this.exposeCaptcha(session, page);
      } else if (!this.sessionAlive(session)) {
        await this.disposeSession(session);
      } else if (page?.isClosed()) {
        session.pages[lane] = undefined;
      }
      throw error;
    }
  }

  private sessionAlive(session: NativeSession): boolean {
    return !session.dead
      && session.child.exitCode === null
      && session.browser.isConnected();
  }

  private async exposeCaptcha(session: NativeSession, page: Page): Promise<void> {
    session.captchaPage = page;
    session.windowGuard?.kill();
    session.windowGuard = undefined;
    if (session.child.pid) await setWindowsWindowState(session.child.pid, 3);
  }

  private async prepareForSearch(): Promise<void> {
    const session = this.session;
    const page = session?.captchaPage;
    if (!session || !page) return;
    if (this.sessionAlive(session) && !page.isClosed()) {
      const blocked = await detectBlock(page).catch(() => false);
      if (blocked) {
        await this.exposeCaptcha(session, page);
        throw new CaptchaError('native-awaiting-user', NATIVE_CAPTCHA_ACTION);
      }
    }
    session.captchaPage = undefined;
    if (session.child.pid) await setWindowsWindowState(session.child.pid, 7);
  }

  private async ensureSession(
    targetUrl: string,
    hostname: string,
  ): Promise<{ session: NativeSession; created: boolean }> {
    if (this.session && this.sessionAlive(this.session)) {
      return { session: this.session, created: false };
    }
    if (this.sessionPromise) {
      return { session: await this.sessionPromise, created: false };
    }
    if (this.session) await this.disposeSession(this.session);
    const pending = this.startSession(targetUrl, hostname);
    this.sessionPromise = pending;
    try {
      const session = await pending;
      this.session = session;
      return { session, created: true };
    } finally {
      if (this.sessionPromise === pending) this.sessionPromise = undefined;
    }
  }

  private async startSession(targetUrl: string, hostname: string): Promise<NativeSession> {
    await mkdir(this.profileDir, { recursive: true });
    killZombieChromium(this.profileDir);
    await clearProfileLocks(this.profileDir);
    const port = await reservePort();
    const windowGuard = await startWindowsWindowGuard();
    await this.waitForNavigationSlot();
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
      const session: NativeSession = { child, browser, pages: [page], windowGuard, dead: false };
      child.once('exit', () => { session.dead = true; });
      browser.once('disconnected', () => { session.dead = true; });
      return session;
    } catch (error) {
      await browser?.close().catch(() => {});
      if (child.exitCode === null) child.kill();
      this.active.delete(child);
      killZombieChromium(this.profileDir);
      await clearProfileLocks(this.profileDir);
      windowGuard?.kill();
      throw error;
    }
  }

  private async pageForLane(session: NativeSession, lane: number): Promise<Page> {
    const current = session.pages[lane];
    if (current && !current.isClosed()) return current;
    const context = session.browser.contexts()[0];
    if (!context) throw new Error('native Chrome context missing');
    const page = await context.newPage();
    session.pages[lane] = page;
    return page;
  }

  private async waitForNavigationSlot(): Promise<void> {
    const previous = this.navigationQueue;
    let release!: () => void;
    this.navigationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, this.nextNavigationAt - Date.now());
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      this.nextNavigationAt = Date.now() + NATIVE_NAVIGATION_GAP_MS;
    } finally {
      release();
    }
  }

  private async disposeSession(session = this.session): Promise<void> {
    if (!session) return;
    if (this.session === session) this.session = undefined;
    session.dead = true;
    await session.browser.close().catch(() => {});
    if (session.child.exitCode === null) session.child.kill();
    this.active.delete(session.child);
    await this.terminateProfileProcesses();
    await clearProfileLocks(this.profileDir);
    session.windowGuard?.kill();
  }

  private async terminateProfileProcesses(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const killed = killZombieChromium(this.profileDir);
      if (killed === 0 && attempt > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
  }
}

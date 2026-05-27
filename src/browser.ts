import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { platform, homedir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { chromium as chromiumBare } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';

let stealthPluginRegistered = false;
function ensureStealth() {
  if (!stealthPluginRegistered) {
    chromiumExtra.use(StealthPlugin());
    stealthPluginRegistered = true;
  }
}

const PROFILE_ROOT = process.env.SURF_PROFILE_ROOT || join(homedir(), '.google-surf-mcp');
export const PROFILE_MAIN = resolve(PROFILE_ROOT, 'main');
export const PROFILE_SEED = resolve(PROFILE_ROOT, 'seed');
export const PROFILE_WORKER = (i: number) => resolve(PROFILE_ROOT, `w${i}`);

export function detectChrome(): string {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error(`CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
  }
  // Bundled chromium first: system Chrome forwards args via Singleton IPC + exits 21 on Windows.
  try {
    const bundled = chromiumBare.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
    console.error('[google-surf] bundled chromium path missing, falling back to system Chrome');
  } catch (e) {
    console.error('[google-surf] playwright browsers not installed, falling back to system Chrome:', (e as Error).message);
  }
  const candidates: Record<string, string[]> = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
  };
  for (const p of candidates[platform()] || []) if (existsSync(p)) return p;
  throw new Error('Chrome not found. Run `npx playwright install chromium`, install Chrome, or set CHROME_PATH env.');
}

const SYSTEM_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
})();

export interface LaunchOpts {
  profileDir: string;
  headless?: boolean;
  // false = bare playwright (cascade default); true = stealth plugin fallback.
  stealth?: boolean;
  // Required when running behind a MITM HTTPS proxy (cloud sandboxes).
  insecureTls?: boolean;
  // Required for chromium under non-root cgroups (most cloud sandboxes).
  noSandbox?: boolean;
  // Set false for CAPTCHA recovery — reCAPTCHA image grids need images.
  blockResources?: boolean;
}

function readBoolEnv(name: string, defaultVal: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultVal;
  return v.toLowerCase() === 'true';
}

export async function launch(opts: LaunchOpts): Promise<BrowserContext> {
  const cloudMode = readBoolEnv('SURF_CLOUD_MODE', false);
  const useStealth = opts.stealth ?? readBoolEnv('SURF_USE_STEALTH', true);
  const insecureTls = opts.insecureTls ?? readBoolEnv('SURF_INSECURE_TLS', cloudMode);
  const noSandbox = opts.noSandbox ?? readBoolEnv('SURF_NO_SANDBOX', cloudMode);
  const remoteDebug = readBoolEnv('SURF_REMOTE_DEBUG', false);

  const effectiveHeadless = opts.headless !== undefined
    ? opts.headless
    : process.env.SURF_HEADLESS === 'false' ? false : true;

  if (useStealth) ensureStealth();
  const driver = useStealth ? chromiumExtra : chromiumBare;

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
    '--fingerprinting-canvas-image-data-noise',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--force-webrtc-ip-handling-policy',
    ...(noSandbox ? ['--no-sandbox'] : []),
    ...(insecureTls ? ['--ignore-certificate-errors'] : []),
    ...(cloudMode ? ['--disable-dev-shm-usage'] : []), // cloud /dev/shm too small for Chromium
    // port=0: kernel-assigned, written to <profileDir>/DevToolsActivePort.
    ...(remoteDebug ? ['--remote-debugging-port=0', '--remote-debugging-address=0.0.0.0'] : []),
  ];

  const doLaunch = () => driver.launchPersistentContext(profileFor(opts.profileDir), {
    executablePath: detectChrome(),
    headless: effectiveHeadless,
    viewport: { width: 1366, height: 768 },
    locale: process.env.SURF_LOCALE || 'en-US',
    timezoneId: process.env.SURF_TZ || SYSTEM_TZ,
    ignoreDefaultArgs: ['--enable-automation'],
    ignoreHTTPSErrors: insecureTls,
    args,
  });

  // Stale lock from a prior Chrome still flushing; wait, clear, retry once.
  let ctx: BrowserContext;
  try {
    ctx = await doLaunch();
  } catch (e) {
    const msg = (e as Error).message;
    if (!/ProcessSingleton|SingletonLock|Target page, context or browser has been closed/i.test(msg)) throw e;
    killZombieChromium(opts.profileDir);
    await waitForLockReleased(opts.profileDir, 3_000);
    await clearProfileLocks(opts.profileDir);
    ctx = await doLaunch();
  }

  if (opts.blockResources !== false) {
    await ctx.route('**/*', route => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });
  }

  return ctx;
}

function profileFor(profileDir: string): string {
  return profileDir;
}

export async function getPage(ctx: BrowserContext): Promise<Page> {
  return ctx.pages()[0] ?? (await ctx.newPage());
}

const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

// A leftover lock is always stale here: the server owns the only instance.
export async function clearProfileLocks(profileDir: string): Promise<void> {
  for (const f of SINGLETON_FILES) {
    const p = resolve(profileDir, f);
    if (existsSync(p)) await rm(p, { force: true }).catch(() => {});
  }
}

// Windows: zombie chrome.exe from a crashed prior session holds the user-data-dir
// lock; new launches forward args via Singleton IPC then exit 21. Lock files
// alone do not cover this.
export function killZombieChromium(profileDir: string): number {
  if (process.platform !== 'win32') return 0;
  const needle = profileDir.toLowerCase();
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle.replace(/'/g, "''")}') } | ` +
        `Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const pids = out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    let killed = 0;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch {}
    }
    if (killed > 0) console.error(`[google-surf-mcp] killed ${killed} zombie chrome.exe holding ${profileDir}`);
    return killed;
  } catch {
    return 0;
  }
}

export async function waitForLockReleased(profileDir: string, maxMs = 3_000): Promise<void> {
  const lock = resolve(profileDir, 'SingletonLock');
  const deadline = Date.now() + maxMs;
  while (existsSync(lock) && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

// Chromium holds Windows locks on these while main is live; skip to avoid EBUSY.
const LOCKED_BASENAMES = new Set([
  'SingletonLock', 'SingletonCookie', 'SingletonSocket',
  'Cookies', 'Cookies-journal',
  'Login Data', 'Login Data-journal',
  'Login Data For Account', 'Login Data For Account-journal',
  'Web Data', 'Web Data-journal',
  'History', 'History-journal',
  'Top Sites', 'Top Sites-journal',
  'Favicons', 'Favicons-journal',
  'Shortcuts', 'Shortcuts-journal',
  'Network Persistent State', 'TransportSecurity', 'ParentToken',
  'Sessions', 'Session Storage', 'Local Storage', 'IndexedDB', 'Service Worker',
  'GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'Crashpad', 'Cache',
]);
const LOCKED_DIR_RE = /(^|.+ )Network$/;

function isSeedSkippable(src: string): boolean {
  const base = basename(src);
  return LOCKED_BASENAMES.has(base) || LOCKED_DIR_RE.test(base);
}

let seedPromise: Promise<void> | null = null;
export function ensureSeed(): Promise<void> {
  if (existsSync(PROFILE_SEED)) return Promise.resolve();
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    if (!existsSync(PROFILE_MAIN)) {
      throw new Error('seed: main profile missing — run bootstrap first');
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await cp(PROFILE_MAIN, PROFILE_SEED, {
          recursive: true,
          force: true,
          filter: (src) => !isSeedSkippable(src),
        });
        await clearProfileLocks(PROFILE_SEED);
        return;
      } catch (e) {
        lastErr = e;
        await rm(PROFILE_SEED, { recursive: true, force: true }).catch(() => {});
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  })().catch((e) => {
    seedPromise = null;
    throw e;
  });
  return seedPromise;
}

export async function cloneProfile(workerIndex: number): Promise<string> {
  const dst = PROFILE_WORKER(workerIndex);
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  await ensureSeed();
  await cp(PROFILE_SEED, dst, { recursive: true, force: true });
  await clearProfileLocks(dst);
  return dst;
}

export function profileExists(): boolean {
  return existsSync(PROFILE_MAIN);
}

export const isBlocked = (url: string) => url.includes('/sorry/');

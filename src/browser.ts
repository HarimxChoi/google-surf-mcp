import { existsSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { platform, homedir } from 'node:os';
import { resolve, join } from 'node:path';
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
export const PROFILE_WORKER = (i: number) => resolve(PROFILE_ROOT, `w${i}`);

function detectChrome(): string {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error(`CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
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
  throw new Error('Chrome not found. Install Chrome or set CHROME_PATH env.');
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

  const ctx = await driver.launchPersistentContext(profileFor(opts.profileDir), {
    executablePath: detectChrome(),
    headless: effectiveHeadless,
    viewport: { width: 1366, height: 768 },
    locale: process.env.SURF_LOCALE || 'en-US',
    timezoneId: process.env.SURF_TZ || SYSTEM_TZ,
    ignoreDefaultArgs: ['--enable-automation'],
    ignoreHTTPSErrors: insecureTls,
    args,
  });

  await ctx.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

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

export async function cloneProfile(workerIndex: number): Promise<string> {
  const dst = PROFILE_WORKER(workerIndex);
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  await cp(PROFILE_MAIN, dst, { recursive: true, force: true });
  await clearProfileLocks(dst);
  return dst;
}

export function profileExists(): boolean {
  return existsSync(PROFILE_MAIN);
}

export const isBlocked = (url: string) => url.includes('/sorry/');

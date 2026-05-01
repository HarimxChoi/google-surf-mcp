import { existsSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { platform, homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';

chromiumExtra.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PROFILE_ROOT = process.env.SURF_PROFILE_ROOT || join(homedir(), '.google-surf-mcp');
export const PROFILE_MAIN = resolve(PROFILE_ROOT, 'main');
export const PROFILE_WORKER = (i: number) => resolve(PROFILE_ROOT, `w${i}`);

function detectChrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
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
}

export async function launch({ profileDir, headless }: LaunchOpts): Promise<BrowserContext> {
  // param > env > default
  const effectiveHeadless = headless !== undefined
    ? headless
    : process.env.SURF_HEADLESS === 'false' ? false : true;
  const ctx = await chromiumExtra.launchPersistentContext(profileDir, {
    executablePath: detectChrome(),
    headless: effectiveHeadless,
    viewport: { width: 1366, height: 768 },
    locale: process.env.SURF_LOCALE || 'en-US',
    timezoneId: process.env.SURF_TZ || SYSTEM_TZ,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  await ctx.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  return ctx;
}

export async function getPage(ctx: BrowserContext): Promise<Page> {
  return ctx.pages()[0] ?? (await ctx.newPage());
}

export async function cloneProfile(workerIndex: number): Promise<string> {
  const dst = PROFILE_WORKER(workerIndex);
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  await cp(PROFILE_MAIN, dst, { recursive: true, force: true });
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = resolve(dst, f);
    if (existsSync(p)) await rm(p, { force: true }).catch(() => {});
  }
  return dst;
}

export function profileExists(): boolean {
  return existsSync(PROFILE_MAIN);
}

export const isBlocked = (url: string) => url.includes('/sorry/');

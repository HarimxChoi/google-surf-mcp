import { existsSync } from 'node:fs';
import { rm, cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';

chromiumExtra.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

export const PROFILE_MAIN = resolve(ROOT, 'chrome-profiles/main');
export const PROFILE_WORKER = (i: number) => resolve(ROOT, `chrome-profiles/w${i}`);

const REAL_CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export interface LaunchOpts {
  profileDir: string;
  headless?: boolean;
}

export async function launch({ profileDir, headless = true }: LaunchOpts): Promise<BrowserContext> {
  if (!existsSync(REAL_CHROME)) {
    throw new Error(`Chrome not found at ${REAL_CHROME}. Set CHROME_PATH env.`);
  }

  const ctx = await chromiumExtra.launchPersistentContext(profileDir, {
    executablePath: REAL_CHROME,
    headless,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'Asia/Seoul',
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

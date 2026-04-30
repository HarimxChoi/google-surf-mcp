import type { Page } from 'playwright';
import type { SearchResult } from './types.js';
import { isBlocked } from './browser.js';
import { parseResults } from './parse.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

export class CaptchaError extends Error {
  constructor(stage: string) {
    super(`Google CAPTCHA at ${stage}`);
    this.name = 'CaptchaError';
  }
}

export async function search(page: Page, query: string, limit = 10): Promise<SearchResult[]> {
  const onResultsPage = page.url().includes('/search?');
  if (!onResultsPage) {
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (isBlocked(page.url())) throw new CaptchaError('home');
    await sleep(rand(300, 600));
  }

  const sb = page.locator('textarea[name="q"], input[name="q"]').first();
  await sb.click();
  await sleep(rand(80, 150));

  if (onResultsPage) {
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.press('Delete');
  }

  for (const ch of query) {
    await page.keyboard.type(ch, { delay: rand(30, 50) });
  }
  await sleep(rand(100, 200));
  await page.keyboard.press('Enter');

  try {
    await page.waitForURL(/\/search\?/, { timeout: 12_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 12_000 });
    await page.waitForSelector('h3, #search, [id="rso"]', { timeout: 8_000 });
  } catch {}

  if (isBlocked(page.url())) throw new CaptchaError('after-search');

  return page.evaluate(parseResults, limit) as Promise<SearchResult[]>;
}

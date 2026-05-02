import type { Page } from 'playwright';
import type { SearchResult } from './types.js';
import { isBlocked } from './browser.js';
import { parseResults, type ParseOutput } from './parse.js';

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
  const url = page.url();
  const onResultsPage = url.includes('/search?');
  // skip redundant goto: launch already navigated home, second nav races subresources → ERR_ABORTED
  const onHome =
    url.startsWith('https://www.google.com/') &&
    !url.includes('/search?') &&
    !url.includes('/sorry/');
  if (!onResultsPage && !onHome) {
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await sleep(rand(80, 160));
  }
  if (isBlocked(page.url())) throw new CaptchaError('home');

  const sb = page.locator('textarea[name="q"], input[name="q"]').first();
  await sb.click({ timeout: 6_000 });
  await sleep(rand(30, 70));

  if (onResultsPage) {
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.press('Delete');
  }

  for (const ch of query) {
    await page.keyboard.type(ch, { delay: rand(8, 20) });
  }
  await sleep(rand(50, 110));
  await page.keyboard.press('Enter');

  // inner 5+4+4=13s, within 30s outer
  let waitErr: Error | null = null;
  try {
    await page.waitForURL(/\/search\?/, { timeout: 5_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 4_000 });
    await page.waitForSelector('h3, #search, [id="rso"]', { timeout: 4_000 });
  } catch (e) {
    waitErr = e as Error;
  }

  if (isBlocked(page.url())) throw new CaptchaError('after-search');

  const out = (await page.evaluate(parseResults, limit)) as ParseOutput;

  // empty results: throw if we have a reason, otherwise return []
  if (out.results.length === 0) {
    if (waitErr) {
      throw new Error(`search wait failed and no results: ${waitErr.message.slice(0, 120)}`);
    }
    // h3Count >= 5 is an arbitrary threshold; tune from prod data
    if (out.h3Count >= 5) {
      throw new Error(`parser stale: ${out.h3Count} h3 elements but 0 results extracted`);
    }
    // truly empty SERP, return []
  }
  return out.results;
}

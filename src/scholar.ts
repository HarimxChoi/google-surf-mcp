import type { Page } from 'playwright';
import { dismissConsent } from './browser.js';
import type { HumanlikeBehavior } from './humanlike.js';
import { CaptchaError } from './search.js';

const SCHOLAR_HOME = 'https://scholar.google.com/';
const SCHOLAR_CAPTCHA_ACTION =
  'Retry with SURF_HEADLESS=false and solve the Google Scholar CAPTCHA.';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export interface ScholarResult {
  rank: number;
  title: string;
  url?: string;
  authors?: string;
  publication?: string;
  year?: number;
  source?: string;
  snippet: string;
  cited_by_count: number;
  cited_by_url?: string;
  related_articles_url?: string;
  versions_count?: number;
  versions_url?: string;
  full_text_url?: string;
  scholar_id?: string;
  metadata: string;
}

export interface ScholarSearchOptions {
  humanlike?: HumanlikeBehavior;
  locale?: string;
}

export class ScholarRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 15 * 60_000) {
    // Scholar cooldowns are IP-based; automatic retries make them worse.
    super('Google Scholar unusual-traffic rate limit; wait before retrying');
    this.name = 'ScholarRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function assertScholarParseCoverage(
  resultBlocks: number,
  parsedResults: number,
  limit: number,
  hasResultContainer: boolean,
): void {
  if (!hasResultContainer) {
    throw new Error('Google Scholar parser stale: results container missing');
  }
  const expected = Math.min(resultBlocks, limit);
  if (parsedResults < expected) {
    throw new Error(`Google Scholar parser stale: parsed ${parsedResults}/${expected} result blocks`);
  }
}

export function classifyScholarBlock(
  status: number | undefined,
  bodyText: string,
  hasCaptcha: boolean,
): 'captcha' | 'rate_limited' | null {
  if (hasCaptcha) return 'captcha';
  if (status === 429) return 'rate_limited';
  if (/unusual traffic|automated queries|\ube44\uc815\uc0c1\uc801\uc778\s*\ud2b8\ub798\ud53d/i.test(bodyText)) {
    return 'rate_limited';
  }
  return null;
}

export function parseScholarResultsInBrowser(args: { limit: number }): ScholarResult[] {
  const clean = (value: string | null | undefined) =>
    (value ?? '').replace(/\s+/g, ' ').trim();
  const absolute = (href: string | null | undefined) => {
    if (!href) return undefined;
    try { return new URL(href, location.href).href; } catch { return undefined; }
  };
  const countFromText = (value: string) => {
    const digits = value.match(/[\d][\d,.'\s]*/)?.[0]?.replace(/\D/g, '');
    return digits ? Number(digits) : undefined;
  };

  const cards = Array.from(document.querySelectorAll<HTMLElement>(
    '.gs_r.gs_or.gs_scl, .gs_r.gs_or',
  ));
  const results: ScholarResult[] = [];

  for (let i = 0; i < cards.length && results.length < args.limit; i++) {
    const card = cards[i];
    const content = card.querySelector<HTMLElement>('.gs_ri') ?? card;
    const titleNode = content.querySelector<HTMLElement>('h3.gs_rt');
    if (!titleNode) continue;

    const titleClone = titleNode.cloneNode(true) as HTMLElement;
    titleClone.querySelectorAll('.gs_ctu, .gs_ctc').forEach((node) => node.remove());
    const title = clean(titleClone.textContent);
    if (!title) continue;

    const titleLink = titleNode.querySelector<HTMLAnchorElement>('a[href]');
    const titleUrl = absolute(titleLink?.getAttribute('href'));
    const metadata = clean(content.querySelector('.gs_a')?.textContent);
    const segments = metadata.split(/\s+-\s+/).filter(Boolean);
    const authors = segments[0] || undefined;
    const yearMatch = metadata.match(/\b(?:19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : undefined;

    let publication: string | undefined;
    let source: string | undefined;
    if (segments.length >= 3) {
      source = segments.at(-1);
      publication = segments.slice(1, -1).join(' - ');
    } else if (segments.length === 2 && !/^\d{4}$/.test(segments[1])) {
      publication = segments[1];
    }
    if (publication && year) {
      publication = publication.replace(new RegExp(`,?\\s*${year}\\s*$`), '').trim() || undefined;
    }

    const footerLinks = Array.from(content.querySelectorAll<HTMLAnchorElement>('.gs_fl a[href]'));
    const cited = footerLinks.find((link) => link.href.includes('cites='));
    const versions = footerLinks.find((link) => link.href.includes('cluster='));
    const related = footerLinks.find((link) => {
      try { return decodeURIComponent(link.href).includes('related:'); } catch { return false; }
    });
    const fullText = card.querySelector<HTMLAnchorElement>(
      '.gs_or_ggsm a[href], .gs_ggs.gs_fl a[href]',
    );

    results.push({
      rank: Number(card.dataset.rp) + 1 || i + 1,
      title,
      ...(titleUrl ? { url: titleUrl } : {}),
      ...(authors ? { authors } : {}),
      ...(publication ? { publication } : {}),
      ...(year ? { year } : {}),
      ...(source ? { source } : {}),
      snippet: clean(content.querySelector('.gs_rs')?.textContent).replace(/^Abstract\s+/i, ''),
      cited_by_count: cited ? countFromText(clean(cited.textContent)) ?? 0 : 0,
      ...(cited ? { cited_by_url: absolute(cited.getAttribute('href')) } : {}),
      ...(related ? { related_articles_url: absolute(related.getAttribute('href')) } : {}),
      ...(versions ? { versions_count: countFromText(clean(versions.textContent)) } : {}),
      ...(versions ? { versions_url: absolute(versions.getAttribute('href')) } : {}),
      ...(fullText ? { full_text_url: absolute(fullText.getAttribute('href')) } : {}),
      ...(card.dataset.cid ? { scholar_id: card.dataset.cid } : {}),
      metadata,
    });
  }

  return results;
}

async function readBlockState(page: Page, status?: number) {
  const hasCaptcha = await page.locator(
    '#gs_captcha_f, form#captcha-form, iframe[src*="recaptcha"]',
  ).count().then((count) => count > 0).catch(() => false);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return classifyScholarBlock(status, bodyText, hasCaptcha);
}

export async function scholarSearch(
  page: Page,
  query: string,
  limit = 10,
  opts: ScholarSearchOptions = {},
): Promise<ScholarResult[]> {
  const language = opts.locale?.split(/[-_]/)[0];
  const homeUrl = language ? `${SCHOLAR_HOME}?hl=${encodeURIComponent(language)}` : SCHOLAR_HOME;
  let homeStatus: number | undefined;
  try {
    const current = new URL(page.url());
    if (!current.hostname.startsWith('scholar.google.')) throw new Error('navigate');
  } catch {
    const response = await page.goto(homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    homeStatus = response?.status();
  }

  await dismissConsent(page);
  const homeBlock = await readBlockState(page, homeStatus);
  if (homeBlock === 'captcha') throw new CaptchaError('scholar-home', SCHOLAR_CAPTCHA_ACTION);
  if (homeBlock === 'rate_limited') throw new ScholarRateLimitError();

  const input = page.locator('input[name="q"]').first();
  if (await input.count() === 0) {
    throw new Error('Google Scholar parser stale: search input missing');
  }
  await input.focus({ timeout: 6_000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Delete');

  if (opts.humanlike) {
    await opts.humanlike.typeQuery(page, query);
  } else {
    for (const ch of query) await page.keyboard.type(ch, { delay: rand(8, 20) });
  }
  await sleep(rand(250, 600));

  const navigation = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  }).catch(() => null);
  await page.keyboard.press('Enter');
  const response = await navigation;

  const immediateBlock = await readBlockState(page, response?.status());
  if (immediateBlock === 'captcha') {
    throw new CaptchaError('scholar-after-search', SCHOLAR_CAPTCHA_ACTION);
  }
  if (immediateBlock === 'rate_limited') throw new ScholarRateLimitError();

  await page.waitForSelector('.gs_r.gs_or, #gs_captcha_f, #gs_res_ccl', {
    timeout: 10_000,
  }).catch(() => {});

  const block = await readBlockState(page);
  if (block === 'captcha') {
    throw new CaptchaError('scholar-after-search', SCHOLAR_CAPTCHA_ACTION);
  }
  if (block === 'rate_limited') throw new ScholarRateLimitError();

  const results = await page.evaluate(parseScholarResultsInBrowser, { limit });
  const resultBlocks = await page.locator('.gs_r.gs_or').count();
  const hasResultContainer = await page.locator('#gs_res_ccl').count().then((count) => count > 0);
  assertScholarParseCoverage(resultBlocks, results.length, limit, hasResultContainer);
  return results;
}

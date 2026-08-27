import type { Page } from 'playwright';
import type { SearchResult, ResultClassification, ParserStrategy } from './types.js';
import { detectBlock, dismissConsent } from './browser.js';
import { STRATEGIES, parseResultsInBrowser } from './parse.js';
import { verifyResultsGeometricInBrowser, aggregateConfidence } from './verify.js';
import { scoreResult, markerLocaleFor } from './score.js';
import { degradationVotes } from './triage.js';
import type { StrategyHealing } from './strategyHealing.js';
import type { HumanlikeBehavior } from './humanlike.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

export class CaptchaError extends Error {
  readonly userAction?: string;
  constructor(stage: string, userAction?: string) {
    super(`Google CAPTCHA at ${stage}`);
    this.name = 'CaptchaError';
    this.userAction = userAction;
  }
}

const DROP_CLASSIFICATIONS: ReadonlySet<ResultClassification> = new Set<ResultClassification>([
  'sponsored', 'knowledge_panel', 'related',
]);

const EARLY_EXIT_MIN_RESULTS = 5;
const EARLY_EXIT_MIN_CONFIDENCE = 0.7;

export interface SearchOptions {
  locale?: string;
  healing?: StrategyHealing;
  humanlike?: HumanlikeBehavior;
}

export interface SearchOutcome {
  results: SearchResult[];
  dropped: number;
  dropped_reasons: ResultClassification[];
  // Partial loss only; a total failure throws instead.
  degraded_reasons?: string[];
}

interface StrategyCandidate {
  strategy: ParserStrategy;
  results: SearchResult[];
  blockIndices: number[];
  h3Count: number;
  lang: string;
  verify: ReturnType<typeof verifyResultsGeometricInBrowser>;
  conf: number;
}

function externalHttpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.hostname === 'www.google.com' || url.hostname === 'accounts.google.com') return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export async function resolveGoogleResultUrl(
  value: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'www.google.com') return externalHttpUrl(value);
  if (url.pathname !== '/goto' && url.pathname !== '/url') return undefined;

  const direct = url.searchParams.get('q') || url.searchParams.get('url');
  const directUrl = direct ? externalHttpUrl(direct) : undefined;
  if (directUrl) return directUrl;

  try {
    const response = await fetchFn(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status < 300 || response.status >= 400) return undefined;
    const location = response.headers.get('location');
    return location ? externalHttpUrl(location, url.href) : undefined;
  } catch {
    return undefined;
  }
}

async function evaluateStrategy(
  page: Page,
  strategy: ParserStrategy,
  parseMax: number,
): Promise<StrategyCandidate> {
  const out = await page.evaluate(parseResultsInBrowser, {
    strategy: {
      blockSelector: strategy.blockSelector,
      linkSelector: strategy.linkSelector,
      snippetSelector: strategy.snippetSelector,
      adFilter: strategy.adFilter,
    },
    max: parseMax,
  });
  if (out.results.length === 0) {
    return { strategy, results: [], blockIndices: [], h3Count: out.signals.h3Count, lang: out.signals.lang, verify: [], conf: 0 };
  }
  const verify = await page.evaluate(verifyResultsGeometricInBrowser, {
    blockSelector: strategy.blockSelector,
  });
  return {
    strategy,
    results: out.results,
    blockIndices: out.blockIndices,
    h3Count: out.signals.h3Count,
    lang: out.signals.lang,
    verify,
    conf: aggregateConfidence(verify),
  };
}

export async function search(
  page: Page,
  query: string,
  limit = 10,
  opts: SearchOptions = {},
): Promise<SearchOutcome> {
  const url = page.url();
  const onResultsPage = url.includes('/search?');
  const onHome =
    url === 'https://www.google.com/' ||
    url === 'https://www.google.com';
  if (!onResultsPage && !onHome) {
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await sleep(rand(80, 160));
  }
  await dismissConsent(page);
  if (await detectBlock(page)) throw new CaptchaError('home');

  const sb = page.locator('textarea[name="q"], input[name="q"]').first();
  await sb.focus({ timeout: 6_000 });
  await sleep(rand(30, 70));

  if (onResultsPage) {
    await page.keyboard.press(SELECT_ALL);
    await page.keyboard.press('Delete');
  }

  if (opts.humanlike) {
    await opts.humanlike.typeQuery(page, query);
  } else {
    for (const ch of query) {
      await page.keyboard.type(ch, { delay: rand(8, 20) });
    }
  }
  await sleep(rand(250, 600));
  const beforeUrl = page.url();
  await page.keyboard.press('Enter');

  let waitErr: Error | null = null;
  const navTimeout = Number(process.env.SURF_NAV_TIMEOUT_MS) || 12_000;
  try {
    await page.waitForURL(u => u.href !== beforeUrl, { timeout: navTimeout });
  } catch (e) {
    waitErr = e as Error;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForSelector('h3, #search, [id="rso"]', { timeout: 8_000 }).catch(() => {});

  if (await detectBlock(page)) throw new CaptchaError('after-search');

  try {
    return await pickAndScoreResults(page, limit, {
      locale: opts.locale,
      waitErr,
      healing: opts.healing,
    });
  } catch (e) {
    if (await detectBlock(page).catch(() => false)) throw new CaptchaError('after-search');
    throw e;
  }
}

export interface PickOptions {
  locale?: string;
  waitErr?: Error | null;
  healing?: StrategyHealing;
}

export async function pickAndScoreResults(
  page: Page,
  limit: number,
  opts: PickOptions = {},
): Promise<SearchOutcome> {
  const parseMax = Math.max(limit * 2, limit + 5);
  const orderedIds = opts.healing
    ? opts.healing.getOrderedStrategyIds(STRATEGIES.map((s) => s.id))
    : STRATEGIES.map((s) => s.id);
  const orderedStrategies: ParserStrategy[] = orderedIds
    .map((id) => STRATEGIES.find((s) => s.id === id))
    .filter((s): s is ParserStrategy => !!s);
  // defensive: a corrupt persisted order must not silently drop strategies
  for (const s of STRATEGIES) {
    if (!orderedStrategies.find((x) => x.id === s.id)) orderedStrategies.push(s);
  }

  const candidates: StrategyCandidate[] = [];
  for (const strategy of orderedStrategies) {
    const cand = await evaluateStrategy(page, strategy, parseMax);
    candidates.push(cand);
    if (cand.results.length >= EARLY_EXIT_MIN_RESULTS && cand.conf >= EARLY_EXIT_MIN_CONFIDENCE) {
      break;
    }
  }

  const best = candidates.reduce<StrategyCandidate>((a, b) => {
    const score = (c: StrategyCandidate) => c.results.length * (1 + c.conf);
    return score(b) > score(a) ? b : a;
  }, candidates[0]);

  if (opts.healing) {
    for (const c of candidates) {
      if (c.results.length === 0) opts.healing.recordOutcome(c.strategy.id, 'zero');
      else if (c === best) opts.healing.recordOutcome(c.strategy.id, 'win');
      else opts.healing.recordOutcome(c.strategy.id, 'loss');
    }
  }

  // A peer rescuing the search hides that the leader broke. Early exit means no peer ran.
  const leader = candidates[0];
  const peerResults = candidates.length > 1
    ? Math.max(...candidates.slice(1).map((c) => c.results.length))
    : undefined;
  const degraded = degradationVotes({
    resultsLen: leader.results.length,
    h3Count: leader.h3Count,
    geometricConfidence: leader.results.length ? leader.conf : undefined,
    peerResults,
    baselineResults: opts.healing?.baselineResults(),
  });

  // A degraded count would drag the baseline down toward the broken value.
  if (opts.healing && leader.results.length > 0 && degraded.length === 0) {
    opts.healing.recordResultCount(leader.results.length);
  }

  if (best.results.length === 0) {
    if (opts.waitErr) {
      throw new Error(`search wait failed and no results: ${opts.waitErr.message.slice(0, 120)}`);
    }
    const maxH3 = candidates.reduce((m, c) => Math.max(m, c.h3Count), 0);
    if (maxH3 >= 5) {
      throw new Error(`parser stale: ${maxH3} h3 elements but 0 results extracted by any strategy`);
    }
    return { results: [], dropped: 0, dropped_reasons: [] };
  }

  // Google picks SERP language by IP, so the page's lang beats our config.
  const locale = markerLocaleFor(best.lang, opts.locale ?? 'en-US');
  const results: SearchResult[] = [];
  const accepted: SearchResult[] = [];
  const droppedSet = new Set<ResultClassification>();
  let droppedCount = 0;
  for (let i = 0; i < best.results.length; i++) {
    const r = best.results[i];
    const score = scoreResult(r, best.verify[best.blockIndices[i]], { locale });
    if (DROP_CLASSIFICATIONS.has(score.classification)) {
      droppedCount++;
      droppedSet.add(score.classification);
      continue;
    }
    accepted.push(r);
  }
  let unresolved = 0;
  for (let offset = 0; offset < accepted.length && results.length < limit; offset += 4) {
    const batch = accepted.slice(offset, offset + 4);
    const urls = await Promise.all(batch.map((result) => resolveGoogleResultUrl(result.url)));
    for (let i = 0; i < batch.length && results.length < limit; i++) {
      const resolved = urls[i];
      if (!resolved) {
        unresolved++;
        continue;
      }
      results.push({ ...batch[i], url: resolved });
    }
  }
  if (accepted.length > 0 && results.length === 0) {
    throw new Error(`parser stale: ${accepted.length} result targets could not be resolved`);
  }
  const degradedReasons = [
    ...degraded,
    ...(unresolved > 0 ? [`redirect_resolution_failed:${unresolved}`] : []),
  ];
  return {
    results,
    dropped: droppedCount,
    dropped_reasons: Array.from(droppedSet),
    ...(degradedReasons.length ? { degraded_reasons: degradedReasons } : {}),
  };
}

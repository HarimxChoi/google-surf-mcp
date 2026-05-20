import type { Page } from 'playwright';
import type { SearchResult, ResultClassification, ParserStrategy } from './types.js';
import { isBlocked } from './browser.js';
import { STRATEGIES, parseResultsInBrowser } from './parse.js';
import { verifyResultsGeometricInBrowser, aggregateConfidence } from './verify.js';
import { scoreResult } from './score.js';
import type { StrategyHealing } from './strategyHealing.js';

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
}

export interface SearchOutcome {
  results: SearchResult[];
  dropped: number;
  dropped_reasons: ResultClassification[];
}

interface StrategyCandidate {
  strategy: ParserStrategy;
  results: SearchResult[];
  blockIndices: number[];
  h3Count: number;
  verify: ReturnType<typeof verifyResultsGeometricInBrowser>;
  conf: number;
}

async function evaluateStrategy(
  page: Page,
  strategy: ParserStrategy,
  parseMax: number,
): Promise<StrategyCandidate> {
  const out = await page.evaluate(parseResultsInBrowser, {
    strategy: {
      blockSelector: strategy.blockSelector,
      snippetSelector: strategy.snippetSelector,
      adFilter: strategy.adFilter,
    },
    max: parseMax,
  });
  if (out.results.length === 0) {
    return { strategy, results: [], blockIndices: [], h3Count: out.signals.h3Count, verify: [], conf: 0 };
  }
  const verify = await page.evaluate(verifyResultsGeometricInBrowser, {
    blockSelector: strategy.blockSelector,
  });
  return {
    strategy,
    results: out.results,
    blockIndices: out.blockIndices,
    h3Count: out.signals.h3Count,
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
  const beforeUrl = page.url();
  await page.keyboard.press('Enter');

  let waitErr: Error | null = null;
  try {
    await page.waitForURL(u => u.href !== beforeUrl, { timeout: 5_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 4_000 });
    await page.waitForSelector('h3, #search, [id="rso"]', { timeout: 4_000 });
  } catch (e) {
    waitErr = e as Error;
  }

  if (isBlocked(page.url())) throw new CaptchaError('after-search');

  return await pickAndScoreResults(page, limit, {
    locale: opts.locale,
    waitErr,
    healing: opts.healing,
  });
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

  const locale = opts.locale ?? 'en-US';
  const results: SearchResult[] = [];
  const droppedSet = new Set<ResultClassification>();
  let droppedCount = 0;
  for (let i = 0; i < best.results.length; i++) {
    if (results.length >= limit) break;
    const r = best.results[i];
    const score = scoreResult(r, best.verify[best.blockIndices[i]], { locale });
    if (DROP_CLASSIFICATIONS.has(score.classification)) {
      droppedCount++;
      droppedSet.add(score.classification);
      continue;
    }
    results.push(r);
  }
  return { results, dropped: droppedCount, dropped_reasons: Array.from(droppedSet) };
}

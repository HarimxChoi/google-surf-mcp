// Browser-context parser. parseResultsInBrowser runs inside page.evaluate,
// so it must not import modules or close over outer scope.

import type { ParserStrategy, ParseSignals } from './types.js';

export const STRATEGIES: ParserStrategy[] = [
  {
    id: 'data-ved-anchor-v1',
    blockSelector: 'div[data-ved], div[data-snc], div[data-hveid]',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'data-ved attribute first',
  },
  {
    id: 'class-mjjyud-v1',
    blockSelector: 'div.g, div.MjjYud, div.tF2Cxc',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'class-name based',
  },
  {
    id: 'hveid-jscontroller-v1',
    blockSelector: 'div[data-hveid][jscontroller]',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'hveid + jscontroller combo',
  },
];

export interface ParsedResult {
  title: string;
  url: string;
  description: string;
}

export interface ParseOutput {
  results: ParsedResult[];
  blockIndices: number[];
  signals: ParseSignals;
}

export interface LegacyParseOutput {
  results: ParsedResult[];
  h3Count: number;
}

export function parseResultsInBrowser(args: {
  strategy: { blockSelector: string; snippetSelector: string; adFilter: string };
  max: number;
}): ParseOutput {
  const SKIP_HOSTS = new Set([
    'www.google.com',
    'accounts.google.com',
    'webcache.googleusercontent.com',
    'translate.google.com',
  ]);
  const seen = new Set<string>();
  const results: ParsedResult[] = [];
  const blockIndices: number[] = [];

  const allElements = document.querySelectorAll('*');
  const h3Count = document.querySelectorAll('h3').length;
  const externalLinks = document.querySelectorAll('a[href^="http"]');
  let externalLinkCount = 0;
  externalLinks.forEach((a) => {
    try {
      const href = (a as HTMLAnchorElement).href;
      const host = new URL(href).hostname;
      if (!host.includes('google.com')) externalLinkCount++;
    } catch { /* malformed href */ }
  });
  const hveidCount = document.querySelectorAll('[data-hveid]').length;

  const classTokens = new Set<string>();
  allElements.forEach((el) => {
    if (el.className && typeof el.className === 'string') {
      el.className.split(/\s+/).forEach((t) => { if (t) classTokens.add(t); });
    }
  });

  const main = document.querySelector('#rso') ?? document.querySelector('#search');
  const skeletonTags: string[] = [];
  if (main) {
    main.querySelectorAll('*').forEach((el) => {
      if (skeletonTags.length < 200) skeletonTags.push(el.tagName);
    });
  }
  const layoutSignature =
    `${skeletonTags.length}-` +
    skeletonTags.slice(0, 20).join(',') +
    '|' +
    skeletonTags.slice(-20).join(',');

  const READ_MORE = /\s*(?:\.{3}|…)?\s*(?:Read more|More results|더보기)\s*$/i; // i18n-data

  const blocks = document.querySelectorAll(args.strategy.blockSelector);
  const blocksArr = Array.from(blocks);
  for (let i = 0; i < blocksArr.length; i++) {
    const el = blocksArr[i];
    if (
      el.matches('[data-text-ad], [data-pcu]') ||
      el.closest(args.strategy.adFilter)
    ) continue;

    const t = el.querySelector('h3');
    const a = el.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
    if (!t || !a) continue;

    const url = a.href;
    if (seen.has(url)) continue;

    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (SKIP_HOSTS.has(host)) continue;
    seen.add(url);

    const sn =
      el.querySelector('[data-sncf="1"]') ||
      el.querySelector('.VwiC3b') ||
      el.querySelector('div[style*="-webkit-line-clamp"]');

    results.push({
      title: (t.textContent || '').trim(),
      url,
      description: (sn?.textContent || '').trim().replace(READ_MORE, '').slice(0, 600),
    });
    blockIndices.push(i);

    if (results.length >= args.max) break;
  }

  return {
    results,
    blockIndices,
    signals: { h3Count, externalLinkCount, hveidCount, classTokenSize: classTokens.size, layoutSignature },
  };
}

export function parseResults(max: number): LegacyParseOutput {
  const out = parseResultsInBrowser({ strategy: STRATEGIES[1], max });
  return { results: out.results, h3Count: out.signals.h3Count };
}

export interface StrategyAttempt {
  strategy: ParserStrategy;
  output: ParseOutput;
}

export function pickBestAttempt(attempts: StrategyAttempt[]): StrategyAttempt {
  return attempts.reduce((best, current) => {
    if (current.output.results.length > best.output.results.length) return current;
    return best;
  });
}

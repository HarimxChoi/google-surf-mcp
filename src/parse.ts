// Browser-context parser. parseResultsInBrowser runs inside page.evaluate,
// so it must not import modules or close over outer scope.

import type { ParserStrategy, ParseSignals } from './types.js';

export const STRATEGIES: ParserStrategy[] = [
  {
    id: 'class-mjjyud-v1',
    blockSelector: 'div.g, div.MjjYud, div.tF2Cxc',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'class-name based',
  },
  {
    id: 'data-snc-goto-v1',
    blockSelector: 'div[data-snc]',
    linkSelector: 'a[jsname="UWckNb"][href*="/goto?"]',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'data-snc result with opaque goto link',
  },
  {
    id: 'hveid-jscontroller-v1',
    blockSelector: 'div[data-hveid][jscontroller]',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'hveid + jscontroller combo',
  },
  {
    id: 'data-ved-anchor-v1',
    blockSelector: 'div[data-ved], div[data-snc], div[data-hveid]',
    snippetSelector: '[data-sncf="1"], .VwiC3b, div[style*="-webkit-line-clamp"]',
    adFilter: '#tads, #tadsb, #bottomads, [aria-label*="Sponsored" i], [data-text-ad], [data-pcu]',
    description: 'data-ved attribute, broad fallback',
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
  strategy: {
    blockSelector: string;
    linkSelector?: string;
    snippetSelector: string;
    adFilter: string;
  };
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
  const externalLinks = document.querySelectorAll('a[href]');
  let externalLinkCount = 0;
  externalLinks.forEach((a) => {
    try {
      const href = (a as HTMLAnchorElement).href;
      const parsed = new URL(href);
      const wrapped = parsed.hostname === 'www.google.com'
        && (parsed.pathname === '/goto' || parsed.pathname === '/url');
      if (!parsed.hostname.includes('google.com') || wrapped) externalLinkCount++;
    } catch { /* malformed href */ }
  });
  const hveidCount = document.querySelectorAll('[data-hveid]').length;
  const lang = document.documentElement.lang || '';

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

  const READ_MORE = /\s*(?:\.{3}|…)?\s*(?:Read more|More results|\uB354\uBCF4\uAE30)\s*$/i; // i18n data

  const blocks = document.querySelectorAll(args.strategy.blockSelector);
  const blocksArr = Array.from(blocks);
  for (let i = 0; i < blocksArr.length; i++) {
    const el = blocksArr[i];
    if (
      el.matches('[data-text-ad], [data-pcu]') ||
      el.closest(args.strategy.adFilter)
    ) continue;

    const t = el.querySelector('h3');
    const a = (args.strategy.linkSelector
      ? el.querySelector(args.strategy.linkSelector)
      : t?.closest('a[href]') ?? el.querySelector('a[href]')) as HTMLAnchorElement | null;
    if (!t || !a || !a.contains(t)) continue;

    let url = a.href;
    try {
      const wrapped = new URL(a.getAttribute('href') || '', document.location.origin);
      if (wrapped.hostname === 'www.google.com'
        && (wrapped.pathname === '/goto' || wrapped.pathname === '/url')) {
        const direct = wrapped.searchParams.get('q') || wrapped.searchParams.get('url');
        url = direct && /^https?:\/\//i.test(direct) ? direct : wrapped.href;
      }
    } catch {}
    if (seen.has(url)) continue;

    let host = '';
    let path = '';
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch { continue; }
    const wrappedGoogle = host === 'www.google.com' && (path === '/goto' || path === '/url');
    if (SKIP_HOSTS.has(host) && !wrappedGoogle) continue;
    seen.add(url);

    const sn = el.querySelector(args.strategy.snippetSelector);

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
    signals: { h3Count, externalLinkCount, hveidCount, classTokenSize: classTokens.size, layoutSignature, lang },
  };
}

export function parseResults(max: number): LegacyParseOutput {
  const out = parseResultsInBrowser({ strategy: STRATEGIES[0], max });
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

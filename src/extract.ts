import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import type { BrowserContext, Page } from 'playwright';
import TurndownService from 'turndown';
import { fenceUntrustedContent } from './response.js';

const require = createRequire(import.meta.url);
const READABILITY_PATH: string = require.resolve('@mozilla/readability/Readability.js');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  hr: '---',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'iframe', 'noscript']);

export interface ExtractResult {
  url: string;
  title?: string;
  content?: string;
  excerpt?: string;
  length?: number;
  error?: string;
}

interface ReadabilityOutput {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  length: number;
  byline?: string;
  siteName?: string;
}

const NAV_SELECTORS = [
  'script', 'style', 'nav', 'header', 'footer', 'aside',
  'iframe', 'noscript', 'form',
  '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]', '[role="complementary"]',
];

// SSRF guard: block private/internal addresses unless SURF_ALLOW_PRIVATE=true.
// Pattern-only (no DNS resolve), covers literal IPs in URL.
// Env-only by design: per-call arg would let LLM bypass via prompt injection.
const PRIVATE_PATTERNS = [
  /^https?:\/\/127\./i,
  /^https?:\/\/10\./,
  /^https?:\/\/169\.254\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/0\./,
  /^https?:\/\/\[?::1\]?/i,
  /^https?:\/\/\[?(fc|fd|fe80)/i,
];

const PRIVATE_HOSTS = new Set(['localhost', '0.0.0.0', '::1']);

export function checkUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'invalid url'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `unsupported protocol: ${u.protocol}`;
  }
  if (process.env.SURF_ALLOW_PRIVATE === 'true') return null;
  if (PRIVATE_HOSTS.has(u.hostname.toLowerCase())) {
    return 'private/internal address blocked';
  }
  if (PRIVATE_PATTERNS.some((r) => r.test(url))) {
    return 'private/internal address blocked';
  }
  return null;
}

// DNS resolve before navigation to defeat DNS rebinding (evil.com → 127.0.0.1).
const dnsCache = new Map<string, { addr: string; expiresAt: number }>();

function isPrivateAddress(addr: string): boolean {
  const fakeUrl = `http://${addr}`;
  if (PRIVATE_PATTERNS.some((r) => r.test(fakeUrl))) return true;
  if (PRIVATE_HOSTS.has(addr.toLowerCase())) return true;
  return false;
}

export async function checkUrlAsync(url: string): Promise<string | null> {
  const sync = checkUrl(url);
  if (sync) return sync;

  if (process.env.SURF_ALLOW_PRIVATE === 'true') return null;

  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'invalid url'; }

  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return isPrivateAddress(cached.addr) ? 'resolved to private address' : null;
  }

  try {
    const { address } = await lookup(host);
    dnsCache.set(host, { addr: address, expiresAt: Date.now() + 5 * 60_000 });
    if (isPrivateAddress(address)) return 'resolved to private address';
    return null;
  } catch {
    // Let the actual navigation surface DNS failures.
    return null;
  }
}

export interface ExtractOptions {
  maxChars?: number;
  navTimeoutMs?: number;
  // Wrap body with UNTRUSTED CONTENT markers to discourage prompt injection.
  fence?: boolean;
}

export async function extract(
  ctx: BrowserContext,
  url: string,
  optsOrMaxChars: ExtractOptions | number = 8_000,
  legacyNavTimeoutMs?: number,
): Promise<ExtractResult> {
  const opts: ExtractOptions = typeof optsOrMaxChars === 'number'
    ? { maxChars: optsOrMaxChars, navTimeoutMs: legacyNavTimeoutMs }
    : optsOrMaxChars;
  const maxChars = opts.maxChars ?? 8_000;
  const navTimeoutMs = opts.navTimeoutMs ?? 10_000;
  const fence = opts.fence ?? false;

  const checkErr = await checkUrlAsync(url);
  if (checkErr) return { url, error: checkErr };

  let page: Page | null = null;
  try {
    page = await ctx.newPage();

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    if (resp && resp.status() >= 400) {
      return { url, error: `http ${resp.status()}` };
    }

    // SPA settle delay
    await page.waitForTimeout(500);

    await page.addScriptTag({ path: READABILITY_PATH }).catch(() => {});

    const article = await page.evaluate(() => {
      try {
        const W = window as unknown as { Readability?: new (doc: Document) => { parse: () => ReadabilityOutput | null } };
        if (!W.Readability) return null;
        const cloned = document.cloneNode(true) as Document;
        const reader = new W.Readability(cloned);
        return reader.parse();
      } catch {
        return null;
      }
    }) as ReadabilityOutput | null;

    if (article && article.content) {
      const md = turndown.turndown(article.content).slice(0, maxChars);
      return {
        url,
        title: article.title || undefined,
        content: fence ? fenceUntrustedContent(md) : md,
        excerpt: (article.excerpt || article.textContent || '').slice(0, 200).trim() || undefined,
        length: md.length,
      };
    }

    const fallback = await page.evaluate((sel: string[]) => {
      sel.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      const text = (main as HTMLElement).innerText || '';
      const title = document.title;
      return { title, text: text.replace(/\n{3,}/g, '\n\n').trim() };
    }, NAV_SELECTORS);

    if (!fallback.text) {
      return { url, title: fallback.title || undefined, error: 'no extractable content' };
    }

    const text = fallback.text.slice(0, maxChars);
    return {
      url,
      title: fallback.title || undefined,
      content: fence ? fenceUntrustedContent(text) : text,
      excerpt: text.slice(0, 200),
      length: text.length,
    };
  } catch (e) {
    return { url, error: (e as Error).message.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

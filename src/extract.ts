import { createRequire } from 'node:module';
import type { BrowserContext, Page } from 'playwright';
import TurndownService from 'turndown';

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

export async function extract(
  ctx: BrowserContext,
  url: string,
  maxChars = 8_000,
  navTimeoutMs = 10_000,
): Promise<ExtractResult> {
  const checkErr = checkUrl(url);
  if (checkErr) return { url, error: checkErr };

  let page: Page | null = null;
  try {
    page = await ctx.newPage();

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    if (resp && resp.status() >= 400) {
      return { url, error: `http ${resp.status()}` };
    }

    // SPA settle: wait briefly for JS-rendered content
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
        content: md,
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
      content: text,
      excerpt: text.slice(0, 200),
      length: text.length,
    };
  } catch (e) {
    return { url, error: (e as Error).message.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

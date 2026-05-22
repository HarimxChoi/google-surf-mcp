import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import type { BrowserContext, Page } from 'playwright';
import TurndownService from 'turndown';
import { fenceUntrustedContent } from './response.js';
import {
  isPdfMagic, isPdfContentType, extractPdfTiered, type PdfMode,
} from './extract-pdf.js';
import {
  findCitationPdfUrl, findAbstractFromMeta, findTitle,
  domainPdfTransform, findPmcUrlFromPubmed,
} from './extract-meta.js';

const require = createRequire(import.meta.url);
const READABILITY_PATH: string = require.resolve('@mozilla/readability/Readability.js');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  hr: '---',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'iframe', 'noscript']);

export type ExtractMode = 'full' | 'abstract' | 'metadata';
export type ExtractionQuality = 'full_text' | 'abstract' | 'meta_abstract' | 'metadata_only';

export interface ExtractResult {
  url: string;
  title?: string;
  content?: string;
  excerpt?: string;
  length?: number;
  is_pdf?: boolean;
  page_count?: number;
  extraction_quality?: ExtractionQuality;
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
    return null;
  }
}

export interface ExtractOptions {
  maxChars?: number;
  navTimeoutMs?: number;
  fence?: boolean;
  mode?: ExtractMode;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; google-surf-mcp)';

interface FetchResp { status: number; ct: string; buf: Buffer; finalUrl: string }

async function readBounded(r: Response): Promise<Buffer> {
  if (!r.body) return Buffer.from(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_FETCH_BYTES) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }
  return Buffer.concat(chunks);
}

class SsrfBlockedError extends Error {
  constructor(reason: string, public readonly target: string) {
    super(`${reason}: ${target}`);
    this.name = 'SsrfBlockedError';
  }
}

async function plainFetch(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResp | null> {
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const ssrfErr = await checkUrlAsync(currentUrl);
      if (ssrfErr) throw new SsrfBlockedError(ssrfErr, currentUrl);
      let r: Response;
      try {
        r = await fetch(currentUrl, {
          redirect: 'manual',
          headers: { 'user-agent': UA },
          signal: ctrl.signal,
        });
      } catch {
        return null;
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (loc) {
          try { currentUrl = new URL(loc, currentUrl).href; }
          catch { return null; }
          continue;
        }
      }
      let buf: Buffer;
      try { buf = await readBounded(r); }
      catch { return null; }
      return {
        status: r.status,
        ct: r.headers.get('content-type') || '',
        buf,
        finalUrl: currentUrl,
      };
    }
    return null;
  } finally {
    clearTimeout(handle);
  }
}

async function fetchPdfBuf(url: string): Promise<{ buf: Uint8Array; finalUrl: string } | null> {
  const r = await plainFetch(url);
  if (!r || r.status >= 400) return null;
  if (!isPdfMagic(r.buf)) return null;
  return { buf: new Uint8Array(r.buf), finalUrl: r.finalUrl };
}

async function discoverViaFetch(
  url: string,
  mode: ExtractMode,
  maxChars: number,
): Promise<ExtractResult | null> {
  const r = await plainFetch(url);
  if (!r) return null;
  if (r.status >= 400) return null;

  if (isPdfContentType(r.ct) || isPdfMagic(r.buf)) {
    try {
      const out = await extractPdfTiered(new Uint8Array(r.buf), mode as PdfMode, maxChars);
      return { url: r.finalUrl, ...out };
    } catch (e) {
      return { url: r.finalUrl, error: `pdf parse failed: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  const html = r.buf.toString('utf-8');
  const title = findTitle(html);

  if (mode === 'abstract') {
    const meta = findAbstractFromMeta(html);
    if (meta) {
      const content = meta.content.slice(0, maxChars);
      return {
        url: r.finalUrl,
        title,
        content,
        excerpt: content.slice(0, 200),
        length: content.length,
        extraction_quality: 'meta_abstract',
      };
    }
  }

  const pdfCandidates: Array<string | null> = [
    findCitationPdfUrl(html, r.finalUrl),
    domainPdfTransform(r.finalUrl),
  ];
  for (const candidate of pdfCandidates) {
    if (!candidate) continue;
    const pdf = await fetchPdfBuf(candidate);
    if (!pdf) continue;
    try {
      const out = await extractPdfTiered(pdf.buf, mode as PdfMode, maxChars);
      return { url: pdf.finalUrl, title, ...out };
    } catch {
      continue;
    }
  }

  const pmcUrl = findPmcUrlFromPubmed(html);
  if (pmcUrl) {
    const pmcR = await plainFetch(pmcUrl);
    if (pmcR && pmcR.status < 400) {
      const pmcHtml = pmcR.buf.toString('utf-8');
      const pmcPdfUrl = findCitationPdfUrl(pmcHtml, pmcR.finalUrl);
      if (pmcPdfUrl) {
        const pdf = await fetchPdfBuf(pmcPdfUrl);
        if (pdf) {
          try {
            const out = await extractPdfTiered(pdf.buf, mode as PdfMode, maxChars);
            return { url: pdf.finalUrl, title, ...out };
          } catch {}
        }
      }
    }
  }

  return null;
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
  const mode: ExtractMode = opts.mode ?? 'full';

  const checkErr = await checkUrlAsync(url);
  if (checkErr) return { url, error: checkErr };

  let discovered: ExtractResult | null;
  try {
    discovered = await discoverViaFetch(url, mode, maxChars);
  } catch (e) {
    if (e instanceof SsrfBlockedError) return { url, error: e.message };
    throw e;
  }
  if (discovered) {
    if (fence && discovered.content) {
      discovered.content = fenceUntrustedContent(discovered.content);
    }
    return discovered;
  }
  if (mode === 'metadata') return { url };

  let page: Page | null = null;
  try {
    page = await ctx.newPage();

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });

    // page.goto follows server-side redirects unchecked; a public URL can 30x
    // into a private address (e.g. cloud metadata). Re-verify the landed URL.
    const landedUrl = resp?.url() ?? page.url();
    if (landedUrl !== url) {
      const redirectErr = await checkUrlAsync(landedUrl);
      if (redirectErr) return { url, error: `${redirectErr} (redirected)` };
    }

    if (resp && resp.status() >= 400) {
      return { url, error: `http ${resp.status()}` };
    }

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
        extraction_quality: 'full_text',
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
      extraction_quality: 'full_text',
    };
  } catch (e) {
    return { url, error: (e as Error).message.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

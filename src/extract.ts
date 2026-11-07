import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { BrowserContext, Page } from 'playwright';
import TurndownService from 'turndown';
import { Agent } from 'undici';
import { fenceUntrustedContent } from './response.js';
import { classifyExtractedText, type ExtractionQuality } from './extractionQuality.js';
import {
  isPdfMagic, isPdfContentType, extractPdfTiered, type PdfMode,
} from './extract-pdf.js';
import {
  findCitationPdfUrl, findAbstractFromMeta,
  domainPdfTransform, findDocumentMetadata, findPmcUrlFromPubmed,
  type DocumentMetadata,
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
export type { ExtractionQuality } from './extractionQuality.js';

export interface ExtractResult extends DocumentMetadata {
  url: string;
  content?: string;
  excerpt?: string;
  length?: number;
  source_length?: number;
  truncated?: boolean;
  is_pdf?: boolean;
  page_count?: number;
  extraction_quality?: ExtractionQuality;
  quality_reason?: string;
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
  linkRatio?: number;
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
const blockedAddresses = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8], ['10.0.0.0',8], ['127.0.0.0',8], ['169.254.0.0',16],
  ['172.16.0.0',12], ['192.168.0.0',16], ['100.64.0.0',10], ['192.0.0.0',24], ['192.0.2.0',24],
  ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4]] as const) blockedAddresses.addSubnet(address,prefix,'ipv4');
for (const [address, prefix] of [['::',128], ['::1',128], ['fc00::',7], ['fe80::',10], ['ff00::',8],
  ['2001:db8::',32], ['2001::',32], ['2002::',16], ['64:ff9b::',96]] as const) blockedAddresses.addSubnet(address,prefix,'ipv6');

export function checkUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'invalid url'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `unsupported protocol: ${u.protocol}`;
  }
  if (u.username || u.password) return 'credentialed URLs are not supported';
  if (process.env.SURF_ALLOW_PRIVATE === 'true') return null;
  if (PRIVATE_HOSTS.has(u.hostname.toLowerCase())) {
    return 'private/internal address blocked';
  }
  if (PRIVATE_PATTERNS.some((r) => r.test(u.href)) || isPrivateAddress(u.hostname)) {
    return 'private/internal address blocked';
  }
  return null;
}

function isPrivateAddress(addr: string): boolean {
  const normalized = addr.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family && blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (normalized === '::' || normalized === '::1') return true;
  if (/^(?:fc|fd|fe[89ab])/.test(normalized)) return true;
  const fakeUrl = `http://${normalized}`;
  if (PRIVATE_PATTERNS.some((r) => r.test(fakeUrl))) return true;
  if (PRIVATE_HOSTS.has(normalized)) return true;
  return false;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublicAddress(url: string): Promise<ResolvedAddress> {
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('resolved to private address');
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('dns resolution returned no addresses');
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('resolved to private address');
  }
  return addresses[0] as ResolvedAddress;
}

export async function checkUrlAsync(url: string): Promise<string | null> {
  const sync = checkUrl(url);
  if (sync) return sync;

  if (process.env.SURF_ALLOW_PRIVATE === 'true') return null;

  try {
    await resolvePublicAddress(url);
    return null;
  } catch {
    return 'dns resolution failed or returned a private address';
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

interface DiscoveryResult {
  result: ExtractResult | null;
  metadata?: DocumentMetadata;
}

async function readBounded(r: Response, strict = false): Promise<Buffer> {
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
    if (total > MAX_FETCH_BYTES || (!strict && total === MAX_FETCH_BYTES)) {
      try { await reader.cancel(); } catch {}
      if (strict) throw new Error('browser resource exceeds 25 MiB');
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

export async function fetchBrowserResource(url: string, headers: Record<string, string>, method = 'GET') {
  const reason = checkUrl(url);
  if (reason) throw new SsrfBlockedError(reason, url);
  if (method !== 'GET' && method !== 'HEAD') throw new Error('source reader allows GET and HEAD only');
  const resolved = process.env.SURF_ALLOW_PRIVATE === 'true' ? undefined : await resolvePublicAddress(url);
  const dispatcher = resolved ? new Agent({ connect: { lookup: (_host, options, callback) => {
    if (options.all) callback(null, [resolved]); else callback(null, resolved.address, resolved.family);
  } } }) : undefined;
  const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => !['host', 'cookie', 'authorization', 'proxy-authorization', 'content-length'].includes(name.toLowerCase())));
  try {
    const response = await fetch(url, { method, headers: safeHeaders, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}) } as RequestInit & { dispatcher?: Agent });
    const body = await readBounded(response, true);
    const responseHeaders = Object.fromEntries([...response.headers].filter(([name]) => !['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(name)));
    return { status: response.status, headers: responseHeaders, body };
  } finally { await dispatcher?.close().catch(() => {}); }
}

async function plainFetch(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResp | null> {
  const ctrl = new AbortController();
  const handle = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const ssrfErr = await checkUrlAsync(currentUrl);
      if (ssrfErr) throw new SsrfBlockedError(ssrfErr, currentUrl);
      const resolved = process.env.SURF_ALLOW_PRIVATE === 'true'
        ? undefined
        : await resolvePublicAddress(currentUrl);
      const dispatcher = resolved ? new Agent({
        connect: {
          lookup: (_hostname, _options, callback) => {
            if (_options.all) callback(null, [resolved]);
            else callback(null, resolved.address, resolved.family);
          },
        },
      }) : undefined;
      let r: Response;
      try {
        r = await fetch(currentUrl, {
          redirect: 'manual',
          headers: { 'user-agent': UA },
          signal: ctrl.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit & { dispatcher?: Agent });
      } catch {
        await dispatcher?.close().catch(() => {});
        return null;
      }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (loc) {
          await r.body?.cancel().catch(() => {});
          await dispatcher?.close().catch(() => {});
          try { currentUrl = new URL(loc, currentUrl).href; }
          catch { return null; }
          continue;
        }
      }
      let buf: Buffer;
      try { buf = await readBounded(r); }
      catch { return null; }
      finally { await dispatcher?.close().catch(() => {}); }
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
): Promise<DiscoveryResult> {
  const r = await plainFetch(url);
  if (!r) return { result: null };
  if (r.status >= 400) return mode === 'metadata'
    ? { result: { url: r.finalUrl, error: `http ${r.status}`, extraction_quality: 'blocked', quality_reason: `http_${r.status}` } }
    : { result: null };

  if (isPdfContentType(r.ct) || isPdfMagic(r.buf)) {
    try {
      const out = await extractPdfTiered(new Uint8Array(r.buf), mode as PdfMode, maxChars);
      return { result: { url: r.finalUrl, ...out } };
    } catch (e) {
      return { result: { url: r.finalUrl, error: `pdf parse failed: ${(e as Error).message.slice(0, 120)}` } };
    }
  }

  const html = r.buf.toString('utf-8');
  const metadata = findDocumentMetadata(html, r.finalUrl);
  const metaAbstract = mode === 'abstract' ? findAbstractFromMeta(html) : null;

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
      return { result: { url: pdf.finalUrl, ...out, ...metadata } };
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
            const pmcMetadata = findDocumentMetadata(pmcHtml, pmcR.finalUrl);
            return { result: { url: pdf.finalUrl, ...out, ...metadata, ...pmcMetadata } };
          } catch {}
        }
      }
    }
  }

  if (metaAbstract) {
    const quality = classifyExtractedText(metadata.title ?? '', metaAbstract.content);
    if (quality.extraction_quality === 'blocked' || quality.extraction_quality === 'consent_required') {
      return { result: { url: r.finalUrl, ...metadata, ...quality, error: quality.quality_reason } };
    }
    const content = metaAbstract.content.slice(0, maxChars);
    return { result: {
      url: r.finalUrl,
      ...metadata,
      content,
      excerpt: content.slice(0, 200),
      length: content.length,
      source_length: metaAbstract.content.length,
      truncated: metaAbstract.content.length > maxChars,
      extraction_quality: 'meta_abstract',
    } };
  }

  if (mode === 'metadata') {
    return { result: {
      url: r.finalUrl,
      ...metadata,
      excerpt: metadata.description?.slice(0, 200),
      is_pdf: false,
      extraction_quality: 'metadata_only',
    } };
  }

  return { result: null, metadata };
}

export async function extract(
  ctx: BrowserContext | (() => Promise<BrowserContext>),
  url: string,
  optsOrMaxChars: ExtractOptions | number = 50_000,
  legacyNavTimeoutMs?: number,
): Promise<ExtractResult> {
  const opts: ExtractOptions = typeof optsOrMaxChars === 'number'
    ? { maxChars: optsOrMaxChars, navTimeoutMs: legacyNavTimeoutMs }
    : optsOrMaxChars;
  const maxChars = opts.maxChars ?? 50_000;
  const navTimeoutMs = opts.navTimeoutMs ?? 10_000;
  const fence = opts.fence ?? false;
  const mode: ExtractMode = opts.mode ?? 'full';

  const checkErr = await checkUrlAsync(url);
  if (checkErr) return { url, error: checkErr };

  let discovery: DiscoveryResult;
  try {
    discovery = await discoverViaFetch(url, mode, maxChars);
  } catch (e) {
    if (e instanceof SsrfBlockedError) return { url, error: e.message };
    throw e;
  }
  const discovered = discovery.result;
  if (discovered) {
    if (fence && discovered.content) {
      discovered.content = fenceUntrustedContent(discovered.content);
    }
    return discovered;
  }
  if (mode === 'metadata') return { url, extraction_quality: 'metadata_only' };

  let page: Page | null = null;
  try {
    const context = typeof ctx === 'function' ? await ctx() : ctx;
    page = await context.newPage();

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });

    // page.goto follows server-side redirects unchecked; a public URL can 30x
    // into a private address (e.g. cloud metadata). Re-verify the landed URL.
    const landedUrl = resp?.url() ?? page.url();
    if (landedUrl !== url) {
      const redirectErr = await checkUrlAsync(landedUrl);
      if (redirectErr) return { url, error: `${redirectErr} (redirected)` };
    }

    if (resp && resp.status() >= 400) {
      return { url, error: `http ${resp.status()}`, extraction_quality: 'blocked', quality_reason: `http_${resp.status()}` };
    }

    await page.waitForTimeout(500);

    await page.addScriptTag({ path: READABILITY_PATH }).catch(() => {});

    const article = await page.evaluate(() => {
      try {
        const W = window as unknown as { Readability?: new (doc: Document) => { parse: () => ReadabilityOutput | null } };
        if (!W.Readability) return null;
        const cloned = document.cloneNode(true) as Document;
        const reader = new W.Readability(cloned);
        const output = reader.parse();
        if (!output) return output;
        const node = new DOMParser().parseFromString(output.content, 'text/html');
        const linkLength = [...node.querySelectorAll('a')].reduce((sum, link) => sum + (link.textContent?.length ?? 0), 0);
        return { ...output, linkRatio: linkLength / Math.max(1, output.textContent.length) };
      } catch {
        return null;
      }
    }) as ReadabilityOutput | null;

    if (article && article.content) {
      const raw = turndown.turndown(article.content);
      const quality = classifyExtractedText(article.title || '', raw, article.linkRatio);
      if (quality.extraction_quality === 'blocked' || quality.extraction_quality === 'consent_required') {
        return { url, title: article.title, ...quality, error: quality.quality_reason };
      }
      const md = raw.slice(0, maxChars);
      return {
        url,
        ...discovery.metadata,
        title: discovery.metadata?.title || article.title || undefined,
        authors: discovery.metadata?.authors || article.byline || undefined,
        publication: discovery.metadata?.publication || article.siteName || undefined,
        content: fence ? fenceUntrustedContent(md) : md,
        excerpt: (article.excerpt || article.textContent || '').slice(0, 200).trim() || undefined,
        length: md.length,
        source_length: raw.length,
        truncated: raw.length > maxChars,
        ...quality,
      };
    }

    const fallback = await page.evaluate((sel: string[]) => {
      sel.forEach(s => document.querySelectorAll(s).forEach(e => e.remove()));
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      const text = (main as HTMLElement).innerText || '';
      const title = document.title;
      const linkLength = [...main.querySelectorAll('a')].reduce((sum, link) => sum + ((link as HTMLElement).innerText?.length ?? 0), 0);
      return { title, text: text.replace(/\n{3,}/g, '\n\n').trim(), linkRatio: linkLength / Math.max(1, text.length) };
    }, NAV_SELECTORS);

    if (!fallback.text) {
      return { url, title: fallback.title || undefined, error: 'no extractable content' };
    }

    const text = fallback.text.slice(0, maxChars);
    const quality = classifyExtractedText(fallback.title, fallback.text, fallback.linkRatio);
    if (quality.extraction_quality === 'blocked' || quality.extraction_quality === 'consent_required') {
      return { url, title: fallback.title, ...quality, error: quality.quality_reason };
    }
    return {
      url,
      ...discovery.metadata,
      title: discovery.metadata?.title || fallback.title || undefined,
      content: fence ? fenceUntrustedContent(text) : text,
      excerpt: text.slice(0, 200),
      length: text.length,
      source_length: fallback.text.length,
      truncated: fallback.text.length > maxChars,
      ...quality,
    };
  } catch (e) {
    return { url, error: (e as Error).message.slice(0, 200) };
  } finally {
    await page?.close().catch(() => {});
  }
}

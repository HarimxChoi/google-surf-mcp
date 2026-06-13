#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { launch, getPage, PROFILE_MAIN, profileExists, clearProfileLocks } from './browser.js';
import { search, CaptchaError } from './search.js';
import { SearchPool, type PoolSearchResult } from './pool.js';
import { extract, type ExtractMode } from './extract.js';
import { recoverFromCaptcha } from './captchaRecover.js';
import { captchaModeFromConfig } from './captchaMode.js';
import { autoBootstrap } from './bootstrap-auto.js';
import { withTimeout } from './timeout.js';
import {
  searchTool, searchParallelTool, extractTool, searchExtractTool, healthTool,
  initDeps, type Deps, type PoolHandle,
} from './agent.js';
import type { StealthMode } from './cascade.js';
import type { BrowserContext } from 'playwright';
import { PKG_NAME, VERSION } from './version.js';

const NAME = PKG_NAME;
const REQUEST_TIMEOUT_MS = 30_000;
const EXTRACT_BATCH_TIMEOUT_MS = 60_000;
const POOL_SIZE = 4;
const POOL_FALLBACK_THRESHOLD = 3;

function parseIdleMs(): number {
  const raw = process.env.SURF_IDLE_CLOSE_MS;
  if (raw === undefined) return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}
const IDLE_CLOSE_MS = parseIdleMs();

// sequential ctx lifecycle
let ctxPromise: Promise<BrowserContext> | null = null;
let ctxClosing: Promise<void> | null = null;
let ctxMode: StealthMode | null = null;

async function launchAndWarm(mode: StealthMode): Promise<BrowserContext> {
  const c = await launch({ profileDir: PROFILE_MAIN, stealth: mode === 'on' });
  try {
    const page = await getPage(c);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return c;
  } catch (e) {
    await c.close().catch(() => {});
    throw e;
  }
}

function getSequentialCtx(mode: StealthMode = 'off'): Promise<BrowserContext> {
  if (ctxClosing) return ctxClosing.then(() => getSequentialCtx(mode));
  // If a ctx exists but with a different stealth mode, close and rebuild.
  if (ctxPromise && ctxMode !== null && ctxMode !== mode) {
    return closeSequential().then(() => getSequentialCtx(mode));
  }
  if (ctxPromise) return ctxPromise;
  const p = (async () => {
    try {
      return await launchAndWarm(mode);
    } catch {
      // Stale lock from a crashed Chromium fails the first launch; clear + retry once.
      await clearProfileLocks(PROFILE_MAIN);
      return await launchAndWarm(mode);
    }
  })();
  ctxPromise = p;
  ctxMode = mode;
  p.catch(() => {
    if (ctxPromise === p) { ctxPromise = null; ctxMode = null; }
  });
  return p;
}

function closeSequential(): Promise<void> {
  if (ctxClosing) return ctxClosing;
  const cp = ctxPromise;
  ctxPromise = null;
  ctxMode = null;
  if (!cp) return Promise.resolve();
  ctxClosing = (async () => {
    try {
      const c = await cp.catch(() => null);
      await c?.close().catch(() => {});
    } finally {
      ctxClosing = null;
    }
  })();
  return ctxClosing;
}

// pool lifecycle
let pool: SearchPool | null = null;
let poolPromise: Promise<SearchPool> | null = null;
let poolClosing: Promise<void> | null = null;
let poolMode: StealthMode | null = null;
let poolWarmFailures = 0;
let poolFallbackMode = false;

export function getPoolHealth(): { warmFailures: number; fallback: boolean } {
  return { warmFailures: poolWarmFailures, fallback: poolFallbackMode };
}

function ensurePool(mode: StealthMode = 'off'): Promise<SearchPool> {
  if (poolClosing) return poolClosing.then(() => ensurePool(mode));
  // Pool reflects current cascade mode; rebuild on transition.
  if (pool && poolMode !== null && poolMode !== mode) {
    return resetPool().then(() => ensurePool(mode));
  }
  if (pool) return Promise.resolve(pool);
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    try {
      await closeSequential();
      const p = new SearchPool(POOL_SIZE);
      try { await p.warm(); }
      catch (e) { await p.close().catch(() => {}); throw e; }
      pool = p;
      poolMode = mode;
      return p;
    } finally {
      poolPromise = null;
    }
  })();
  return poolPromise;
}

async function resetPool(): Promise<void> {
  if (poolClosing) return poolClosing;
  if (poolPromise) {
    try { await poolPromise; } catch { /* */ }
  }
  const cur = pool;
  pool = null;
  poolMode = null;
  if (!cur) return;
  poolClosing = (async () => {
    try { await cur.close(); }
    finally { poolClosing = null; }
  })();
  return poolClosing;
}

// ref-counted idle auto-close
let seqActive = 0;
let poolActive = 0;
let seqIdleTimer: ReturnType<typeof setTimeout> | null = null;
let poolIdleTimer: ReturnType<typeof setTimeout> | null = null;
let idleSuspended = false;

function clearSeqIdle() { if (seqIdleTimer) { clearTimeout(seqIdleTimer); seqIdleTimer = null; } }
function clearPoolIdle() { if (poolIdleTimer) { clearTimeout(poolIdleTimer); poolIdleTimer = null; } }

export function suspendIdleClose(): void {
  idleSuspended = true;
  clearSeqIdle();
  clearPoolIdle();
}
export function resumeIdleClose(): void {
  idleSuspended = false;
}

async function trackSeq<T>(op: () => Promise<T>): Promise<T> {
  clearSeqIdle();
  seqActive++;
  let succeeded = false;
  try {
    const r = await op();
    succeeded = true;
    return r;
  } finally {
    seqActive--;
    if (succeeded && idleSuspended) idleSuspended = false;
    if (seqActive === 0 && IDLE_CLOSE_MS > 0 && !idleSuspended) {
      seqIdleTimer = setTimeout(() => {
        seqIdleTimer = null;
        if (seqActive === 0 && !idleSuspended) closeSequential().catch(() => {});
      }, IDLE_CLOSE_MS);
    }
  }
}

async function trackPool<T>(op: () => Promise<T>): Promise<T> {
  clearPoolIdle();
  poolActive++;
  let succeeded = false;
  try {
    const r = await op();
    succeeded = true;
    return r;
  } finally {
    poolActive--;
    if (succeeded && idleSuspended) idleSuspended = false;
    if (poolActive === 0 && IDLE_CLOSE_MS > 0 && !idleSuspended) {
      poolIdleTimer = setTimeout(() => {
        poolIdleTimer = null;
        if (poolActive === 0 && !idleSuspended) resetPool().catch(() => {});
      }, IDLE_CLOSE_MS);
    }
  }
}

async function shutdown() {
  clearSeqIdle();
  clearPoolIdle();
  const drainStart = Date.now();
  while ((seqActive > 0 || poolActive > 0) && Date.now() - drainStart < 10_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await closeSequential();
  await pool?.close();
  pool = null;
  await baseDeps.healing.flush().catch(() => {});
  baseDeps.healing.shutdown();
}


// Cascade state is process-level so seq + pool share it.
const baseDeps = initDeps();

async function ensureProfileReady(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (baseDeps.config.cloudMode) {
    return profileExists()
      ? { ok: true }
      : {
          ok: false,
          message: 'cloud mode requires a pre-warmed profile mounted at SURF_PROFILE_ROOT. Bootstrap externally then mount.',
        };
  }
  try {
    await autoBootstrap();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `auto-bootstrap failed: ${(e as Error).message}. Try: npm run bootstrap` };
  }
}

function buildDeps(): Deps {
  const acquireSeqCtx = async (mode: StealthMode) => {
    return await trackSeq(() => getSequentialCtx(mode));
  };

  const seqBackedHandle = (mode: StealthMode): PoolHandle => {
    const seqSearchOne = async (
      query: string, limit: number, opts?: { locale?: string },
    ): Promise<PoolSearchResult> => {
      return await trackSeq(() => withTimeout(
        (async () => {
          const ctx = await getSequentialCtx(mode);
          const page = await getPage(ctx);
          try {
            const outcome = await search(page, query, limit, opts);
            return {
              query, results: outcome.results,
              dropped: outcome.dropped, dropped_reasons: outcome.dropped_reasons,
            } as PoolSearchResult;
          } catch (e) {
            if (e instanceof CaptchaError) throw e;
            return { query, results: [], error: (e as Error).message } as PoolSearchResult;
          }
        })(),
        REQUEST_TIMEOUT_MS,
        'search_extract:search',
        closeSequential,
      ));
    };
    return {
      // serial: aggregate timeout would cap legitimate n-query batches
      runMany: async (queries, limit, opts) => {
        const out: PoolSearchResult[] = [];
        for (const q of queries) out.push(await seqSearchOne(q, limit, opts));
        return out;
      },
      searchOne: seqSearchOne,
      extractOne: async (url, maxChars, extractMode?: ExtractMode) => {
        return await trackSeq(() => withTimeout(
          (async () => {
            const ctx = await getSequentialCtx(mode);
            return await extract(ctx, url, { maxChars, mode: extractMode });
          })(),
          REQUEST_TIMEOUT_MS,
          'extract',
          closeSequential,
        ));
      },
    };
  };

  const poolBackedHandle = (p: SearchPool): PoolHandle => ({
    runMany: (queries, limit, opts) =>
      trackPool(() => withTimeout(
        p.runMany(queries, limit, opts),
        REQUEST_TIMEOUT_MS * 2,
        'search_parallel',
        resetPool,
      )),
    extractOne: (url, maxChars, extractMode) =>
      trackPool(() => withTimeout(
        p.extractOne(url, maxChars, extractMode),
        REQUEST_TIMEOUT_MS,
        'extract',
      )),
    searchOne: (query, limit, opts) =>
      trackPool(() => withTimeout(
        p.searchOne(query, limit, opts),
        REQUEST_TIMEOUT_MS,
        'search_extract:search',
        resetPool,
      )),
  });

  const acquirePool = async (mode: StealthMode): Promise<PoolHandle> => {
    if (poolFallbackMode) return seqBackedHandle(mode);
    try {
      const p = await trackPool(() => ensurePool(mode));
      poolWarmFailures = 0;
      return poolBackedHandle(p);
    } catch (e) {
      poolWarmFailures++;
      if (poolWarmFailures >= POOL_FALLBACK_THRESHOLD) {
        poolFallbackMode = true;
        console.error(
          `[google-surf-mcp] pool warm failed ${poolWarmFailures}× — switching to single-context fallback`,
        );
        return seqBackedHandle(mode);
      }
      throw e;
    }
  };

  const captchaMode = captchaModeFromConfig({
    cloudMode: baseDeps.config.cloudMode,
    headless: baseDeps.config.headless,
    remoteDebug: baseDeps.config.remoteDebug,
  });
  const recoverHuman = async (seedQuery?: string) => {
    // remote_debug: keep Chromium alive across DevTools attach window
    if (captchaMode === 'remote_debug') {
      suspendIdleClose();
    } else if (captchaMode === 'notify_spawn' || captchaMode === 'always_headed') {
      await Promise.all([
        resetPool().catch(() => {}),
        closeSequential().catch(() => {}),
      ]);
    }
    await recoverFromCaptcha({ mode: captchaMode, seedQuery });
  };

  return {
    ...baseDeps,
    acquireSeqCtx,
    acquirePool,
    closeSeq: closeSequential,
    resetPool,
    recoverHuman,
    getPoolHealth,
  };
}


const server = new McpServer({ name: NAME, version: VERSION });
server.server.onerror = (e: unknown) => console.error('[mcp]', e);

process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.stdin.on('end', () => { shutdown().finally(() => process.exit(0)); });

const SearchInput = {
  query: z.string().min(1).max(400).describe('Google search query. Use site: filters and quotes for exact match.'),
  limit: z.number().int().min(1).max(20).default(10).describe('Max results (default 10).'),
};

const SearchParallelInput = {
  queries: z.array(z.string()).min(1).max(10).describe('2-10 queries to run concurrently.'),
  limit: z.number().int().min(1).max(20).default(10).describe('Max results per query.'),
};

const ExtractInput = {
  url: z.string().describe('Public http(s) URL. Loopback/private IPs blocked unless SURF_ALLOW_PRIVATE=true.'),
  max_chars: z.number().int().min(200).max(50_000).default(baseDeps.config.extractMaxChars).describe(`Truncate body to this many chars (default ${baseDeps.config.extractMaxChars}, set via SURF_EXTRACT_MAX_CHARS).`),
  mode: z.enum(['full', 'abstract', 'metadata']).default('full').describe(
    'Extraction depth. `full` = whole article body (default; uses Playwright if needed). ' +
    '`abstract` = cheap survey: PDF page 1 OR HTML meta description (~1500 chars); use to triage relevance before paying for full text. ' +
    '`metadata` = page count only (PDF). Academic PDFs (arxiv/biorxiv/Nature/OpenReview/NeurIPS/JMLR/PMLR/Springer/PubMed-via-PMC) are auto-detected; abstract mode skips Playwright for them.',
  ),
};

const SearchExtractInput = {
  query: z.string().min(1).max(400).describe('Search query.'),
  limit: z.number().int().min(1).max(10).default(5).describe('Number of results to extract (default 5, max 10).'),
  max_chars: z.number().int().min(200).max(20_000).optional().describe('Truncate each result body. Default depends on mode: ~1500 for abstract, 8000 for full.'),
  mode: z.enum(['full', 'abstract']).default('abstract').describe(
    'Extraction depth per result. `abstract` (default) = cheap survey, ~1500 chars/result, ideal for relevance triage. ' +
    '`full` = whole body per result, slower and far more tokens; only when you actually need the article texts.',
  ),
};

// All-optional + `error` field: one schema validates success and error payloads.
const ResultItem = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
});
const ErrorInfoShape = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().optional(),
  user_action: z.string().optional(),
});
const MetaShape = z.record(z.string(), z.unknown());

const SearchOutput = {
  query: z.string().optional(),
  results: z.array(ResultItem).optional(),
  elapsed_ms: z.number().optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const SearchParallelOutput = {
  results: z.array(z.object({
    query: z.string(),
    results: z.array(ResultItem),
    dropped: z.number().optional(),
    dropped_reasons: z.array(z.string()).optional(),
    error: z.string().optional(),
  })).optional(),
  elapsed_ms: z.number().optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const ExtractOutput = {
  url: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  length: z.number().optional(),
  is_pdf: z.boolean().optional(),
  page_count: z.number().optional(),
  extraction_quality: z.enum(['full_text', 'abstract', 'meta_abstract', 'metadata_only']).optional(),
  elapsed_ms: z.number().optional(),
  error: z.union([z.string(), ErrorInfoShape]).optional(),
  meta: MetaShape.optional(),
};

const SearchExtractOutput = {
  query: z.string().optional(),
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    description: z.string(),
    content: z.string().optional(),
    excerpt: z.string().optional(),
    length: z.number().optional(),
    is_pdf: z.boolean().optional(),
    page_count: z.number().optional(),
    extraction_quality: z.enum(['full_text', 'abstract', 'meta_abstract', 'metadata_only']).optional(),
    error: z.string().optional(),
  })).optional(),
  elapsed_ms: z.number().optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const HealthOutput = {
  version: z.string().optional(),
  cascade: MetaShape.optional(),
  rateLimiter: MetaShape.optional(),
  cache: MetaShape.optional(),
  pool: MetaShape.optional(),
  telemetry: MetaShape.optional(),
  selfHealing: MetaShape.optional(),
  config: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

server.registerTool('search', {
  title: 'Google Search',
  description:
    'Single Google search -> title/url/snippet per result. Results are cached 24h, ' +
    'so repeating a query is free -- prefer re-querying over caching results yourself. ' +
    'For latest/today/breaking queries set SURF_CACHE_TTL_SEARCH_MS=0 to bypass the cache. ' +
    'Default limit 10 (max 20). First call ~4s (Chromium warmup), then ~2s. ' +
    'On CAPTCHA a visible Chrome opens for a human to solve (shared-IP protection); ' +
    'SURF_CLOUD_MODE=true makes it fail-fast instead.',
  inputSchema: SearchInput,
  outputSchema: SearchOutput,
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
}, async (args: { query: string; limit: number }) => {
  const ready = await ensureProfileReady();
  if (!ready.ok) {
    return { content: [{ type: 'text', text: `Error [PROFILE_MISSING]: ${ready.message}` }], isError: true };
  }
  return await searchTool(args, buildDeps());
});

server.registerTool('search_parallel', {
  title: 'Google Search Parallel',
  description:
    'Run 2-10 Google searches concurrently. Use to compare multiple angles in one call. ' +
    'Each query counts against the internal rate limit (~10/min) -- do not loop this for bulk scraping. ' +
    'First call adds 5-10s pool warmup. Per-query failures are isolated in the results array. ' +
    'Disabled in cloud mode.',
  inputSchema: SearchParallelInput,
  outputSchema: SearchParallelOutput,
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
}, async (args: { queries: string[]; limit: number }) => {
  const ready = await ensureProfileReady();
  if (!ready.ok) {
    return { content: [{ type: 'text', text: `Error [PROFILE_MISSING]: ${ready.message}` }], isError: true };
  }
  return await searchParallelTool(args, buildDeps());
});

server.registerTool('extract', {
  title: 'Extract Article Content',
  description:
    'Fetch one public URL -> clean article text. ' +
    'HTML via Mozilla Readability; academic PDFs (arxiv/biorxiv/Nature/OpenReview/NeurIPS/JMLR/PMLR/Springer/PubMed-via-PMC) auto-detected via Content-Type, %PDF magic, citation_pdf_url meta, and per-domain URL rules. ' +
    'Tiered depth: `mode="abstract"` returns ~1500 chars (PDF page 1 or HTML meta description) -- cheap survey to triage relevance before paying for full body. `mode="full"` (default) returns the whole article. ' +
    'Best-effort: failures return an errorInfo instead of throwing.',
  inputSchema: ExtractInput,
  outputSchema: ExtractOutput,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
}, async (args: { url: string; max_chars: number; mode: 'full' | 'abstract' | 'metadata' }) => {
  const ready = await ensureProfileReady();
  if (!ready.ok) {
    return { content: [{ type: 'text', text: `Error [PROFILE_MISSING]: ${ready.message}` }], isError: true };
  }
  return await extractTool(args, buildDeps());
});

server.registerTool('search_extract', {
  title: 'Search + Parallel Extract',
  description:
    'One-shot Google search + parallel extract of the top results. ' +
    'Default `mode="abstract"` returns SERP enriched with ~1500-char abstracts per result -- a cheap survey of what the top results actually contain, far fewer tokens than fetching all bodies. ' +
    'Switch to `mode="full"` only when you need the actual article texts (slower, much more tokens). ' +
    'Per-page extract failures are isolated. Disabled in cloud mode.',
  inputSchema: SearchExtractInput,
  outputSchema: SearchExtractOutput,
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
}, async (args: { query: string; limit: number; max_chars?: number; mode: 'full' | 'abstract' }) => {
  const ready = await ensureProfileReady();
  if (!ready.ok) {
    return { content: [{ type: 'text', text: `Error [PROFILE_MISSING]: ${ready.message}` }], isError: true };
  }
  return await searchExtractTool(args, buildDeps());
});

server.registerTool('health', {
  title: 'MCP Health Check',
  description:
    'MCP server status: cascade mode + transitions, rate-limiter usage, cache size, config. ' +
    'Call this if searches start failing or returning empty -- check cascade.totalCaptchas and ' +
    'rateLimiter.queueSize, and reduce search volume if they are high.',
  inputSchema: {},
  outputSchema: HealthOutput,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
}, async () => {
  return await healthTool(buildDeps());
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${NAME}@${VERSION}] running on stdio`);

if (!baseDeps.config.cloudMode) {
  (async () => {
    try {
      if (!profileExists()) await autoBootstrap();
      if (profileExists()) await getSequentialCtx();
    } catch (e) {
      console.error('[google-surf-mcp] startup warm failed (will retry on first call):', (e as Error)?.message ?? e);
    }
  })();
}

#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  launch, getPage, PROFILE_MAIN, PROFILE_NATIVE, profileExists, clearProfileLocks,
  detectSystemChrome,
} from './browser.js';
import { search, CaptchaError } from './search.js';
import { SearchPool, type PoolSearchResult } from './pool.js';
import { extract, type ExtractMode } from './extract.js';
import {
  beginCaptchaRecovery, isCaptchaRecoveryActive, recoverFromCaptcha,
} from './captchaRecover.js';
import { captchaModeFromConfig } from './captchaMode.js';
import { autoBootstrap } from './bootstrap-auto.js';
import { withTimeout } from './timeout.js';
import {
  applyParallelSearchExtraction, applySearchExtraction, searchTool, scholarSearchTool,
  searchParallelTool, extractTool, healthTool, initDeps, type Deps, type PoolHandle,
  type SearchExtractionInput,
} from './agent.js';
import { formatToolResponse } from './response.js';
import {
  captureOnly, runParallelWithResearch, runSearchWithResearch,
} from './research/orchestrator.js';
import { ResearchService } from './research/service.js';
import { projectMemoryTool, type ProjectMemoryInput } from './research/tools.js';
import type { StealthMode } from './cascade.js';
import type { BrowserContext } from 'playwright';
import { PKG_NAME, VERSION } from './version.js';
import { NativeChromeBrowser } from './nativeBrowser.js';

const NAME = PKG_NAME;
const REQUEST_TIMEOUT_MS = 30_000;
const EXTRACT_BATCH_TIMEOUT_MS = 60_000;
const POOL_SIZE = 2;
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
let ctxDead = false;

async function launchAndWarm(mode: StealthMode): Promise<BrowserContext> {
  const c = await launch({ profileDir: PROFILE_MAIN, stealth: mode === 'on' });
  try {
    const page = await getPage(c);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // ctx.pages() keeps succeeding after an external kill; only 'close' fires.
    ctxDead = false;
    c.once('close', () => { ctxDead = true; });
    return c;
  } catch (e) {
    await c.close().catch(() => {});
    throw e;
  }
}

function getSequentialCtx(mode: StealthMode = 'off'): Promise<BrowserContext> {
  if (ctxClosing) return ctxClosing.then(() => getSequentialCtx(mode));
  if (ctxPromise && ctxDead) {
    return closeSequential().then(() => getSequentialCtx(mode));
  }
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
  ctxDead = false;
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
    try { await poolPromise; } catch {}
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
  await nativeBrowser?.close().catch(() => {});
  await baseDeps.healing.flush().catch(() => {});
  baseDeps.healing.shutdown();
  await researchService.close().catch(() => {});
}


// Cascade state is process-level so seq + pool share it.
const baseDeps = initDeps();
let nativeBrowser: NativeChromeBrowser | undefined;
let nativeBrowserError: string | undefined;
if (!baseDeps.config.cloudMode
  && !baseDeps.config.remoteDebug
  && baseDeps.config.browserEngine !== 'playwright') {
  try {
    nativeBrowser = new NativeChromeBrowser({
      executablePath: detectSystemChrome(),
      profileDir: PROFILE_NATIVE,
    });
  } catch (error) {
    nativeBrowserError = (error as Error).message;
  }
}
if (baseDeps.config.browserEngine === 'native' && baseDeps.config.remoteDebug) {
  nativeBrowserError = 'native Chrome is incompatible with SURF_REMOTE_DEBUG';
}
const researchService = new ResearchService({
  enabled: baseDeps.config.researchEnabled,
  root: baseDeps.config.researchRoot,
  vectorModel: baseDeps.config.researchVectorModel,
  repositoryAuto: baseDeps.config.researchRepoAuto,
  repositoryMaxSourceBytes: baseDeps.config.researchRepoAutoMaxMb * 1024 * 1024,
  repositoryMaxSourceFiles: baseDeps.config.researchRepoAutoMaxFiles,
});

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

async function prepareSearchProvider(
  mode: 'browser' | 'searchapi' | 'fallback',
): Promise<{ browserUnavailable?: string; error?: string }> {
  if (mode === 'searchapi') return {};
  if (nativeBrowser) return {};
  if (baseDeps.config.browserEngine === 'native') {
    const message = nativeBrowserError ?? 'native Chrome unavailable';
    return mode === 'fallback'
      ? { browserUnavailable: message }
      : { error: message };
  }
  const ready = await ensureProfileReady();
  if (ready.ok) return {};
  return mode === 'fallback'
    ? { browserUnavailable: ready.message }
    : { error: ready.message };
}

function buildDeps(): Deps {
  const acquireSeqCtx = async (mode: StealthMode) => {
    if (isCaptchaRecoveryActive()) {
      throw new CaptchaError(
        'human recovery in progress',
        'Solve CAPTCHA in the opened browser, then retry this request.',
      );
    }
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
              degraded_reasons: outcome.degraded_reasons,
            } as PoolSearchResult;
          } catch (e) {
            if (e instanceof CaptchaError) throw e;
            return { query, results: [], error: (e as Error).message } as PoolSearchResult;
          }
        })(),
        REQUEST_TIMEOUT_MS,
        'search',
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
        'search',
        resetPool,
      )),
  });

  const acquirePool = async (mode: StealthMode): Promise<PoolHandle> => {
    if (isCaptchaRecoveryActive()) {
      throw new CaptchaError(
        'human recovery in progress',
        'Solve CAPTCHA in the opened browser, then retry this request.',
      );
    }
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
          `[google-surf-mcp] pool warm failed ${poolWarmFailures}x; switching to single-context fallback`,
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
    if (captchaMode === 'notify_spawn' || captchaMode === 'always_headed') {
      beginCaptchaRecovery({ mode: captchaMode, seedQuery });
      throw new CaptchaError(
        'background human recovery started',
        'Solve CAPTCHA in the opened browser, then retry this request.',
      );
    }
    await recoverFromCaptcha({ mode: captchaMode, seedQuery });
  };

  return {
    ...baseDeps,
    nativeBrowser,
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

const SessionMemoryInput = baseDeps.config.researchEnabled ? {
  session_id: z.string().min(1).max(200).optional().describe('Stable host task id. Reuses the same project session after restart.'),
  session_intent: z.string().min(1).max(2_000).optional().describe('Current durable task intent. A changed value creates an immutable revision.'),
} : {};
type SessionMemoryArgs = { session_id?: string; session_intent?: string };

const ProjectSearchInput = baseDeps.config.researchEnabled ? {
  project_id: z.string().min(1).max(64).optional().describe('Project memory id.'),
  include_project_ids: z.array(z.string().min(1).max(64)).max(8).optional().describe('Additional read-only projects joined through ontology-aligned schema and identity links. New records stay in project_id.'),
  memory_handle: z.string().uuid().optional().describe('Reuse the handle returned by a prior project-aware call.'),
  ...SessionMemoryInput,
} : {};

const ProjectCaptureInput = baseDeps.config.researchEnabled ? {
  project_id: z.string().min(1).max(64).optional().describe('Project memory id.'),
  memory_handle: z.string().uuid().optional().describe('Reuse the handle returned by a prior project-aware call.'),
  ...SessionMemoryInput,
} : {};

const SearchExtractionFields = {
  extract_mode: z.enum(['none', 'abstract', 'full']).default('none').describe(
    'Content depth after search. For GitHub results, none reads the README; abstract and full use the same repository eligibility gate but index different source amounts.',
  ),
  extract_limit: z.number().int().min(1).max(10).default(5).describe(
    'Maximum unique result URLs to extract. For parallel search this is one call-wide limit, not a per-query limit.',
  ),
  max_chars: z.number().int().min(200).max(50_000).optional().describe(
    `Maximum characters per extracted result. Defaults to 1500 for abstract and ${baseDeps.config.extractMaxChars} for full.`,
  ),
};

const SearchInput = {
  query: z.string().min(1).max(400).describe('Google search query. Use site: filters and quotes for exact match.'),
  limit: z.number().int().min(1).max(20).default(10).describe('Max results (default 10).'),
  ...SearchExtractionFields,
  ...ProjectSearchInput,
};

const ScholarSearchInput = {
  query: z.string().min(1).max(400).describe('Google Scholar query. Supports quotes and author: operators.'),
  limit: z.number().int().min(1).max(10).default(10).describe('Max papers (default 10).'),
  ...ProjectCaptureInput,
};

const SearchParallelInput = {
  queries: z.array(z.string().min(1).max(400)).min(2).max(10).describe('2-10 independent queries to run concurrently.'),
  limit: z.number().int().min(1).max(20).default(10).describe('Max results per query.'),
  ...SearchExtractionFields,
  ...ProjectSearchInput,
};

const ExtractInput = {
  url: z.string().describe('Public http(s) URL. Loopback/private IPs blocked unless SURF_ALLOW_PRIVATE=true.'),
  ...ProjectCaptureInput,
  max_chars: z.number().int().min(200).max(50_000).optional().describe(`Truncate body to this many chars. Defaults to 1500 for abstract and ${baseDeps.config.extractMaxChars} for full.`),
  mode: z.enum(['full', 'abstract', 'metadata']).default('full').describe(
    'Extraction depth. `full` = whole article body (default; uses Playwright if needed). ' +
    '`abstract` = cheap survey: PDF page 1 OR HTML meta description (~1500 chars); use to triage relevance before paying for full text. ' +
    '`metadata` = document metadata without body text: title, authors, publication details, dates, DOI, keywords, canonical URL, and PDF properties when available. ' +
    'Academic PDFs (arxiv/biorxiv/Nature/OpenReview/NeurIPS/JMLR/PMLR/Springer/PubMed-via-PMC) are auto-detected; abstract mode skips Playwright for them.',
  ),
};

const DocumentMetadataOutput = {
  authors: z.string().optional(),
  publication: z.string().optional(),
  published_at: z.string().optional(),
  year: z.number().int().optional(),
  doi: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  canonical_url: z.string().optional(),
  language: z.string().optional(),
  subject: z.string().optional(),
  creator: z.string().optional(),
  producer: z.string().optional(),
  created_at: z.string().optional(),
  modified_at: z.string().optional(),
};

// All-optional + `error` field: one schema validates success and error payloads.
const ResultItem = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  length: z.number().optional(),
  is_pdf: z.boolean().optional(),
  page_count: z.number().optional(),
  extraction_quality: z.enum(['full_text', 'abstract', 'meta_abstract', 'metadata_only']).optional(),
  ...DocumentMetadataOutput,
  extract_error: z.string().optional(),
  document_id: z.string().optional(),
  source_family: z.enum(['live', 'document', 'code', 'graph']).optional(),
  fresh_web: z.boolean().optional(),
});
const ErrorInfoShape = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().optional(),
  user_action: z.string().optional(),
});
const MetaShape = z.record(z.string(), z.unknown());
const ResearchContextShape = z.object({
  prior_searches: z.array(z.object({
    query: z.string(),
    relation: z.enum(['same', 'related', 'recent']),
    searched_at: z.string(),
    results: z.number().int(),
    surface: z.string().optional(),
  })).max(3),
});

const SearchOutput = {
  query: z.string().optional(),
  results: z.array(ResultItem).optional(),
  elapsed_ms: z.number().optional(),
  memory: z.string().optional(),
  memory_handle: z.string().optional(),
  research_context: ResearchContextShape.optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const ScholarSearchOutput = {
  query: z.string().optional(),
  results: z.array(z.object({
    rank: z.number().int(),
    title: z.string(),
    url: z.string().optional(),
    authors: z.string().optional(),
    publication: z.string().optional(),
    year: z.number().int().optional(),
    source: z.string().optional(),
    snippet: z.string(),
    cited_by_count: z.number().int(),
    cited_by_url: z.string().optional(),
    related_articles_url: z.string().optional(),
    versions_count: z.number().int().optional(),
    versions_url: z.string().optional(),
    full_text_url: z.string().optional(),
    scholar_id: z.string().optional(),
    metadata: z.string(),
  })).optional(),
  elapsed_ms: z.number().optional(),
  memory: z.string().optional(),
  memory_handle: z.string().optional(),
  research_context: ResearchContextShape.optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const SearchParallelOutput = {
  results: z.array(z.object({
    query: z.string(),
    results: z.array(ResultItem),
    dropped: z.number().optional(),
    dropped_reasons: z.array(z.string()).optional(),
    degraded_reasons: z.array(z.string()).optional(),
    provider: z.enum(['browser', 'searchapi', 'local']).optional(),
    fallback_reason: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
  elapsed_ms: z.number().optional(),
  memory: z.string().optional(),
  memory_handle: z.string().optional(),
  research_context: ResearchContextShape.optional(),
  meta: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const ExtractOutput = {
  url: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  excerpt: z.string().optional(),
  length: z.number().optional(),
  is_pdf: z.boolean().optional(),
  page_count: z.number().optional(),
  extraction_quality: z.enum(['full_text', 'abstract', 'meta_abstract', 'metadata_only']).optional(),
  ...DocumentMetadataOutput,
  elapsed_ms: z.number().optional(),
  memory: z.string().optional(),
  memory_handle: z.string().optional(),
  error: z.union([z.string(), ErrorInfoShape]).optional(),
  meta: MetaShape.optional(),
};

const HealthOutput = {
  version: z.string().optional(),
  cascade: MetaShape.optional(),
  rateLimiter: MetaShape.optional(),
  cache: MetaShape.optional(),
  pool: MetaShape.optional(),
  telemetry: MetaShape.optional(),
  selfHealing: MetaShape.optional(),
  research: MetaShape.optional(),
  config: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

const ProjectMemoryOutput = {
  project: MetaShape.optional(),
  projects: z.array(MetaShape).optional(),
  index: MetaShape.optional(),
  visualization: MetaShape.optional(),
  forget: MetaShape.optional(),
  session: MetaShape.optional(),
  record: MetaShape.optional(),
  assertion: MetaShape.optional(),
  entity: MetaShape.optional(),
  entities: z.array(MetaShape).optional(),
  memory: z.string().optional(),
  memory_handle: z.string().optional(),
  plans: z.array(MetaShape).optional(),
  experiments: z.array(MetaShape).optional(),
  decisions: z.array(MetaShape).optional(),
  assertion_count: z.number().optional(),
  correction_count: z.number().optional(),
  entity_count: z.number().optional(),
  entity_operation_count: z.number().optional(),
  job_counts: MetaShape.optional(),
  session_count: z.number().optional(),
  search_event_count: z.number().optional(),
  document_count: z.number().optional(),
  citation_observation_count: z.number().optional(),
  source_entry_count: z.number().optional(),
  active_source_snapshot: MetaShape.optional(),
  error: ErrorInfoShape.optional(),
};

server.registerTool('search', {
  title: 'Google Search',
  description:
    'Default entry point for web, paper, and repository discovery. ' +
    'Use extract_mode=abstract for bounded inspection and full only for complete text. GitHub none mode reads the README; eligible small repositories can be indexed. ' +
    'With research enabled and project_id set, live web, exact, BM25, vector, code, and graph lanes are fused by RRF and one reranker. ' +
    'research_context returns up to three prior searches for deeper or adjacent follow-up work. ' +
    'Captured search, source, session, and project provenance form data lineage; extracted bodies become evidence while unread hits remain metadata. ' +
    'include_project_ids adds read-only cross-project retrieval through versioned ontology and verified schema/entity links without merging records. ' +
    'Browser search is the no-key default and SearchApi is the configured primary or fallback provider. Results are cached for 24h unless the TTL is disabled.',
  inputSchema: SearchInput,
  outputSchema: SearchOutput,
  annotations: { readOnlyHint: !baseDeps.config.researchEnabled, idempotentHint: false, openWorldHint: true },
}, async (args: {
  query: string;
  limit: number;
  project_id?: string;
  include_project_ids?: string[];
  memory_handle?: string;
} & SessionMemoryArgs & SearchExtractionInput) => {
  const runLive = async (requestedLimit = args.limit) => {
    const provider = await prepareSearchProvider(baseDeps.config.searchProvider);
    if (provider.error) {
      return formatToolResponse(null, {
        code: 'PROFILE_MISSING', message: provider.error, retryable: false,
      });
    }
    const deps = buildDeps();
    const request = { ...args, limit: requestedLimit };
    const result = await searchTool(request, deps, provider);
    return await applySearchExtraction(result, request, deps);
  };
  return baseDeps.config.researchEnabled
    ? await runSearchWithResearch({
      ...args,
      retrieval_mode: baseDeps.config.researchRetrievalMode,
    }, researchService, runLive)
    : await runLive();
});

server.registerTool('scholar_search', {
  title: 'Google Scholar Search',
  description:
    'Use only for paper metadata such as authors, venue, year, versions, and citation counts. ' +
    'Do not use it to discover or read paper content; use search with extract_mode instead. ' +
    'Returns title, authors, publication, year, snippet, citation count, related/version links, and an available full-text link. ' +
    'With research enabled, metadata and citation observations retain provider provenance and research_context exposes related prior searches. ' +
    'Google Scholar uses browser search, SearchApi primary, or configured fallback. ' +
    'Results are cached with the same TTL as search. Max 10 papers per call.',
  inputSchema: ScholarSearchInput,
  outputSchema: ScholarSearchOutput,
  annotations: { readOnlyHint: !baseDeps.config.researchEnabled, idempotentHint: false, openWorldHint: true },
}, async (args: {
  query: string;
  limit: number;
  project_id?: string;
  memory_handle?: string;
} & SessionMemoryArgs) => {
  const provider = await prepareSearchProvider(baseDeps.config.scholarProvider);
  if (provider.error) {
    return formatToolResponse(null, {
      code: 'PROFILE_MISSING', message: provider.error, retryable: false,
    });
  }
  const result = await scholarSearchTool(args, buildDeps(), provider);
  return baseDeps.config.researchEnabled
    ? await captureOnly(researchService, 'scholar_search', args, result)
    : result;
});

server.registerTool('search_parallel', {
  title: 'Google Search Parallel',
  description:
    'Use for 2-10 independent web queries known in advance. ' +
    'extract_limit is shared across the call. GitHub none mode reads the README; eligible small repositories can be indexed. ' +
    'With research enabled and project_id set, each query fuses live, exact, BM25, vector, code, and graph lanes through RRF and one reranker. ' +
    'research_context returns prior project searches; capture retains data lineage and include_project_ids uses versioned ontology and verified cross-project schema/entity links. ' +
    'Extracted bodies become evidence while unread hits remain metadata. ' +
    'Native Chrome serializes profile use; the Playwright compatibility path uses a worker pool. ' +
    'SearchApi fallback replaces failed queries individually.',
  inputSchema: SearchParallelInput,
  outputSchema: SearchParallelOutput,
  annotations: { readOnlyHint: !baseDeps.config.researchEnabled, idempotentHint: false, openWorldHint: true },
}, async (args: {
  queries: string[];
  limit: number;
  project_id?: string;
  include_project_ids?: string[];
  memory_handle?: string;
} & SessionMemoryArgs & SearchExtractionInput) => {
  const runLive = async (requestedLimit = args.limit) => {
    const provider = await prepareSearchProvider(baseDeps.config.searchProvider);
    if (provider.error) {
      return formatToolResponse(null, {
        code: 'PROFILE_MISSING', message: provider.error, retryable: false,
      });
    }
    const deps = buildDeps();
    const request = { ...args, limit: requestedLimit };
    const result = await searchParallelTool(request, deps, provider);
    return await applyParallelSearchExtraction(result, request, deps);
  };
  return baseDeps.config.researchEnabled
    ? await runParallelWithResearch({
      ...args,
      retrieval_mode: baseDeps.config.researchRetrievalMode,
    }, researchService, runLive)
    : await runLive();
});

server.registerTool('extract', {
  title: 'Extract Article Content',
  description:
    'Use when the exact URL is already known. Fetch one public URL and return clean article text. ' +
    'For GitHub repository URLs, metadata reads the README; abstract and full use the same bounded download gate and differ only in indexed source depth. ' +
    'HTML via Mozilla Readability; academic PDFs (arxiv/biorxiv/Nature/OpenReview/NeurIPS/JMLR/PMLR/Springer/PubMed-via-PMC) auto-detected via Content-Type, %PDF magic, citation_pdf_url meta, and per-domain URL rules. ' +
    'Tiered depth: `mode="metadata"` returns document metadata without body text, `mode="abstract"` returns about 1500 chars for relevance checks, and `mode="full"` returns up to the configured 50000 chars. ' +
    'PDF and landing-page metadata are merged when available. With research enabled, abstract and full PDF reads are stored as searchable evidence with bibliographic metadata and provenance. ' +
    'Best-effort: failures return an errorInfo instead of throwing.',
  inputSchema: ExtractInput,
  outputSchema: ExtractOutput,
  annotations: { readOnlyHint: !baseDeps.config.researchEnabled, idempotentHint: false, openWorldHint: true },
}, async (args: {
  url: string;
  max_chars?: number;
  mode: 'full' | 'abstract' | 'metadata';
  project_id?: string;
  memory_handle?: string;
} & SessionMemoryArgs) => {
  const prepared = baseDeps.config.researchEnabled
    ? await researchService.prepareRepositoryResults(
      args.project_id,
      args.mode === 'metadata' ? 'none' : args.mode,
      [{ title: args.url, url: args.url }],
    ).catch(() => undefined)
    : undefined;
  const repositoryRow = prepared?.rows[0];
  const repositoryContent = repositoryRow?.content;
  if (prepared?.decisions.length && repositoryRow && repositoryContent) {
    const result = formatToolResponse({
      url: repositoryRow.url,
      title: repositoryRow.title,
      content: repositoryContent,
      excerpt: repositoryContent.slice(0, 200),
      length: repositoryContent.length,
      is_pdf: false,
      extraction_quality: repositoryRow.extraction_quality ?? 'abstract',
      meta: { repository_ingest: prepared.decisions },
    });
    return await captureOnly(researchService, 'extract', args, result);
  }
  const ready = await ensureProfileReady();
  if (!ready.ok) {
    return formatToolResponse(null, {
      code: 'PROFILE_MISSING', message: ready.message, retryable: false,
    });
  }
  let result = await extractTool(args, buildDeps());
  if (prepared?.decisions.length && !result.isError && result.structuredContent) {
    const row = result.structuredContent;
    const meta = row.meta && typeof row.meta === 'object'
      ? row.meta as Record<string, unknown>
      : {};
    result = formatToolResponse({
      ...row,
      meta: { ...meta, repository_ingest: prepared.decisions },
    });
  }
  return baseDeps.config.researchEnabled
    ? await captureOnly(researchService, 'extract', args, result)
    : result;
});

if (baseDeps.config.researchEnabled) server.registerTool('project_memory', {
  title: 'Project Memory',
  description:
    'Management tool for durable project knowledge, not content discovery. ' +
    'create and show manage projects; record stores session intent, immutable plan revisions, experiments, decisions, versioned ontology entity types or relations, and evidence-preserving corrections. ' +
    'Ontology revisions use supersedes_term_id. Corrections preserve bitemporal data lineage and support assertion replacement plus entity merge or split. ' +
    'rebuild indexes approved local roots and code structure into a reproducible snapshot; export writes an interactive HTML viewer, Graphviz DOT, D3 JSON, or a Neo4j import bundle. HTML always includes PKM, Lineage, and Ontology tabs, an embedded-project selector, empty-canvas focus reset, and visible PNG or JSON download. ' +
    'forget previews impact before reversible project or assertion deletion. ' +
    'Search, search_parallel, scholar_search, and extract automatically capture sources and provenance; project_memory manages their durable structure.',
  inputSchema: {
    action: z.enum(['create', 'show', 'record', 'rebuild', 'export', 'forget']).describe(
      'create: project_id and name required. show: project_id optional; target_id or name narrows inspection. record: project_id and record_type required. rebuild: project_id required; roots optional. export: project_id, include_project_ids, or all_projects=true required. forget: project_id and forget_mode required; apply also requires confirm_token.',
    ),
    project_id: z.string().min(1).max(64).optional().describe('Stable project id. Omit to list projects or export all projects.'),
    include_project_ids: z.array(z.string().min(1).max(64)).max(20).optional().describe('Additional projects included in one integrated visualization export.'),
    all_projects: z.boolean().optional().describe('Embed every active named project and an All projects option in one export. Excludes Inbox and cannot be combined with project ids.'),
    export_format: z.enum(['dot', 'd3', 'html', 'neo4j']).default('d3').describe('Visualization file format. html writes one offline explorer with PKM, Lineage, Ontology, project selection, and current-view PNG or anonymized JSON download; d3 writes node-link JSON; dot writes Graphviz DOT; neo4j writes an import-ready CSV and Cypher bundle.'),
    export_view: z.enum(['graph', 'ontology', 'lineage']).default('graph').describe('Initial HTML tab or non-HTML export scope. graph is PKM; ontology shows types, shared schema, verified identity links, and typed instances; lineage shows aligned data and research lineage.'),
    name: z.string().min(1).max(120).optional().describe('Project name for create, or entity name lookup for show.'),
    record_type: z.enum(['session', 'plan', 'experiment', 'decision', 'ontology', 'correction']).optional().describe(
      'Required for record. session stores intent; plan creates an immutable revision; experiment starts or finishes a run; decision links a conclusion; ontology creates a versioned type or relation; correction replaces an assertion or merges/splits entities.',
    ),
    memory_handle: z.string().uuid().optional().describe('Existing project session handle for a session intent revision.'),
    intent: z.string().min(1).max(2_000).optional().describe('Durable intent for record_type=session.'),
    title: z.string().min(1).max(200).optional().describe('Plan title, experiment name, or decision title.'),
    body: z.string().min(1).max(50_000).optional().describe('Plan body for record_type=plan.'),
    change_reason: z.string().min(1).max(2_000).optional().describe('Reason for a new plan revision.'),
    based_on_experiment_id: z.string().optional().describe('Experiment that motivated a plan revision.'),
    experiment_id: z.string().optional().describe('Experiment to finish or associate with a decision.'),
    hypothesis: z.string().min(1).max(5_000).optional().describe('Hypothesis when starting an experiment.'),
    plan_revision_id: z.string().optional().describe('Plan revision associated with an experiment or decision.'),
    status: z.enum(['running', 'success', 'failed', 'inconclusive']).optional().describe('Use success, failed, or inconclusive to finish an experiment. Omit or use running when starting it.'),
    summary: z.string().min(1).max(10_000).optional().describe('Experiment result or decision summary.'),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Terminal experiment metrics.'),
    artifacts: z.array(z.string().max(2_000)).max(100).optional().describe('Experiment artifact paths or identifiers.'),
    roots: z.array(z.object({
      label: z.string().min(1).max(32),
      path: z.string().min(1).max(2_000),
    })).min(1).max(8).optional().describe('Approved local roots to index. Omit to rebuild derived state from stored sources.'),
    git_root: z.string().min(1).max(2_000).optional().describe('Optional Git root recorded with a rebuild snapshot.'),
    forget_mode: z.enum(['preview', 'apply', 'restore']).optional().describe('Preview first. Apply requires its confirm_token. Restore reverses deletion.'),
    confirm_token: z.string().length(16).optional().describe('Token returned by the matching forget preview.'),
    target_id: z.string().min(1).max(200).optional().describe('Assertion or entity id for show or correction.'),
    replacement: z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]).optional().describe('New assertion value, or new entity name for entity_split.'),
    correction_kind: z.enum(['assertion', 'entity_merge', 'entity_split']).optional().describe('Correction operation. Defaults to assertion.'),
    source_ids: z.array(z.string().min(1).max(200)).min(1).max(50).optional().describe('Entity ids merged into target_id by entity_merge.'),
    aliases: z.array(z.string().min(1).max(2_000)).min(1).max(50).optional().describe('Ontology term aliases, or aliases moved during entity_split.'),
    ontology_kind: z.enum(['entity_type', 'relation']).optional().describe('Ontology term kind for record_type=ontology.'),
    version: z.number().int().min(1).optional().describe('Ontology revision number. Defaults to 1 or the superseded term version plus one.'),
    supersedes_term_id: z.string().min(1).max(200).optional().describe('Prior ontology term replaced by this revision.'),
    reason: z.string().min(1).max(2_000).optional().describe('Required reason for any correction.'),
    evidence_ids: z.array(z.string().min(1).max(200)).max(50).optional().describe('Evidence retained on a corrected assertion.'),
    valid_from: z.iso.datetime().optional().describe('Corrected assertion valid-time start.'),
    valid_to: z.iso.datetime().optional().describe('Corrected assertion valid-time end.'),
  },
  outputSchema: ProjectMemoryOutput,
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
}, async (args: ProjectMemoryInput) => {
  return await projectMemoryTool(args, researchService);
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
  const result = await healthTool(buildDeps());
  if (result.isError || !result.structuredContent) return result;
  return formatToolResponse({
    ...result.structuredContent,
    research: researchService.status(),
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${NAME}@${VERSION}] running on stdio`);

if (
  !baseDeps.config.cloudMode
  && !nativeBrowser
  && (baseDeps.config.searchProvider !== 'searchapi' || baseDeps.config.scholarProvider !== 'searchapi')
) {
  (async () => {
    try {
      if (!profileExists()) await autoBootstrap();
      if (profileExists()) await getSequentialCtx();
    } catch (e) {
      console.error('[google-surf-mcp] startup warm failed (will retry on first call):', (e as Error)?.message ?? e);
    }
  })();
}

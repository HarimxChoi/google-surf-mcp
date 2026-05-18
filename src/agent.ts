import type { BrowserContext } from 'playwright';
import type { CallToolResult } from './response.js';
import type { SearchResult } from './types.js';
import { loadConfig, type Config } from './config.js';
import { UnifiedCache, getCache } from './cache.js';
import { RateLimiter, RateLimitedError } from './limiter.js';
import { HumanlikeBehavior, generateBehaviorParams } from './humanlike.js';
import { search as legacySearch, CaptchaError } from './search.js';
import { formatToolResponse, toErrorInfo } from './response.js';
import {
  createCascadeState, executeWithCascade, type CascadeState, type StealthMode,
} from './cascade.js';
import { Telemetry, getTelemetry } from './telemetry.js';
import { VERSION } from './version.js';

import type { ExtractMode, ExtractResult } from './extract.js';
import type { PoolSearchResult } from './pool.js';

export interface PoolHandle {
  runMany: (queries: string[], limit: number, opts?: { locale?: string }) => Promise<PoolSearchResult[]>;
  extractOne: (url: string, maxChars: number, mode?: ExtractMode) => Promise<ExtractResult>;
  searchOne: (query: string, limit: number, opts?: { locale?: string }) => Promise<PoolSearchResult>;
}

export interface Deps {
  config: Config;
  cache: UnifiedCache;
  cascade: CascadeState;
  limiter: RateLimiter;
  tel: Telemetry;
  acquireSeqCtx: (mode: StealthMode) => Promise<BrowserContext>;
  acquirePool: (mode: StealthMode) => Promise<PoolHandle>;
  closeSeq: () => Promise<void>;
  resetPool: () => Promise<void>;
  recoverHuman: () => Promise<void>;
}

export function initDeps(env: NodeJS.ProcessEnv = process.env): Pick<Deps, 'config' | 'cache' | 'cascade' | 'limiter' | 'tel'> {
  const config = loadConfig(env);
  const cache = getCache(config.cacheRoot, config.cacheMaxEntries);
  const cascade = createCascadeState();
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const tel = getTelemetry(config.telemetryRoot, config.telemetryEnabled);
  return { config, cache, cascade, limiter, tel };
}

function tier3Recovery(deps: Deps): () => Promise<void> {
  return async () => {
    if (deps.config.cloudMode) {
      throw new CaptchaError('cloud-mode: tier-3 unavailable');
    }
    await deps.recoverHuman();
  };
}

async function executeSeqWithCascade<T>(
  deps: Deps,
  op: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  if (deps.config.cascadeDisabled) {
    const ctx = await deps.acquireSeqCtx(deps.config.useStealth ? 'on' : 'off');
    return await op(ctx);
  }

  return await executeWithCascade<T>(deps.cascade, {
    runWithMode: async (mode) => {
      const ctx = await deps.acquireSeqCtx(mode);
      return await op(ctx);
    },
    resetContext: async () => { await deps.closeSeq(); },
    tier3Recovery: tier3Recovery(deps),
    isCaptchaError: (e) => e instanceof CaptchaError,
    onTransition: (from, to, reason) => {
      console.error(`[cascade] ${from} → ${to}: ${reason}`);
    },
  });
}

async function executePoolWithCascade<T>(
  deps: Deps,
  op: (pool: PoolHandle) => Promise<T>,
): Promise<T> {
  if (deps.config.cascadeDisabled) {
    const initialMode = deps.config.useStealth ? 'on' : 'off';
    const pool = await deps.acquirePool(initialMode);
    return await op(pool);
  }

  return await executeWithCascade<T>(deps.cascade, {
    runWithMode: async (mode) => {
      const pool = await deps.acquirePool(mode);
      return await op(pool);
    },
    resetContext: async () => {
      await Promise.all([
        deps.resetPool().catch(() => {}),
        deps.closeSeq().catch(() => {}),
      ]);
    },
    tier3Recovery: tier3Recovery(deps),
    isCaptchaError: (e) => e instanceof CaptchaError,
    onTransition: (from, to, reason) => {
      console.error(`[cascade pool] ${from} → ${to}: ${reason}`);
    },
  });
}

export async function searchTool(
  input: { query: string; limit?: number },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);

  if (!query) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'query required', retryable: false,
    });
  }

  const cacheKey = deps.cache.searchKey(query, deps.config.locale, limit);
  const cached = await deps.cache.get<{ results: SearchResult[]; meta: any }>('search', cacheKey);
  if (cached) {
    deps.tel.record('cache.hit', { tool: 'search', namespace: 'search' }).catch(() => {});
    return formatToolResponse(
      { query, results: cached.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...cached.meta, cache: 'hit' },
    );
  }
  deps.tel.record('cache.miss', { tool: 'search', namespace: 'search' }).catch(() => {});

  try {
    await deps.limiter.acquire();
    const params = generateBehaviorParams();
    const outcome = await executeSeqWithCascade(deps, async (ctx) => {
      const page = (await ctx.pages())[0] ?? (await ctx.newPage());
      const behavior = new HumanlikeBehavior(params, deps.config.humanlikeMode);
      const r = await legacySearch(page, query, limit, { locale: deps.config.locale });
      if (deps.config.humanlikeMode !== 'off') {
        await behavior.simulateBrowsing(page, []).catch(() => {});
      }
      return r;
    });

    const meta = {
      strategy: 'legacy-v0.4',
      stealth_mode: deps.cascade.mode,
      dropped: outcome.dropped,
      dropped_reasons: outcome.dropped_reasons,
    };
    await deps.cache.set('search', cacheKey, { results: outcome.results, meta }, deps.config.cacheTtlSearchMs);

    deps.tel.record('search.outcome', {
      tool: 'search',
      resultsLen: outcome.results.length,
      droppedCount: outcome.dropped,
      elapsedMs: Date.now() - t0,
      stealthMode: deps.cascade.mode,
    }).catch(() => {});

    return formatToolResponse(
      { query, results: outcome.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...meta, cache: 'miss' },
    );
  } catch (e) {
    recordToolError(deps, 'search', e);
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

export async function searchParallelTool(
  input: { queries: string[]; limit?: number },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const queries = input.queries.map(q => String(q).trim()).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);

  if (queries.length === 0) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'queries required', retryable: false,
    });
  }

  if (deps.config.cloudMode) {
    return formatToolResponse(null, {
      code: 'INTERNAL',
      message: 'search_parallel disabled in cloud mode (worker pool incompatible). Use search instead.',
      retryable: false,
    });
  }

  try {
    for (let i = 0; i < queries.length; i++) await deps.limiter.acquire();
    const results = await executePoolWithCascade(deps, async (pool) => {
      return await pool.runMany(queries, limit, { locale: deps.config.locale });
    });

    const elapsed = Date.now() - t0;
    for (const r of results) {
      deps.tel.record('search.outcome', {
        tool: 'search_parallel',
        resultsLen: r.results.length,
        droppedCount: r.dropped ?? 0,
        elapsedMs: elapsed,
        stealthMode: deps.cascade.mode,
      }).catch(() => {});
    }

    return formatToolResponse(
      { results, elapsed_ms: elapsed },
      undefined,
      { stealth_mode: deps.cascade.mode, cache: 'miss' },
    );
  } catch (e) {
    recordToolError(deps, 'search_parallel', e);
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

export async function extractTool(
  input: { url: string; max_chars?: number; mode?: ExtractMode },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const url = input.url.trim();
  const maxChars = Math.min(Math.max(input.max_chars ?? 8_000, 200), 50_000);
  const mode: ExtractMode = input.mode ?? 'full';

  if (!url) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'url required', retryable: false,
    });
  }

  try {
    const initialMode: StealthMode = deps.cascade.mode;
    const pool = await deps.acquirePool(initialMode);
    const result = await pool.extractOne(url, maxChars, mode);
    const failed = !!result.error && !result.content;

    if (failed) {
      deps.tel.record('tool.error', {
        tool: 'extract',
        errorCode: 'EXTRACT_FAILED',
        retryable: true,
      }).catch(() => {});
      return formatToolResponse(null, {
        code: 'EXTRACT_FAILED',
        message: typeof result.error === 'string' ? result.error : 'unknown extract failure',
        retryable: true,
        retry_after_ms: 1000,
      });
    }

    return formatToolResponse(
      { ...result, elapsed_ms: Date.now() - t0 },
    );
  } catch (e) {
    recordToolError(deps, 'extract', e);
    return handleError(e, deps);
  }
}

export async function searchExtractTool(
  input: { query: string; limit?: number; max_chars?: number; mode?: 'full' | 'abstract' },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const mode: ExtractMode = input.mode ?? 'abstract';
  const defaultMax = mode === 'abstract' ? 1_500 : 8_000;
  const maxChars = Math.min(Math.max(input.max_chars ?? defaultMax, 200), 20_000);

  if (!query) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'query required', retryable: false,
    });
  }

  if (deps.config.cloudMode) {
    return formatToolResponse(null, {
      code: 'INTERNAL',
      message: 'search_extract disabled in cloud mode (worker pool incompatible). Use search + extract separately.',
      retryable: false,
    });
  }

  try {
    await deps.limiter.acquire();
    const data = await executePoolWithCascade(deps, async (pool) => {
      const sr = await pool.searchOne(query, limit, { locale: deps.config.locale });
      if (!sr.results.length) return { results: [], searchError: sr.error, droppedCount: sr.dropped ?? 0 };
      const enriched = await Promise.all(sr.results.map(async (r) => {
        const ex = await pool.extractOne(r.url, maxChars, mode);
        return {
          title: r.title, url: r.url, description: r.description,
          content: ex.content, excerpt: ex.excerpt, length: ex.length,
          is_pdf: ex.is_pdf, page_count: ex.page_count, extraction_quality: ex.extraction_quality,
          error: typeof ex.error === 'string' ? ex.error : undefined,
        };
      }));
      return { results: enriched, searchError: undefined as string | undefined, droppedCount: sr.dropped ?? 0 };
    });

    deps.tel.record('search.outcome', {
      tool: 'search_extract',
      resultsLen: data.results.length,
      droppedCount: data.droppedCount,
      elapsedMs: Date.now() - t0,
      stealthMode: deps.cascade.mode,
    }).catch(() => {});

    if (data.searchError && data.results.length === 0) {
      return formatToolResponse(null, {
        code: 'EXTRACT_FAILED',
        message: data.searchError,
        retryable: true,
      });
    }
    return formatToolResponse(
      { query, results: data.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { stealth_mode: deps.cascade.mode },
    );
  } catch (e) {
    recordToolError(deps, 'search_extract', e);
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

export async function healthTool(deps: Deps): Promise<CallToolResult> {
  const cacheStats = {
    search: await deps.cache.size('search'),
    extract: await deps.cache.size('extract'),
  };
  return formatToolResponse({
    version: VERSION,
    cascade: {
      mode: deps.cascade.mode,
      captchaCountInMode: deps.cascade.captchaCountInMode,
      captchasByMode: deps.cascade.captchasByMode,
      totalCaptchas: deps.cascade.totalCaptchas,
      lastTransitionAt: deps.cascade.lastTransitionAt,
      disabled: deps.config.cascadeDisabled,
    },
    rateLimiter: {
      perMin: deps.config.rateLimitPerMin,
      recentCount: deps.limiter.recentCount,
      queueSize: deps.limiter.queueSize,
    },
    cache: cacheStats,
    telemetry: {
      enabled: deps.config.telemetryEnabled,
      ...(deps.config.telemetryEnabled ? await deps.tel.size() : { files: 0, events: 0 }),
    },
    config: {
      cloudMode: deps.config.cloudMode,
      humanlikeMode: deps.config.humanlikeMode,
      useStealth: deps.config.useStealth,
      insecureTls: deps.config.insecureTls,
      noSandbox: deps.config.noSandbox,
    },
  });
}

function rateLimitResponse(e: unknown): CallToolResult | null {
  if (!(e instanceof RateLimitedError)) return null;
  return formatToolResponse(null, {
    code: 'RATE_LIMITED',
    message: 'internal rate limit; retry shortly',
    retryable: true,
    retry_after_ms: e.retryAfterMs,
  });
}

function handleError(e: unknown, deps: Deps): CallToolResult {
  console.error('[google-surf-mcp] tool error:', e);
  return formatToolResponse(null, toErrorInfo(e, { cloudMode: deps.config.cloudMode }));
}

// Records both the generic tool.error event and, when the error message
// matches the parser-stale signature thrown by search.ts, an additional
// parse.stale event for self-healing trigger detection.
function recordToolError(deps: Deps, tool: string, e: unknown): void {
  const info = toErrorInfo(e, { cloudMode: deps.config.cloudMode });
  deps.tel.record('tool.error', {
    tool,
    errorCode: info.code,
    retryable: info.retryable,
  }).catch(() => {});

  if (info.code === 'PARSER_STALE') {
    const message = e instanceof Error ? e.message : String(e);
    // Best-effort h3 count extraction; structured signal will follow when
    // search.ts gains structured error throwing.
    const h3Match = message.match(/(\d+)\s*h3/i);
    deps.tel.record('parse.stale', {
      tool,
      reason: 'h3_but_no_results',
      h3Count: h3Match ? Number(h3Match[1]) : null,
    }).catch(() => {});
  }
}
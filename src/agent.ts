import type { BrowserContext } from 'playwright';
import type { CallToolResult } from './response.js';
import type { SearchResult } from './types.js';
import { loadConfig, type Config, type SearchProviderMode } from './config.js';
import { UnifiedCache, getCache } from './cache.js';
import { RateLimiter, RateLimitedError } from './limiter.js';
import { HumanlikeBehavior, generateBehaviorParams } from './humanlike.js';
import { search as legacySearch, CaptchaError } from './search.js';
import {
  scholarSearch, ScholarRateLimitError, type ScholarResult,
} from './scholar.js';
import {
  SearchApiClient, SearchApiConfigError, SearchApiError, type SearchApiHandle,
} from './searchApi.js';
import { formatToolResponse, toErrorInfo } from './response.js';
import {
  createCascadeState, executeWithCascade, type CascadeState, type StealthMode,
} from './cascade.js';
import { loadCascadeMode, saveCascadeMode } from './cascadeStore.js';
import { Telemetry, getTelemetry } from './telemetry.js';
import { StrategyHealing, getStrategyHealing } from './strategyHealing.js';
import { STRATEGIES } from './parse.js';
import { VERSION } from './version.js';

import type { ExtractMode, ExtractResult } from './extract.js';
import type { PoolSearchResult } from './pool.js';
import type { SearchOptions } from './search.js';

export interface PoolHandle {
  runMany: (queries: string[], limit: number, opts?: SearchOptions) => Promise<PoolSearchResult[]>;
  extractOne: (url: string, maxChars: number, mode?: ExtractMode) => Promise<ExtractResult>;
  searchOne: (query: string, limit: number, opts?: SearchOptions) => Promise<PoolSearchResult>;
}

export interface PoolHealthSnapshot {
  warmFailures: number;
  fallback: boolean;
}

export interface Deps {
  config: Config;
  cache: UnifiedCache;
  cascade: CascadeState;
  limiter: RateLimiter;
  tel: Telemetry;
  healing: StrategyHealing;
  acquireSeqCtx: (mode: StealthMode) => Promise<BrowserContext>;
  acquirePool: (mode: StealthMode) => Promise<PoolHandle>;
  closeSeq: () => Promise<void>;
  resetPool: () => Promise<void>;
  recoverHuman: (seedQuery?: string) => Promise<void>;
  getPoolHealth: () => PoolHealthSnapshot;
  searchApi?: SearchApiHandle;
}

export interface SearchRunOptions {
  browserUnavailable?: string;
}

export function initDeps(env: NodeJS.ProcessEnv = process.env): Pick<Deps, 'config' | 'cache' | 'cascade' | 'limiter' | 'tel' | 'healing'> {
  const config = loadConfig(env);
  const cache = getCache(config.cacheRoot, config.cacheMaxEntries);
  // Without this, every process restart repays the captcha that taught us the mode.
  const cascade = createCascadeState(loadCascadeMode(config.cascadeStateFile, 'off'));
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const tel = getTelemetry(config.telemetryRoot, config.telemetryEnabled);
  const healing = getStrategyHealing(
    config.selfHealingFile,
    config.selfHealingEnabled,
    STRATEGIES.map((s) => s.id),
  );
  healing.load().catch(() => {});
  return { config, cache, cascade, limiter, tel, healing };
}

function makeHumanlike(deps: Deps): HumanlikeBehavior | undefined {
  if (deps.config.humanlikeMode === 'off') return undefined;
  return new HumanlikeBehavior(generateBehaviorParams(), deps.config.humanlikeMode);
}

function tier3Recovery(deps: Deps, seedQuery?: string): () => Promise<void> {
  return async () => {
    if (deps.config.cloudMode) {
      throw new CaptchaError('cloud-mode: tier-3 unavailable');
    }
    await deps.recoverHuman(seedQuery);
  };
}

async function executeSeqWithCascade<T>(
  deps: Deps,
  op: (ctx: BrowserContext) => Promise<T>,
  seedQuery?: string,
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
    tier3Recovery: tier3Recovery(deps, seedQuery),
    isCaptchaError: (e) => e instanceof CaptchaError,
    onTransition: (from, to, reason) => {
      console.error(`[cascade] ${from} -> ${to}: ${reason}`);
      persistCascadeMode(deps, to);
    },
  });
}

function persistCascadeMode(deps: Deps, to: StealthMode | 'tier3'): void {
  if (to === 'tier3') return;
  saveCascadeMode(deps.config.cascadeStateFile, to);
}

async function executePoolWithCascade<T>(
  deps: Deps,
  op: (pool: PoolHandle) => Promise<T>,
  seedQuery?: string,
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
    tier3Recovery: tier3Recovery(deps, seedQuery),
    isCaptchaError: (e) => e instanceof CaptchaError,
    onTransition: (from, to, reason) => {
      console.error(`[cascade pool] ${from} -> ${to}: ${reason}`);
      persistCascadeMode(deps, to);
    },
  });
}

export async function searchTool(
  input: { query: string; limit?: number },
  deps: Deps,
  options: SearchRunOptions = {},
): Promise<CallToolResult> {
  const t0 = Date.now();
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const mode = deps.config.searchProvider;

  if (!query) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'query required', retryable: false,
    });
  }

  const configError = providerConfigError(mode, deps);
  if (configError) return configError;

  const cacheKey = providerCacheKey(deps, query, limit, mode);
  const cached = await deps.cache.get<{ results: SearchResult[]; meta: any }>('search', cacheKey);
  if (cached) {
    deps.tel.record('cache.hit', { tool: 'search', namespace: 'search' }).catch(() => {});
    return formatToolResponse(
      { query, results: cached.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...cached.meta, provider: cached.meta.provider ?? 'browser', cache: 'hit' },
    );
  }
  deps.tel.record('cache.miss', { tool: 'search', namespace: 'search' }).catch(() => {});

  if (mode === 'searchapi' || options.browserUnavailable) {
    try {
      return await runSearchApiGoogle(
        query,
        limit,
        cacheKey,
        deps,
        t0,
        options.browserUnavailable ? 'PROFILE_MISSING' : undefined,
      );
    } catch (e) {
      recordToolError(deps, 'search', e);
      return searchApiErrorResponse(e) ?? handleError(e, deps);
    }
  }

  try {
    await deps.limiter.acquire();
    const params = generateBehaviorParams();
    const outcome = await executeSeqWithCascade(deps, async (ctx) => {
      const page = (await ctx.pages())[0] ?? (await ctx.newPage());
      const humanlike = deps.config.humanlikeMode !== 'off'
        ? new HumanlikeBehavior(params, deps.config.humanlikeMode)
        : undefined;
      const r = await legacySearch(page, query, limit, {
        locale: deps.config.locale,
        healing: deps.healing,
        humanlike,
      });
      await humanlike?.simulateBrowsing(page, []).catch(() => {});
      return r;
    }, query);

    if (outcome.degraded_reasons?.length) {
      console.error(`[google-surf-mcp] parser degraded: ${outcome.degraded_reasons.join(', ')}`);
      deps.tel.record('parse.degraded', {
        tool: 'search',
        reasons: outcome.degraded_reasons,
        resultsLen: outcome.results.length,
      }).catch(() => {});
    }

    if (mode === 'fallback' && outcome.degraded_reasons?.length) {
      return await runSearchApiGoogle(query, limit, cacheKey, deps, t0, 'PARSER_STALE');
    }

    const meta = {
      strategy: 'legacy-v0.4',
      provider: 'browser' as const,
      stealth_mode: deps.cascade.mode,
      dropped: outcome.dropped,
      dropped_reasons: outcome.dropped_reasons,
      ...(outcome.degraded_reasons?.length ? { degraded_reasons: outcome.degraded_reasons } : {}),
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
    if (mode === 'fallback') {
      try {
        const reason = toErrorInfo(e, { cloudMode: deps.config.cloudMode }).code;
        return await runSearchApiGoogle(query, limit, cacheKey, deps, t0, reason);
      } catch (apiError) {
        recordToolError(deps, 'search', apiError);
        return searchApiErrorResponse(apiError) ?? handleError(apiError, deps);
      }
    }
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

async function runSearchApiGoogle(
  query: string,
  limit: number,
  cacheKey: string,
  deps: Deps,
  t0: number,
  fallbackReason?: string,
): Promise<CallToolResult> {
  const results = await searchApi(deps).searchGoogle(query, limit, deps.config.locale);
  const meta = providerMeta('searchapi-google-v1', fallbackReason);
  await deps.cache.set('search', cacheKey, { results, meta }, deps.config.cacheTtlSearchMs);
  deps.tel.record('search.outcome', {
    tool: 'search',
    provider: 'searchapi',
    resultsLen: results.length,
    droppedCount: 0,
    elapsedMs: Date.now() - t0,
  }).catch(() => {});
  return formatToolResponse(
    { query, results, elapsed_ms: Date.now() - t0 },
    undefined,
    { ...meta, cache: 'miss' },
  );
}

function searchApi(deps: Deps): SearchApiHandle {
  return deps.searchApi ?? new SearchApiClient(deps.config.searchApiKey);
}

function providerConfigError(mode: SearchProviderMode, deps: Deps): CallToolResult | null {
  if (mode === 'browser' || deps.searchApi || deps.config.searchApiKey) return null;
  return formatToolResponse(null, {
    code: 'API_KEY_MISSING',
    message: 'SEARCH_API is required for SearchApi provider modes.',
    retryable: false,
    user_action: 'Set SEARCH_API to a valid SearchApi API key.',
  });
}

function searchApiErrorResponse(e: unknown): CallToolResult | null {
  if (e instanceof SearchApiConfigError) {
    return formatToolResponse(null, {
      code: 'API_KEY_MISSING',
      message: e.message,
      retryable: false,
      user_action: 'Set SEARCH_API to a valid SearchApi API key.',
    });
  }
  if (!(e instanceof SearchApiError)) return null;
  if (e.status === 429) {
    return formatToolResponse(null, {
      code: 'RATE_LIMITED',
      message: e.message,
      retryable: true,
      retry_after_ms: e.retryAfterMs ?? 60_000,
    });
  }
  return formatToolResponse(null, {
    code: 'SEARCH_API_ERROR',
    message: e.message,
    retryable: e.status === undefined || e.status >= 500,
    ...(e.status === 401 || e.status === 403
      ? { user_action: 'Check SEARCH_API and SearchApi account access.' }
      : {}),
  });
}

function providerCacheKey(
  deps: Deps,
  query: string,
  limit: number,
  mode: SearchProviderMode,
): string {
  const scopedQuery = mode === 'browser' ? query : `${query}\nprovider:${mode}`;
  return deps.cache.searchKey(scopedQuery, deps.config.locale, limit);
}

function providerMeta(strategy: string, fallbackReason?: string) {
  return {
    strategy,
    provider: 'searchapi' as const,
    ...(fallbackReason ? { fallback_from: 'browser' as const, fallback_reason: fallbackReason } : {}),
  };
}

export async function scholarSearchTool(
  input: { query: string; limit?: number },
  deps: Deps,
  options: SearchRunOptions = {},
): Promise<CallToolResult> {
  const t0 = Date.now();
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 10);
  const mode = deps.config.scholarProvider;

  if (!query) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'query required', retryable: false,
    });
  }

  const configError = providerConfigError(mode, deps);
  if (configError) return configError;

  const cacheKey = providerCacheKey(deps, query, limit, mode);
  const cached = await deps.cache.get<{ results: ScholarResult[]; meta: any }>('scholar', cacheKey);
  if (cached) {
    deps.tel.record('cache.hit', { tool: 'scholar_search', namespace: 'scholar' }).catch(() => {});
    return formatToolResponse(
      { query, results: cached.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...cached.meta, provider: cached.meta.provider ?? 'browser', cache: 'hit' },
    );
  }
  deps.tel.record('cache.miss', { tool: 'scholar_search', namespace: 'scholar' }).catch(() => {});

  if (mode === 'searchapi' || options.browserUnavailable) {
    try {
      return await runSearchApiScholar(
        query,
        limit,
        cacheKey,
        deps,
        t0,
        options.browserUnavailable ? 'PROFILE_MISSING' : undefined,
      );
    } catch (e) {
      recordToolError(deps, 'scholar_search', e);
      return searchApiErrorResponse(e) ?? handleError(e, deps);
    }
  }

  const cooldownKey = deps.cache.searchKey('__scholar_rate_limit__', deps.config.locale, 0);
  const cooldown = await deps.cache.get<{ until: number }>('scholar', cooldownKey);
  if (cooldown && cooldown.until > Date.now()) {
    if (mode === 'fallback') {
      try {
        return await runSearchApiScholar(query, limit, cacheKey, deps, t0, 'RATE_LIMITED');
      } catch (e) {
        recordToolError(deps, 'scholar_search', e);
        return searchApiErrorResponse(e) ?? handleError(e, deps);
      }
    }
    return rateLimitResponse(new ScholarRateLimitError(cooldown.until - Date.now()))!;
  }

  try {
    await deps.limiter.acquire();
    const params = generateBehaviorParams();
    const mode = deps.config.cascadeDisabled
      ? (deps.config.useStealth ? 'on' : 'off')
      : deps.cascade.mode;
    const ctx = await deps.acquireSeqCtx(mode);
    const page = (await ctx.pages())[0] ?? (await ctx.newPage());
    const humanlike = deps.config.humanlikeMode !== 'off'
      ? new HumanlikeBehavior(params, deps.config.humanlikeMode)
      : undefined;
    const results = await scholarSearch(page, query, limit, {
      humanlike,
      locale: deps.config.locale,
    });
    await humanlike?.simulateBrowsing(page, []).catch(() => {});

    const meta = { strategy: 'scholar-v1', provider: 'browser' as const, stealth_mode: mode };
    await deps.cache.set('scholar', cacheKey, { results, meta }, deps.config.cacheTtlSearchMs);
    deps.tel.record('search.outcome', {
      tool: 'scholar_search',
      resultsLen: results.length,
      droppedCount: 0,
      elapsedMs: Date.now() - t0,
      stealthMode: deps.cascade.mode,
    }).catch(() => {});

    return formatToolResponse(
      { query, results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...meta, cache: 'miss' },
    );
  } catch (e) {
    if (e instanceof ScholarRateLimitError) {
      await deps.cache.set(
        'scholar',
        cooldownKey,
        { until: Date.now() + e.retryAfterMs },
        e.retryAfterMs,
      ).catch(() => {});
    }
    recordToolError(deps, 'scholar_search', e);
    if (mode === 'fallback') {
      try {
        const reason = toErrorInfo(e, { cloudMode: deps.config.cloudMode }).code;
        return await runSearchApiScholar(query, limit, cacheKey, deps, t0, reason);
      } catch (apiError) {
        recordToolError(deps, 'scholar_search', apiError);
        return searchApiErrorResponse(apiError) ?? handleError(apiError, deps);
      }
    }
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

async function runSearchApiScholar(
  query: string,
  limit: number,
  cacheKey: string,
  deps: Deps,
  t0: number,
  fallbackReason?: string,
): Promise<CallToolResult> {
  const results = await searchApi(deps).searchScholar(query, limit, deps.config.locale);
  const meta = providerMeta('searchapi-scholar-v1', fallbackReason);
  await deps.cache.set('scholar', cacheKey, { results, meta }, deps.config.cacheTtlSearchMs);
  deps.tel.record('search.outcome', {
    tool: 'scholar_search',
    provider: 'searchapi',
    resultsLen: results.length,
    droppedCount: 0,
    elapsedMs: Date.now() - t0,
  }).catch(() => {});
  return formatToolResponse(
    { query, results, elapsed_ms: Date.now() - t0 },
    undefined,
    { ...meta, cache: 'miss' },
  );
}

export async function searchParallelTool(
  input: { queries: string[]; limit?: number },
  deps: Deps,
  options: SearchRunOptions = {},
): Promise<CallToolResult> {
  const t0 = Date.now();
  const queries = input.queries.map(q => String(q).trim()).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const mode = deps.config.searchProvider;

  if (queries.length === 0) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'queries required', retryable: false,
    });
  }

  const configError = providerConfigError(mode, deps);
  if (configError) return configError;

  if (mode === 'searchapi' || options.browserUnavailable || (mode === 'fallback' && deps.config.cloudMode)) {
    try {
      const fallbackReason = options.browserUnavailable
        ? 'PROFILE_MISSING'
        : mode === 'fallback' && deps.config.cloudMode ? 'CLOUD_MODE' : undefined;
      const results = await runSearchApiParallel(queries, limit, deps, fallbackReason);
      return parallelResponse(results, t0, deps, 'searchapi');
    } catch (e) {
      recordToolError(deps, 'search_parallel', e);
      return searchApiErrorResponse(e) ?? handleError(e, deps);
    }
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
      return await pool.runMany(queries, limit, {
        locale: deps.config.locale,
        healing: deps.healing,
        humanlike: makeHumanlike(deps),
      });
    }, queries[0]);

    if (mode === 'fallback') {
      const fallbackRows = results.filter((row) => row.error || row.degraded_reasons?.length);
      if (fallbackRows.length) {
        const apiRows = (await Promise.all(fallbackRows.map((row) => runSearchApiParallel(
          [row.query],
          limit,
          deps,
          row.degraded_reasons?.length ? 'PARSER_STALE' : 'BROWSER_ERROR',
        )))).flat();
        const replacements = new Map(apiRows.map((row) => [row.query, row]));
        const merged = results.map((row) => replacements.get(row.query) ?? { ...row, provider: 'browser' as const });
        const provider = merged.every((row) => row.provider === 'searchapi') ? 'searchapi' : 'mixed';
        return parallelResponse(merged, t0, deps, provider);
      }
    }
    return parallelResponse(
      results.map((row) => ({ ...row, provider: 'browser' as const })),
      t0,
      deps,
      'browser',
    );
  } catch (e) {
    recordToolError(deps, 'search_parallel', e);
    if (mode === 'fallback') {
      try {
        const reason = toErrorInfo(e, { cloudMode: deps.config.cloudMode }).code;
        const results = await runSearchApiParallel(queries, limit, deps, reason);
        return parallelResponse(results, t0, deps, 'searchapi');
      } catch (apiError) {
        recordToolError(deps, 'search_parallel', apiError);
        return searchApiErrorResponse(apiError) ?? handleError(apiError, deps);
      }
    }
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

async function runSearchApiParallel(
  queries: string[],
  limit: number,
  deps: Deps,
  fallbackReason?: string,
): Promise<PoolSearchResult[]> {
  return await Promise.all(queries.map(async (query) => ({
    query,
    results: await searchApi(deps).searchGoogle(query, limit, deps.config.locale),
    provider: 'searchapi' as const,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  })));
}

function parallelResponse(
  results: PoolSearchResult[],
  t0: number,
  deps: Deps,
  provider: 'browser' | 'searchapi' | 'mixed',
): CallToolResult {
  const elapsed = Date.now() - t0;
  for (const row of results) {
    deps.tel.record('search.outcome', {
      tool: 'search_parallel',
      provider: row.provider ?? provider,
      resultsLen: row.results.length,
      droppedCount: row.dropped ?? 0,
      elapsedMs: elapsed,
      stealthMode: deps.cascade.mode,
    }).catch(() => {});
  }
  return formatToolResponse(
    { results, elapsed_ms: elapsed },
    undefined,
    { provider, stealth_mode: deps.cascade.mode, cache: 'miss' },
  );
}

export async function extractTool(
  input: { url: string; max_chars?: number; mode?: ExtractMode },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const url = input.url.trim();
  const maxChars = Math.min(Math.max(input.max_chars ?? deps.config.extractMaxChars, 200), 50_000);
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
  const defaultMax = mode === 'abstract' ? 1_500 : deps.config.extractMaxChars;
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
      const sr = await pool.searchOne(query, limit, {
        locale: deps.config.locale,
        healing: deps.healing,
        humanlike: makeHumanlike(deps),
      });
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
    scholar: await deps.cache.size('scholar'),
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
    pool: deps.getPoolHealth(),
    telemetry: {
      enabled: deps.config.telemetryEnabled,
      ...(deps.config.telemetryEnabled ? await deps.tel.size() : { files: 0, events: 0 }),
    },
    selfHealing: {
      enabled: deps.config.selfHealingEnabled,
      order: deps.healing.getOrderedStrategyIds(STRATEGIES.map((s) => s.id)),
      stats: deps.healing.getStats(),
      baselineResults: deps.healing.baselineResults() ?? null,
    },
    config: {
      cloudMode: deps.config.cloudMode,
      humanlikeMode: deps.config.humanlikeMode,
      searchProvider: deps.config.searchProvider,
      scholarProvider: deps.config.scholarProvider,
      searchApiConfigured: Boolean(deps.config.searchApiKey),
      useStealth: deps.config.useStealth,
      insecureTls: deps.config.insecureTls,
      noSandbox: deps.config.noSandbox,
    },
  });
}

function rateLimitResponse(e: unknown): CallToolResult | null {
  if (e instanceof ScholarRateLimitError) {
    return formatToolResponse(null, {
      code: 'RATE_LIMITED',
      message: e.message,
      retryable: true,
      retry_after_ms: e.retryAfterMs,
    });
  }
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

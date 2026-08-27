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
import type { NativeBrowserHandle } from './nativeBrowser.js';

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
  nativeBrowser?: NativeBrowserHandle;
}

export interface SearchRunOptions {
  browserUnavailable?: string;
}

export type SearchExtractionMode = 'none' | 'abstract' | 'full';

export interface SearchExtractionInput {
  extract_mode?: SearchExtractionMode;
  extract_limit?: number;
  max_chars?: number;
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
  if (deps.config.searchProvider === 'fallback') {
    const ctx = await deps.acquireSeqCtx(deps.cascade.mode);
    return await op(ctx);
  }
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
  if (deps.config.searchProvider === 'fallback') {
    const pool = await deps.acquirePool(deps.cascade.mode);
    return await op(pool);
  }
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
    const outcome = deps.nativeBrowser
      ? await deps.nativeBrowser.search(query, limit, {
        locale: deps.config.locale,
        healing: deps.healing,
      })
      : await executeSeqWithCascade(deps, async (ctx) => {
        const page = (await ctx.pages())[0] ?? (await ctx.newPage());
        const humanlike = makeHumanlike(deps);
        const result = await legacySearch(page, query, limit, {
          locale: deps.config.locale,
          healing: deps.healing,
          humanlike,
        });
        await humanlike?.simulateBrowsing(page, []).catch(() => {});
        return result;
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
      strategy: deps.nativeBrowser ? 'native-chrome-v1' : 'legacy-v0.4',
      provider: 'browser' as const,
      browser_engine: deps.nativeBrowser ? 'native' as const : 'playwright' as const,
      ...(!deps.nativeBrowser ? { stealth_mode: deps.cascade.mode } : {}),
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
  const engine = deps.nativeBrowser ? 'native' : 'playwright';
  const scopedQuery = mode === 'browser' && engine === 'playwright'
    ? query
    : `${query}\nprovider:${mode}\nbrowser_engine:${engine}`;
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
  const cooldown = await deps.cache.get<{ until: number; reason?: string }>('scholar', cooldownKey);
  if (cooldown && cooldown.until > Date.now()) {
    if (mode === 'fallback') {
      try {
        return await runSearchApiScholar(
          query, limit, cacheKey, deps, t0, cooldown.reason ?? 'RATE_LIMITED',
        );
      } catch (e) {
        recordToolError(deps, 'scholar_search', e);
        return searchApiErrorResponse(e) ?? handleError(e, deps);
      }
    }
    return rateLimitResponse(new ScholarRateLimitError(cooldown.until - Date.now()))!;
  }

  try {
    await deps.limiter.acquire();
    const stealthMode = deps.config.cascadeDisabled
      ? (deps.config.useStealth ? 'on' : 'off')
      : deps.cascade.mode;
    const results = deps.nativeBrowser
      ? await deps.nativeBrowser.scholar(query, limit, deps.config.locale)
      : await (async () => {
        const ctx = await deps.acquireSeqCtx(stealthMode);
        const page = (await ctx.pages())[0] ?? (await ctx.newPage());
        const humanlike = makeHumanlike(deps);
        const rows = await scholarSearch(page, query, limit, {
          humanlike,
          locale: deps.config.locale,
        });
        await humanlike?.simulateBrowsing(page, []).catch(() => {});
        return rows;
      })();

    const meta = {
      strategy: deps.nativeBrowser ? 'native-scholar-v1' : 'scholar-v1',
      provider: 'browser' as const,
      browser_engine: deps.nativeBrowser ? 'native' as const : 'playwright' as const,
      ...(!deps.nativeBrowser ? { stealth_mode: stealthMode } : {}),
    };
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
    if (e instanceof ScholarRateLimitError || e instanceof CaptchaError) {
      const retryAfterMs = e instanceof ScholarRateLimitError ? e.retryAfterMs : 15 * 60_000;
      await deps.cache.set(
        'scholar',
        cooldownKey,
        {
          until: Date.now() + retryAfterMs,
          reason: e instanceof CaptchaError ? 'CAPTCHA_RECOVER_FAIL' : 'RATE_LIMITED',
        },
        retryAfterMs,
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
  if (queries.length > 12) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'queries must contain at most 12 items', retryable: false,
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
    const results = deps.nativeBrowser
      ? await runNativeParallel(queries, limit, deps)
      : await executePoolWithCascade(deps, async (pool) => {
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

async function runNativeParallel(
  queries: string[],
  limit: number,
  deps: Deps,
): Promise<PoolSearchResult[]> {
  const rows = await deps.nativeBrowser!.searchMany(queries, limit, {
    locale: deps.config.locale,
    healing: deps.healing,
  });
  return rows.map(({ query, outcome, error }) => outcome ? {
    query,
    results: outcome.results,
    dropped: outcome.dropped,
    dropped_reasons: outcome.dropped_reasons,
    degraded_reasons: outcome.degraded_reasons,
  } : { query, results: [], error });
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
    {
      provider,
      browser_engine: deps.nativeBrowser ? 'native' : 'playwright',
      ...(!deps.nativeBrowser ? { stealth_mode: deps.cascade.mode } : {}),
      cache: 'miss',
    },
  );
}

export async function extractTool(
  input: { url: string; max_chars?: number; mode?: ExtractMode },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const url = input.url.trim();
  const mode: ExtractMode = input.mode ?? 'full';
  const defaultMax = mode === 'abstract' ? 1_500 : deps.config.extractMaxChars;
  const maxChars = Math.min(Math.max(input.max_chars ?? defaultMax, 200), 50_000);

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

type ExtractableRow = Record<string, unknown> & { url?: string };

interface ExtractionSummary {
  mode: 'abstract' | 'full';
  requested: number;
  succeeded: number;
  failed: number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function extractionError(result: CallToolResult): string | undefined {
  const error = result.structuredContent?.error;
  if (typeof error === 'string') return error;
  const message = asObject(error).message;
  return typeof message === 'string' ? message : result.isError ? 'extraction failed' : undefined;
}

function extractionPatch(result: CallToolResult): Record<string, unknown> {
  const error = extractionError(result);
  if (error) return { extract_error: error };
  const data = asObject(result.structuredContent);
  return Object.fromEntries([
    'content', 'excerpt', 'length', 'is_pdf', 'page_count', 'extraction_quality',
    'authors', 'publication', 'published_at', 'year', 'doi', 'description',
    'keywords', 'canonical_url', 'language', 'subject', 'creator', 'producer',
    'created_at', 'modified_at',
  ].flatMap((key) => data[key] === undefined ? [] : [[key, data[key]]]));
}

function extractionUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function uniqueUrls(rows: ExtractableRow[], limit: number): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.url !== 'string') continue;
    const key = extractionUrlKey(row.url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(row.url);
    if (urls.length >= limit) break;
  }
  return urls;
}

async function extractUrls(
  urls: string[],
  mode: 'abstract' | 'full',
  maxChars: number,
  deps: Deps,
): Promise<{ patches: Map<string, Record<string, unknown>>; summary: ExtractionSummary }> {
  const patches = new Map<string, Record<string, unknown>>();
  try {
    const pool = await deps.acquirePool(deps.cascade.mode);
    await Promise.all(urls.map(async (url) => {
      try {
        const result = await pool.extractOne(url, maxChars, mode);
        patches.set(extractionUrlKey(url), result.error && !result.content
          ? { extract_error: result.error }
          : extractionPatch(formatToolResponse({ ...result })));
      } catch (error) {
        patches.set(extractionUrlKey(url), {
          extract_error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const url of urls) patches.set(extractionUrlKey(url), { extract_error: message });
  }
  const failed = [...patches.values()].filter((patch) => 'extract_error' in patch).length;
  return {
    patches,
    summary: { mode, requested: urls.length, succeeded: urls.length - failed, failed },
  };
}

function withExtraction(
  result: CallToolResult,
  results: unknown,
  summary: ExtractionSummary,
  elapsedMs: number,
): CallToolResult {
  const data = asObject(result.structuredContent);
  const meta = asObject(data.meta);
  return formatToolResponse({
    ...data,
    results,
    elapsed_ms: elapsedMs,
    meta: { ...meta, extraction: summary },
  });
}

function extractionSettings(input: SearchExtractionInput, deps: Deps) {
  const mode = input.extract_mode ?? 'none';
  const limit = Math.min(Math.max(input.extract_limit ?? 5, 1), 10);
  const defaultMax = mode === 'abstract' ? 1_500 : deps.config.extractMaxChars;
  const maxChars = Math.min(Math.max(input.max_chars ?? defaultMax, 200), 50_000);
  return { mode, limit, maxChars };
}

export async function applySearchExtraction(
  result: CallToolResult,
  input: SearchExtractionInput,
  deps: Deps,
): Promise<CallToolResult> {
  const settings = extractionSettings(input, deps);
  if (settings.mode === 'none' || result.isError || !result.structuredContent) return result;
  const started = Date.now();
  const rows = Array.isArray(result.structuredContent.results)
    ? result.structuredContent.results.map((row) => asObject(row))
    : [];
  const urls = uniqueUrls(rows, settings.limit);
  const extracted = await extractUrls(urls, settings.mode, settings.maxChars, deps);
  const results = rows.map((row) => typeof row.url === 'string'
    && extracted.patches.has(extractionUrlKey(row.url))
    ? { ...row, ...extracted.patches.get(extractionUrlKey(row.url)) }
    : row);
  const elapsed = Number(result.structuredContent.elapsed_ms ?? 0) + Date.now() - started;
  return withExtraction(result, results, extracted.summary, elapsed);
}

export async function applyParallelSearchExtraction(
  result: CallToolResult,
  input: SearchExtractionInput,
  deps: Deps,
): Promise<CallToolResult> {
  const settings = extractionSettings(input, deps);
  if (settings.mode === 'none' || result.isError || !result.structuredContent) return result;
  const started = Date.now();
  const groups = Array.isArray(result.structuredContent.results)
    ? result.structuredContent.results.map((group) => {
      const data = asObject(group);
      return {
        ...data,
        results: Array.isArray(data.results) ? data.results.map((row) => asObject(row)) : [],
      };
    })
    : [];
  const candidates: ExtractableRow[] = [];
  const maxRank = Math.max(0, ...groups.map((group) => group.results.length));
  for (let rank = 0; rank < maxRank; rank++) {
    for (const group of groups) {
      if (group.results[rank]) candidates.push(group.results[rank]);
    }
  }
  const urls = uniqueUrls(candidates, settings.limit);
  const extracted = await extractUrls(urls, settings.mode, settings.maxChars, deps);
  const results = groups.map((group) => ({
    ...group,
    results: group.results.map((row) => typeof row.url === 'string'
      && extracted.patches.has(extractionUrlKey(row.url))
      ? { ...row, ...extracted.patches.get(extractionUrlKey(row.url)) }
      : row),
  }));
  const elapsed = Number(result.structuredContent.elapsed_ms ?? 0) + Date.now() - started;
  return withExtraction(result, results, extracted.summary, elapsed);
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
      browserEngine: deps.config.browserEngine,
      effectiveBrowserEngine: deps.nativeBrowser ? 'native' : 'playwright',
      searchApiConfigured: Boolean(deps.config.searchApiKey),
      researchEnabled: deps.config.researchEnabled,
      researchRetrievalMode: deps.config.researchRetrievalMode,
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

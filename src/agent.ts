import type { BrowserContext } from 'playwright';
import type { CallToolResult } from './response.js';
import type { SearchResult } from './types.js';
import { loadConfig, type Config, type SearchProviderMode } from './config.js';
import { redactKey, resolveCredential } from './orcarouter/credentials.js';
import { resolveEndpoints } from './orcarouter/endpoints.js';
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
import { enforceSearchSiteScope } from './searchScope.js';
import { runtimeIdentity } from './runtimeIdentity.js';
import type { ResearchRequirement } from './researchRequirements.js';
import { cleanCapturedText, evidenceBodiesFor, selectEvidence, type EvidenceMode, type EvidenceRange, type EvidenceSpan } from './evidence.js';
import {
  MAX_PARALLEL_RESPONSE_RESULTS, MAX_REMAINING_URLS, SEARCH_RESPONSE_TEXT_BUDGET,
} from './responseLimits.js';
import {
  createCascadeState, executeWithCascade, type CascadeState, type StealthMode,
} from './cascade.js';
import { loadCascadeMode, saveCascadeMode } from './cascadeStore.js';
import { Telemetry, getTelemetry } from './telemetry.js';
import { StrategyHealing, getStrategyHealing } from './strategyHealing.js';
import { STRATEGIES } from './parse.js';
import { VERSION } from './version.js';
import {
  MAX_RESEARCH_CAPTURE_CHARS, SUMMARY_RESPONSE_CHARS, parseSearchExtractLimit,
  type SearchExtractScope,
} from './searchLimits.js';

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
  readSource?: (url: string, maxChars: number, mode?: ExtractMode) => Promise<ExtractResult>;
  getReaderHealth?: () => Record<string, unknown>;
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
  requirements?: ResearchRequirement[];
  request_id?: string;
  query?: string;
  research_goal?: string;
  extract_mode?: SearchExtractionMode;
  extract_limit?: number;
  max_chars?: number;
  response_content?: 'summary' | 'full';
  evidence_mode?: EvidenceMode;
}

export interface ExtractInputOptions {
  url: string;
  max_chars?: number;
  mode?: ExtractMode;
  query?: string;
  body_handle?: string;
  refresh?: boolean;
  exclude_spans?: EvidenceSpan[];
  exclude_ranges?: EvidenceRange[];
  evidence_mode?: EvidenceMode;
}

export function readCachedExtraction(input: ExtractInputOptions, deps: Deps): CallToolResult | undefined {
  if (input.refresh && input.body_handle) return formatToolResponse(null, {
    code: 'INVALID_ARGUMENT', message: 'refresh cannot be combined with body_handle', retryable: false,
  });
  if (input.refresh) return undefined;
  const result = evidenceBodiesFor(deps.config).get(extractionUrlKey(input.url.trim()), input.mode ?? 'full', input.body_handle);
  if (result) return formatToolResponse({ ...result, meta: { ...asObject(result.meta), body_cache: 'hit' }, elapsed_ms: 0 });
  if (input.body_handle) return formatToolResponse(null, {
    code: 'INVALID_ARGUMENT', message: 'body_handle expired, was evicted, or does not match this URL and mode',
    retryable: false, user_action: 'Use the known URL without body_handle to capture a new snapshot; do not repeat the stale handle.',
  });
  return undefined;
}

function retainExtraction(url: string, result: ExtractResult, mode: string, deps: Deps): Record<string, unknown> {
  const captured_at = new Date().toISOString();
  const body_handle = !['blocked', 'consent_required'].includes(String(result.extraction_quality))
    ? evidenceBodiesFor(deps.config).put(extractionUrlKey(url), { ...result, captured_at }, mode)
    : undefined;
  return { ...result, captured_at, ...(body_handle ? {
    body_handle, body_expires_at: evidenceBodiesFor(deps.config).get(extractionUrlKey(url), mode, body_handle)?.body_expires_at,
  } : {}) };
}

export function retainSourceResponse(result: CallToolResult, mode: string, deps: Deps): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  const retain = (value: unknown): Record<string, unknown> => {
    const row = asObject(value);
    if (Array.isArray(row.results)) return { ...row, results: row.results.map(retain) };
    if (typeof row.content !== 'string' || typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url)
      || row.document_id || (row.source_family && row.source_family !== 'live')) return row;
    const content = cleanCapturedText(row.content);
    const cached = evidenceBodiesFor(deps.config).get(extractionUrlKey(row.url), mode,
      typeof row.body_handle === 'string' ? row.body_handle : undefined);
    if (cached && cleanCapturedText(String(cached.content)) === content) return { ...row,
      body_handle: cached.body_handle, body_expires_at: cached.body_expires_at };
    const { body_handle: _handle, body_expires_at: _expires, captured_at: _at, captured_hash: _hash,
      captured_length: _length, evidence_spans: _spans, evidence_ranges: _ranges, ...source } = row;
    return retainExtraction(row.url, { ...source, content } as unknown as ExtractResult, mode, deps);
  };
  return formatToolResponse(retain(result.structuredContent));
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
  return enforceSearchSiteScope(await runSearchTool(input, deps, options));
}

async function runSearchTool(
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
  return enforceSearchSiteScope(await runSearchParallelTool(input, deps, options));
}

async function runSearchParallelTool(
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
        const merged = results.map((row) => {
          const replacement = replacements.get(row.query);
          return replacement && !replacement.error ? replacement : {
            ...row, provider: 'browser' as const,
            ...(replacement?.error ? { degraded_reasons: [...(row.degraded_reasons ?? []), 'fallback_failed'] } : {}),
          };
        });
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
  return await Promise.all(queries.map(async (query) => {
    try {
      return {
        query, results: await searchApi(deps).searchGoogle(query, limit, deps.config.locale),
        provider: 'searchapi' as const,
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      };
    } catch (error) {
      recordToolError(deps, 'search_parallel', error);
      return {
        query, results: [], provider: 'searchapi' as const,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      };
    }
  }));
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
  input: ExtractInputOptions,
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const url = input.url.trim();
  const cached = readCachedExtraction(input, deps);
  if (cached) return cached;
  const mode: ExtractMode = input.mode ?? 'full';
  const defaultMax = mode === 'abstract' ? 1_500 : deps.config.extractMaxChars;
  const responseMaxChars = Math.min(Math.max(input.max_chars ?? defaultMax, 200), 50_000);
  const maxChars = mode === 'full'
    ? deps.config.researchEnabled ? MAX_RESEARCH_CAPTURE_CHARS : 50_000
    : responseMaxChars;

  if (!url) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'url required', retryable: false,
    });
  }

  try {
    const initialMode: StealthMode = deps.cascade.mode;
    const result = deps.readSource
      ? await deps.readSource(url, maxChars, mode)
      : await (await deps.acquirePool(initialMode)).extractOne(url, maxChars, mode);
    const failed = !!result.error && !result.content;

    if (failed) {
      deps.tel.record('tool.error', {
        tool: 'extract',
        errorCode: 'EXTRACT_FAILED',
        retryable: true,
      }).catch(() => {});
      const failedResponse = formatToolResponse(null, {
        code: 'EXTRACT_FAILED',
        message: typeof result.error === 'string' ? result.error : 'unknown extract failure',
        retryable: true,
        retry_after_ms: 1000,
      });
      return { ...failedResponse, structuredContent: { ...failedResponse.structuredContent,
        url, extraction_quality: result.extraction_quality, quality_reason: result.quality_reason,
      } };
    }

    return formatToolResponse(
      { ...retainExtraction(url, result, mode, deps), elapsed_ms: Date.now() - t0 },
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
  applied: number;
  succeeded: number;
  failed: number;
  skipped: number;
  truncated: boolean;
  total_chars: number;
  remaining_urls: string[];
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
  if (error) return { extract_error: error, extraction_quality: result.structuredContent?.extraction_quality,
    quality_reason: result.structuredContent?.quality_reason };
  const data = asObject(result.structuredContent);
  return Object.fromEntries([
    'content', 'excerpt', 'length', 'source_length', 'truncated', 'is_pdf', 'page_count', 'extraction_quality',
    'authors', 'publication', 'published_at', 'year', 'doi', 'description',
    'keywords', 'canonical_url', 'language', 'subject', 'creator', 'producer',
    'created_at', 'modified_at',
    'quality_reason', 'body_handle', 'body_expires_at', 'captured_at',
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

function selectUniqueUrls(rows: ExtractableRow[], limit: number): {
  selected: string[];
  remaining: string[];
} {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.url !== 'string') continue;
    const key = extractionUrlKey(row.url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(row.url);
  }
  return { selected: urls.slice(0, limit), remaining: urls.slice(limit) };
}

async function extractUrls(
  urls: string[],
  requested: number,
  remaining: string[],
  mode: 'abstract' | 'full',
  maxChars: number,
  deps: Deps,
): Promise<{ patches: Map<string, Record<string, unknown>>; summary: ExtractionSummary }> {
  const patches = new Map<string, Record<string, unknown>>();
  if (urls.length) {
    try {
      const pool = deps.readSource ? undefined : await deps.acquirePool(deps.cascade.mode);
      await Promise.all(urls.map(async (url) => {
        try {
          const cached = evidenceBodiesFor(deps.config).get(extractionUrlKey(url), mode);
          const result = cached ?? (deps.readSource
            ? await deps.readSource(url, maxChars, mode) : await pool!.extractOne(url, maxChars, mode));
          patches.set(extractionUrlKey(url), result.error && !result.content
            ? { extract_error: result.error, extraction_quality: result.extraction_quality, quality_reason: result.quality_reason }
            : extractionPatch(formatToolResponse(cached ?? retainExtraction(url, result as ExtractResult, mode, deps))));
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
  }
  const failed = [...patches.values()].filter((patch) => 'extract_error' in patch).length;
  const totalChars = [...patches.values()].reduce((total, patch) => (
    total + (typeof patch.content === 'string' ? patch.content.length : 0)
  ), 0);
  const contentTruncated = [...patches.values()].some((patch) => patch.truncated === true);
  return {
    patches,
    summary: {
      mode,
      requested,
      applied: urls.length,
      succeeded: urls.length - failed,
      failed,
      skipped: remaining.length,
      truncated: remaining.length > 0 || contentTruncated,
      total_chars: totalChars,
      remaining_urls: remaining,
    },
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

function extractionSettings(input: SearchExtractionInput, deps: Deps, scope: SearchExtractScope) {
  const mode = input.extract_mode ?? 'none';
  const limit = parseSearchExtractLimit(input.extract_limit, scope, mode);
  const defaultMax = mode === 'abstract' ? 1_500 : deps.config.extractMaxChars;
  const responseMaxChars = Math.min(Math.max(input.max_chars ?? defaultMax, 200), 50_000);
  const extractMaxChars = mode === 'full'
    ? deps.config.researchEnabled ? MAX_RESEARCH_CAPTURE_CHARS : 50_000
    : responseMaxChars;
  return { mode, limit, extractMaxChars };
}

export async function applySearchExtraction(
  result: CallToolResult,
  input: SearchExtractionInput,
  deps: Deps,
): Promise<CallToolResult> {
  const settings = extractionSettings(input, deps, 'search');
  if (settings.mode === 'none' || result.isError || !result.structuredContent) return result;
  const started = Date.now();
  const rows = Array.isArray(result.structuredContent.results)
    ? result.structuredContent.results.map((row) => asObject(row))
    : [];
  const urls = selectUniqueUrls(rows, settings.limit);
  const extracted = await extractUrls(
    urls.selected,
    settings.limit,
    urls.remaining,
    settings.mode,
    settings.extractMaxChars,
    deps,
  );
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
  const settings = extractionSettings(input, deps, 'parallel');
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
  const urls = selectUniqueUrls(candidates, settings.limit);
  const extracted = await extractUrls(
    urls.selected,
    settings.limit,
    urls.remaining,
    settings.mode,
    settings.extractMaxChars,
    deps,
  );
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

function shapeRowContent(row: Record<string, unknown>, maxChars: number, query = '', excluded: EvidenceSpan[] = [], mode: EvidenceMode = 'balanced'): {
  row: Record<string, unknown>;
  truncated: boolean;
} {
  if (typeof row.content !== 'string') return { row, truncated: false };
  const raw = cleanCapturedText(row.content);
  const selected = query || excluded.length || mode === 'compact'
    ? selectEvidence(raw, query, maxChars, excluded, mode)
    : { ...selectEvidence(raw, '', 0), text: raw.slice(0, maxChars),
      spans: raw ? [{ start: 0, end: Math.min(raw.length, maxChars) }] : [],
      truncated: raw.length > maxChars };
  const { excerpt: _excerpt, evidence_ranges: _ranges, ...metadata } = row;
  return {
    row: { ...metadata, content: selected.text, length: selected.text.length,
      captured_hash: selected.captured_hash, captured_length: selected.captured_length,
      evidence_spans: selected.spans,
      ...(selected.truncated || row.truncated ? { truncated: true } : {}),
      ...(excluded.length && !selected.text ? { no_additional_passages: true } : {}),
    },
    truncated: selected.truncated,
  };
}

function shapeSearchResultRow(
  value: unknown,
  contentMaxChars: number,
  rowTextBudget: number,
  query: string,
  responseContent: 'summary' | 'full',
  evidenceMode: EvidenceMode,
): { row: Record<string, unknown>; truncated: boolean } {
  const row = asObject(value);
  const description = typeof row.description === 'string' ? row.description : '';
  const content = typeof row.content === 'string' ? row.content : '';
  if (responseContent === 'summary') {
    const selected = selectEvidence(content || description, query, Math.min(contentMaxChars, rowTextBudget), [], evidenceMode);
    const { content: _content, excerpt: _excerpt, captured_at: _at, body_expires_at: _expires,
      evidence_spans: _spans, evidence_ranges: _ranges, ...metadata } = row;
    if (metadata.length === selected.captured_length) delete metadata.length;
    if (metadata.source_length === selected.captured_length) delete metadata.source_length;
    return { row: { ...metadata, title: String(row.title ?? '').slice(0, 300), url: String(row.url ?? '').slice(0, 2048),
      description: selected.text, captured_hash: selected.captured_hash,
      captured_length: selected.captured_length, evidence_ranges: selected.spans.map(s => [s.start, s.end]),
      ...(selected.truncated || row.truncated ? { truncated: true } : {}),
    }, truncated: selected.truncated };
  }
  const descriptionLimit = content
    ? Math.min(240, Math.max(80, Math.floor(rowTextBudget / 4)))
    : rowTextBudget;
  const nextDescription = description.slice(0, descriptionLimit);
  const contentLimit = Math.min(contentMaxChars, Math.max(0, rowTextBudget - nextDescription.length));
  const shaped = shapeRowContent(row, contentLimit, query, [], evidenceMode);
  const nextContent = typeof shaped.row.content === 'string' ? shaped.row.content : '';
  const truncated = nextDescription.length < description.length || shaped.truncated;
  return {
    row: {
      ...shaped.row,
      title: typeof row.title === 'string' ? row.title.slice(0, 300) : row.title,
      url: typeof row.url === 'string' ? row.url.slice(0, 2_048) : row.url,
      description: nextDescription,
      ...(content ? { content: nextContent } : {}),
      ...(truncated ? { truncated: true } : {}),
    },
    truncated,
  };
}

function boundedParallelGroups(groups: Array<Record<string, unknown>>): {
  groups: Array<Record<string, unknown>>;
  originalCount: number;
  returnedCount: number;
} {
  const originalCount = groups.reduce(
    (count, group) => count + (Array.isArray(group.results) ? group.results.length : 0),
    0,
  );
  const base = groups.length ? Math.floor(MAX_PARALLEL_RESPONSE_RESULTS / groups.length) : 0;
  let extras = groups.length ? MAX_PARALLEL_RESPONSE_RESULTS % groups.length : 0;
  const bounded = groups.map((group) => {
    const rows = Array.isArray(group.results) ? group.results : [];
    const quota = Math.max(1, base + (extras-- > 0 ? 1 : 0));
    return { ...group, results: rows.slice(0, quota) };
  });
  const returnedCount = bounded.reduce(
    (count, group) => count + (Array.isArray(group.results) ? group.results.length : 0),
    0,
  );
  return { groups: bounded, originalCount, returnedCount };
}

export function shapeExtractionResponse(
  result: CallToolResult,
  input: Pick<SearchExtractionInput, 'max_chars' | 'response_content' | 'query' | 'research_goal' | 'evidence_mode'> & { exclude_spans?: EvidenceSpan[]; exclude_ranges?: EvidenceRange[] },
  defaultResponse: 'summary' | 'full',
): CallToolResult {
  if (result.isError || !result.structuredContent) return result;
  const responseContent = input.response_content ?? defaultResponse;
  const evidenceMode = input.evidence_mode ?? 'balanced';
  const fullMax = Math.min(Math.max(input.max_chars ?? 50_000, 200), 50_000);
  const responseMax = responseContent === 'summary' ? SUMMARY_RESPONSE_CHARS : fullMax;
  let responseTruncated = false;
  const excluded = [...input.exclude_spans ?? [], ...(input.exclude_ranges ?? []).map(([start, end]) => ({ start, end }))];
  const shape = (row: unknown): Record<string, unknown> => {
    const shaped = shapeRowContent(asObject(row), responseMax, input.query, excluded, evidenceMode);
    responseTruncated ||= shaped.truncated;
    return shaped.row;
  };
  const data = result.structuredContent;
  let shapedData: Record<string, unknown>;
  if (Array.isArray(data.results)) {
    const parallel = data.results.some((entry) => Array.isArray(asObject(entry).results));
    const sourceGroups = parallel
      ? boundedParallelGroups(data.results.map(asObject))
      : undefined;
    const resultCount = parallel
      ? sourceGroups!.returnedCount
      : data.results.length;
    const originalCount = parallel
      ? sourceGroups!.originalCount
      : data.results.length;
    const rowTextBudget = Math.max(200, Math.floor(SEARCH_RESPONSE_TEXT_BUDGET / Math.max(resultCount, 1)));
    const seen = new Map<string, string>();
    let duplicateChars = 0;
    const shapeResult = (row: unknown, query: string): Record<string, unknown> => {
      const shaped = shapeSearchResultRow(row, responseMax, rowTextBudget, query, responseContent, evidenceMode);
      responseTruncated ||= shaped.truncated;
      if (responseContent === 'summary') {
        const key = `${shaped.row.url}\0${shaped.row.captured_hash}\0${shaped.row.description}`;
        const reference = seen.get(key), text = String(shaped.row.description ?? '');
        if (reference && Buffer.byteLength(text) > Buffer.byteLength(reference) + 96) {
          duplicateChars += text.length;
          const { evidence_ranges: _ranges, ...metadata } = shaped.row;
          return { ...metadata, description: '', evidence_ref: reference };
        }
        seen.set(key, String(shaped.row.url));
      }
      return shaped.row;
    };
    shapedData = {
      ...data,
      results: parallel
        ? sourceGroups!.groups.map((group) => {
          const value = asObject(group);
          return {
            ...value,
            results: Array.isArray(value.results) ? value.results.map((row) => shapeResult(row,
              [input.research_goal, value.query].filter(Boolean).join('\n'))) : [],
          };
        })
        : data.results.map((row) => shapeResult(row, input.query ?? String(data.query ?? ''))),
      meta: {
        ...asObject(data.meta),
        response_format: responseContent === 'summary' ? 'ranked_summaries' : 'ranked_passages',
        response: {
          format: 'bounded_ranked_results',
          returned_results: resultCount,
          omitted_results: originalCount - resultCount,
          text_budget_chars: SEARCH_RESPONSE_TEXT_BUDGET,
          response_content: responseContent,
          selector: 'query_passages_v1',
          evidence_mode: evidenceMode,
          range_unit: 'utf16',
          ...(duplicateChars ? { omitted_duplicate_chars: duplicateChars } : {}),
        },
      },
    };
  } else {
    shapedData = shape(data);
    if (input.evidence_mode) shapedData.meta = { ...asObject(shapedData.meta), evidence_mode: evidenceMode };
  }
  const meta = asObject(shapedData.meta);
  const extraction = asObject(meta.extraction);
  return formatToolResponse({
    ...shapedData,
    meta: {
      ...meta,
      ...(Object.keys(extraction).length ? {
        extraction: {
          ...extraction,
          ...(Array.isArray(extraction.remaining_urls) ? {
            remaining_url_count: extraction.remaining_urls.length,
            remaining_urls: extraction.remaining_urls.slice(0, MAX_REMAINING_URLS),
          } : {}),
          response_content: responseContent,
          truncated: extraction.truncated === true || responseTruncated,
        },
      } : {}),
    },
  });
}

export function shapeScholarResponse(result: CallToolResult): CallToolResult {
  if (result.isError || !result.structuredContent || !Array.isArray(result.structuredContent.results)) {
    return result;
  }
  const rows = result.structuredContent.results.slice(0, 10).map((value) => {
    const row = asObject(value);
    return {
      ...row,
      title: String(row.title ?? '').slice(0, 300),
      url: typeof row.url === 'string' ? row.url.slice(0, 2_048) : row.url,
      authors: typeof row.authors === 'string' ? row.authors.slice(0, 500) : row.authors,
      publication: typeof row.publication === 'string' ? row.publication.slice(0, 500) : row.publication,
      snippet: String(row.snippet ?? '').slice(0, 700),
      metadata: String(row.metadata ?? '').slice(0, 400),
    };
  });
  const meta = asObject(result.structuredContent.meta);
  return formatToolResponse({
    ...result.structuredContent,
    results: rows,
    meta: {
      ...meta,
      response: {
        format: 'bounded_ranked_results',
        returned_results: rows.length,
        omitted_results: result.structuredContent.results.length - rows.length,
      },
    },
  });
}

export async function healthTool(deps: Deps): Promise<CallToolResult> {
  const cacheStats = {
    search: await deps.cache.size('search'),
    scholar: await deps.cache.size('scholar'),
    extract: await deps.cache.size('extract'),
  };
  return formatToolResponse({
    version: VERSION,
    runtime_identity: runtimeIdentity(),
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
    evidence_cache: evidenceBodiesFor(deps.config).stats(),
    extraction_reader: deps.getReaderHealth?.() ?? {},
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
    orcarouter: await orcaRouterHealth(),
  });
}

/**
 * OrcaRouter status for `health`. Reports which credential entry point is
 * active and where both origins resolve, without ever echoing the key.
 */
async function orcaRouterHealth() {
  const endpoints = resolveEndpoints();
  const credential = await resolveCredential();
  return {
    configured: credential !== null,
    // "api-key" (pasted sk-orca-…) or "pkce" (issued by the connect flow).
    source: credential?.source ?? null,
    scope: credential?.scope ?? null,
    key: credential ? redactKey(credential.key) : null,
    generation: credential?.generation ?? null,
    needsReauth: credential?.needsReauth ?? false,
    authOrigin: endpoints.authBase,
    apiOrigin: endpoints.apiBase,
  };
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

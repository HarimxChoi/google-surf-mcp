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

export interface PoolHandle {
  runMany: (queries: string[], limit: number) => Promise<Array<{ query: string; results: SearchResult[]; error?: string }>>;
  extractOne: (url: string, maxChars: number) => Promise<{ url: string; title?: string; content?: string; excerpt?: string; length?: number; error?: string }>;
  searchOne: (query: string, limit: number) => Promise<{ query: string; results: SearchResult[]; error?: string }>;
}

export interface Deps {
  config: Config;
  cache: UnifiedCache;
  cascade: CascadeState;
  limiter: RateLimiter;
  acquireSeqCtx: (mode: StealthMode) => Promise<BrowserContext>;
  acquirePool: (mode: StealthMode) => Promise<PoolHandle>;
  closeSeq: () => Promise<void>;
  resetPool: () => Promise<void>;
  recoverHuman: () => Promise<void>;
}

export function initDeps(env: NodeJS.ProcessEnv = process.env): Pick<Deps, 'config' | 'cache' | 'cascade' | 'limiter'> {
  const config = loadConfig(env);
  const cache = getCache(config.cacheRoot, config.cacheMaxEntries);
  const cascade = createCascadeState();
  const limiter = new RateLimiter(config.rateLimitPerMin);
  return { config, cache, cascade, limiter };
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
    return formatToolResponse(
      { query, results: cached.results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...cached.meta, cache: 'hit' },
    );
  }

  try {
    await deps.limiter.acquire();
    const params = generateBehaviorParams();
    const results = await executeSeqWithCascade(deps, async (ctx) => {
      const page = (await ctx.pages())[0] ?? (await ctx.newPage());
      const behavior = new HumanlikeBehavior(params, deps.config.humanlikeMode);
      const r = await legacySearch(page, query, limit);
      if (deps.config.humanlikeMode !== 'off') {
        await behavior.simulateBrowsing(page, []).catch(() => {});
      }
      return r;
    });

    const meta = {
      strategy: 'legacy-v0.4',
      stealth_mode: deps.cascade.mode,
    };
    await deps.cache.set('search', cacheKey, { results, meta }, deps.config.cacheTtlSearchMs);

    return formatToolResponse(
      { query, results, elapsed_ms: Date.now() - t0 },
      undefined,
      { ...meta, cache: 'miss' },
    );
  } catch (e) {
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
      return await pool.runMany(queries, limit);
    });

    return formatToolResponse(
      { results, elapsed_ms: Date.now() - t0 },
      undefined,
      { stealth_mode: deps.cascade.mode, cache: 'miss' },
    );
  } catch (e) {
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

export async function extractTool(
  input: { url: string; max_chars?: number },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const url = input.url.trim();
  const maxChars = Math.min(Math.max(input.max_chars ?? 8_000, 200), 50_000);

  if (!url) {
    return formatToolResponse(null, {
      code: 'INTERNAL', message: 'url required', retryable: false,
    });
  }

  try {
    const initialMode: StealthMode = deps.cascade.mode;
    const pool = await deps.acquirePool(initialMode);
    const result = await pool.extractOne(url, maxChars);
    const failed = !!result.error && !result.content;

    if (failed) {
      return formatToolResponse(null, {
        code: 'EXTRACT_FAILED',
        message: result.error || 'unknown extract failure',
        retryable: true,
        retry_after_ms: 1000,
      });
    }

    return formatToolResponse(
      { ...result, elapsed_ms: Date.now() - t0 },
    );
  } catch (e) {
    return handleError(e, deps);
  }
}

export async function searchExtractTool(
  input: { query: string; limit?: number; max_chars?: number },
  deps: Deps,
): Promise<CallToolResult> {
  const t0 = Date.now();
  const query = input.query.trim();
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const maxChars = Math.min(Math.max(input.max_chars ?? 8_000, 200), 20_000);

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
      const sr = await pool.searchOne(query, limit);
      if (!sr.results.length) return { results: [], searchError: sr.error };
      const enriched = await Promise.all(sr.results.map(async (r) => {
        const ex = await pool.extractOne(r.url, maxChars);
        return {
          title: r.title, url: r.url, description: r.description,
          content: ex.content, excerpt: ex.excerpt, length: ex.length, error: ex.error,
        };
      }));
      return { results: enriched, searchError: undefined as string | undefined };
    });

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
    return rateLimitResponse(e) ?? handleError(e, deps);
  }
}

export async function healthTool(deps: Deps): Promise<CallToolResult> {
  const cacheStats = {
    search: await deps.cache.size('search'),
    extract: await deps.cache.size('extract'),
  };
  return formatToolResponse({
    version: '0.4.5',
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

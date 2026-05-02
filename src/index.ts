#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { launch, getPage, PROFILE_MAIN, profileExists } from './browser.js';
import { search, CaptchaError } from './search.js';
import { SearchPool } from './pool.js';
import { withCaptchaFallback } from './captchaRecover.js';
import type { BrowserContext } from 'playwright';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };
const NAME = 'google-surf-mcp';
const VERSION = pkg.version;
const REQUEST_TIMEOUT_MS = 30_000;
const EXTRACT_BATCH_TIMEOUT_MS = 60_000;
const POOL_SIZE = 4;
const DEFAULT_EXTRACT_MAX_CHARS = 8_000;
const SEARCH_EXTRACT_DEFAULT_LIMIT = 5;

function parseIdleMs(): number {
  const raw = process.env.SURF_IDLE_CLOSE_MS;
  if (raw === undefined) return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}
const IDLE_CLOSE_MS = parseIdleMs(); // 0 disables idle auto-close

// sequential ctx lifecycle
let ctxPromise: Promise<BrowserContext> | null = null;
let ctxClosing: Promise<void> | null = null;

function getSequentialCtx(): Promise<BrowserContext> {
  // wait for in-progress close, avoid profile lock race
  if (ctxClosing) return ctxClosing.then(() => getSequentialCtx());
  if (ctxPromise) return ctxPromise;
  const p = (async () => {
    const c = await launch({ profileDir: PROFILE_MAIN });
    const page = await getPage(c);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return c;
  })();
  ctxPromise = p;
  // failed launch must not be cached forever
  p.catch(() => { if (ctxPromise === p) ctxPromise = null; });
  return p;
}

function closeSequential(): Promise<void> {
  if (ctxClosing) return ctxClosing;
  const cp = ctxPromise;
  ctxPromise = null;
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

function ensurePool(): Promise<SearchPool> {
  if (poolClosing) return poolClosing.then(() => ensurePool());
  if (pool) return Promise.resolve(pool);
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    try {
      // pool clones MAIN profile; release sequential lock first
      await closeSequential();
      const p = new SearchPool(POOL_SIZE);
      try {
        await p.warm();
      } catch (e) {
        await p.close().catch(() => {});
        throw e;
      }
      pool = p;
      return p;
    } finally {
      poolPromise = null;
    }
  })();
  return poolPromise;
}

async function resetPool(): Promise<void> {
  if (poolClosing) return poolClosing;
  // wait for warm so close sees real state
  if (poolPromise) {
    try { await poolPromise; } catch { /* warm failed; pool stays null */ }
  }
  const cur = pool;
  pool = null;
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

function clearSeqIdle() { if (seqIdleTimer) { clearTimeout(seqIdleTimer); seqIdleTimer = null; } }
function clearPoolIdle() { if (poolIdleTimer) { clearTimeout(poolIdleTimer); poolIdleTimer = null; } }

async function trackSeq<T>(op: () => Promise<T>): Promise<T> {
  clearSeqIdle();
  seqActive++;
  try { return await op(); }
  finally {
    seqActive--;
    if (seqActive === 0 && IDLE_CLOSE_MS > 0) {
      seqIdleTimer = setTimeout(() => {
        seqIdleTimer = null;
        if (seqActive === 0) closeSequential().catch(() => {});
      }, IDLE_CLOSE_MS);
    }
  }
}

async function trackPool<T>(op: () => Promise<T>): Promise<T> {
  clearPoolIdle();
  poolActive++;
  try { return await op(); }
  finally {
    poolActive--;
    if (poolActive === 0 && IDLE_CLOSE_MS > 0) {
      poolIdleTimer = setTimeout(() => {
        poolIdleTimer = null;
        if (poolActive === 0) resetPool().catch(() => {});
      }, IDLE_CLOSE_MS);
    }
  }
}

async function shutdown() {
  clearSeqIdle();
  clearPoolIdle();
  // drain in-flight ops, avoid killing ctx mid-search
  const drainStart = Date.now();
  while ((seqActive > 0 || poolActive > 0) && Date.now() - drainStart < 10_000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await closeSequential();
  await pool?.close();
  pool = null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const server = new Server(
  { name: NAME, version: VERSION },
  { capabilities: { tools: {} } },
);

server.onerror = e => console.error('[mcp]', e);
process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.stdin.on('end', () => { shutdown().finally(() => process.exit(0)); });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: 'Single Google search. Returns title/url/snippet per result. ~2s/query (first call ~4s, includes setup). On CAPTCHA, a visible Chrome window opens for the human to solve, then the call retries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', minimum: 1, maximum: 20, description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_parallel',
      description: 'Run multiple Google searches in parallel (pool of 4). Returns title/url/snippet per result. First call adds 5–10s setup.',
      inputSchema: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Queries' },
          limit: { type: 'number', minimum: 1, maximum: 20, description: 'Max results per query' },
        },
        required: ['queries'],
      },
    },
    {
      name: 'extract',
      description: 'Fetch a URL and return clean article markdown. Uses Mozilla Readability with a text fallback. Best-effort: failures return { error } instead of throwing. Private/loopback addresses blocked unless SURF_ALLOW_PRIVATE=true.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_chars: { type: 'number', minimum: 200, maximum: 50000, description: 'Truncate content to this many chars (default 8000)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'search_extract',
      description: 'Google search + parallel content extraction. Returns SERP results enriched with article markdown. Slower than search (extra ~2–5s) but gives you actual page content, not just snippets. Per-page failures are isolated (returned as { error } in that result).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', minimum: 1, maximum: 10, description: 'Number of results to extract (default 5)' },
          max_chars: { type: 'number', minimum: 200, maximum: 20000, description: 'Truncate each result content (default 8000)' },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  if (!profileExists()) {
    throw new McpError(
      ErrorCode.InternalError,
      `Profile not initialized. Run: npm run bootstrap`,
    );
  }

  const args = req.params.arguments as Record<string, unknown> | undefined;
  const name = req.params.name;

  if (name === 'search') {
    const query = String(args?.query || '').trim();
    if (!query) throw new McpError(ErrorCode.InvalidParams, 'query required');
    const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 20);

    const t0 = Date.now();
    try {
      const results = await trackSeq(() => withCaptchaFallback(
        async () => {
          const ctx = await getSequentialCtx();
          const page = await getPage(ctx);
          return await withTimeout(search(page, query, limit), REQUEST_TIMEOUT_MS, 'search');
        },
        closeSequential,
      ));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, results, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
      console.error('[google-surf-mcp] search error:', e);
      const msg = e instanceof CaptchaError
        ? `CAPTCHA recovery failed. Solve in opened browser or run: npm run bootstrap`
        : (e as Error).message;
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  }

  if (name === 'search_parallel') {
    const queries = (args?.queries as string[] || []).map(q => String(q).trim()).filter(Boolean);
    if (queries.length === 0) throw new McpError(ErrorCode.InvalidParams, 'queries required');
    const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 20);

    const t0 = Date.now();
    try {
      const results = await trackPool(() => withCaptchaFallback(
        async () => {
          const p = await ensurePool();
          return await withTimeout(p.runMany(queries, limit), REQUEST_TIMEOUT_MS * 2, 'search_parallel');
        },
        resetPool,
      ));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ results, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
      console.error('[google-surf-mcp] search_parallel error:', e);
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  if (name === 'extract') {
    const url = String(args?.url || '').trim();
    if (!url) throw new McpError(ErrorCode.InvalidParams, 'url required');
    const maxChars = Math.min(Math.max(Number(args?.max_chars) || DEFAULT_EXTRACT_MAX_CHARS, 200), 50_000);

    const t0 = Date.now();
    try {
      // extract never throws CaptchaError, no fallback needed
      const result = await trackPool(async () => {
        const p = await ensurePool();
        return await withTimeout(p.extractOne(url, maxChars), REQUEST_TIMEOUT_MS, 'extract');
      });
      const failed = !!result.error && !result.content;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...result, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
        ...(failed ? { isError: true } : {}),
      };
    } catch (e) {
      console.error('[google-surf-mcp] extract error:', e);
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  if (name === 'search_extract') {
    const query = String(args?.query || '').trim();
    if (!query) throw new McpError(ErrorCode.InvalidParams, 'query required');
    const limit = Math.min(Math.max(Number(args?.limit) || SEARCH_EXTRACT_DEFAULT_LIMIT, 1), 10);
    const maxChars = Math.min(Math.max(Number(args?.max_chars) || DEFAULT_EXTRACT_MAX_CHARS, 200), 20_000);

    const t0 = Date.now();
    try {
      const data = await trackPool(() => withCaptchaFallback(
        async () => {
          const p = await ensurePool();
          const sr = await withTimeout(p.searchOne(query, limit), REQUEST_TIMEOUT_MS, 'search_extract:search');
          if (!sr.results.length) {
            return { results: [] as Array<Record<string, unknown>>, searchError: sr.error };
          }
          const enriched = await withTimeout(
            Promise.all(sr.results.map(async r => {
              const ex = await p.extractOne(r.url, maxChars);
              return {
                title: r.title,
                url: r.url,
                description: r.description,
                content: ex.content,
                excerpt: ex.excerpt,
                length: ex.length,
                error: ex.error,
              };
            })),
            EXTRACT_BATCH_TIMEOUT_MS,
            'search_extract:extract',
          );
          return { results: enriched as Array<Record<string, unknown>>, searchError: undefined as string | undefined };
        },
        resetPool,
      ));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            results: data.results,
            ...(data.searchError ? { error: data.searchError } : {}),
            elapsed_ms: Date.now() - t0,
          }, null, 2),
        }],
        ...(data.searchError && data.results.length === 0 ? { isError: true } : {}),
      };
    } catch (e) {
      console.error('[google-surf-mcp] search_extract error:', e);
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${NAME}@${VERSION}] running on stdio`);

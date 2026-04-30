#!/usr/bin/env node
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
import type { BrowserContext } from 'playwright';

const NAME = 'google-surf-mcp';
const VERSION = '0.2.0';
const REQUEST_TIMEOUT_MS = 30_000;
const EXTRACT_BATCH_TIMEOUT_MS = 60_000;
const POOL_SIZE = 4;
const DEFAULT_EXTRACT_MAX_CHARS = 8_000;
const SEARCH_EXTRACT_DEFAULT_LIMIT = 5;

let ctxPromise: Promise<BrowserContext> | null = null;
let pool: SearchPool | null = null;

function getSequentialCtx(): Promise<BrowserContext> {
  return ctxPromise ??= (async () => {
    const c = await launch({ profileDir: PROFILE_MAIN, headless: true });
    const p = await getPage(c);
    await p.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return c;
  })();
}

async function closeSequential(): Promise<void> {
  const cp = ctxPromise;
  ctxPromise = null;
  if (cp) {
    const c = await cp.catch(() => null);
    await c?.close().catch(() => {});
  }
}

async function ensurePool(): Promise<SearchPool> {
  if (pool) return pool;
  // Pool warm() clones main profile dir to workers; main must be free.
  await closeSequential();
  pool = new SearchPool(POOL_SIZE);
  await pool.warm();
  return pool;
}

async function shutdown() {
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
      description: 'Google search. Returns title/url/snippet per result. ~2s/query after the first.',
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
      description: 'Fetch a URL and return clean article markdown. Uses Mozilla Readability with a text fallback. Best-effort: failures return { error } instead of throwing.',
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
      const ctx = await getSequentialCtx();
      const page = await getPage(ctx);
      const results = await withTimeout(search(page, query, limit), REQUEST_TIMEOUT_MS, 'search');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, results, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
      const msg = e instanceof CaptchaError
        ? `CAPTCHA hit. Re-bootstrap: npm run bootstrap`
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
      const p = await ensurePool();
      const results = await withTimeout(p.runMany(queries, limit), REQUEST_TIMEOUT_MS * 2, 'search_parallel');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ results, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  if (name === 'extract') {
    const url = String(args?.url || '').trim();
    if (!url) throw new McpError(ErrorCode.InvalidParams, 'url required');
    const maxChars = Math.min(Math.max(Number(args?.max_chars) || DEFAULT_EXTRACT_MAX_CHARS, 200), 50_000);

    const t0 = Date.now();
    try {
      const p = await ensurePool();
      const result = await withTimeout(p.extractOne(url, maxChars), REQUEST_TIMEOUT_MS, 'extract');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...result, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
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
      const p = await ensurePool();
      const sr = await withTimeout(p.searchOne(query, limit), REQUEST_TIMEOUT_MS, 'search_extract:search');
      if (sr.error || !sr.results.length) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ query, results: [], error: sr.error, elapsed_ms: Date.now() - t0 }, null, 2),
          }],
          isError: !!sr.error,
        };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query, results: enriched, elapsed_ms: Date.now() - t0 }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${NAME}@${VERSION}] running on stdio`);

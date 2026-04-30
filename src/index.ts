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
const VERSION = '0.1.1';
const REQUEST_TIMEOUT_MS = 30_000;
const POOL_SIZE = 4;

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

async function shutdown() {
  const cp = ctxPromise;
  ctxPromise = null;
  if (cp) {
    const c = await cp.catch(() => null);
    await c?.close().catch(() => {});
  }
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
      description: 'Google search via warm Chrome profile. Sequential, ~2s/query after the first.',
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
      description: 'Run multiple Google searches in parallel (pool of 4). First call adds 5–10s setup.',
      inputSchema: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Queries' },
          limit: { type: 'number', minimum: 1, maximum: 20, description: 'Max results per query' },
        },
        required: ['queries'],
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

  if (req.params.name === 'search') {
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

  if (req.params.name === 'search_parallel') {
    const queries = (args?.queries as string[] || []).map(q => String(q).trim()).filter(Boolean);
    if (queries.length === 0) throw new McpError(ErrorCode.InvalidParams, 'queries required');
    const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 20);

    const t0 = Date.now();
    try {
      pool ??= new SearchPool(POOL_SIZE);
      const results = await withTimeout(pool.runMany(queries, limit), REQUEST_TIMEOUT_MS * 2, 'search_parallel');
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

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${NAME}@${VERSION}] running on stdio`);

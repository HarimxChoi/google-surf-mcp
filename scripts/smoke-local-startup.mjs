import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = mkdtempSync(join(tmpdir(), 'surf-lazy-start-'));
const allow = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key.toUpperCase())));
Object.assign(env, { SURF_CLOUD_MODE: 'false', SURF_RESEARCH: 'false', SURF_BROWSER_ENGINE: 'playwright',
  SURF_SEARCH_PROVIDER: 'browser', SURF_SCHOLAR_PROVIDER: 'browser', SURF_LLM_HEAL: 'false',
  SURF_TELEMETRY: 'false', SURF_PROFILE_ROOT: join(root, 'profiles'), SURF_CACHE_ROOT: join(root, 'cache') });
const build = resolve(process.env.SURF_SMOKE_BUILD_ROOT || 'build');
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['--import', pathToFileURL(resolve('test/fixtures/lazy-browser-smoke.mjs')).href, join(build, 'index.js')], env, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
const client = new Client({ name: 'lazy-start-smoke', version: '1' });
try {
  await client.connect(transport);
  await client.listTools();
  const health = await client.callTool({ name: 'health', arguments: {} });
  assert(!health.isError);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert(!stderr.includes('[bootstrap]') && !stderr.includes('SURF_SMOKE_BROWSER_ATTEMPT'), 'Local startup tried to warm a browser');
  assert(!existsSync(join(root, 'profiles', 'main')), 'Local startup created a search profile');
  const search = await client.callTool({ name: 'search', arguments: { query: 'fixture on-demand readiness', limit: 1 } },
    undefined, { timeout: 30000 });
  assert(search.isError, 'The fake browser should reject a live request');
  assert(stderr.includes('[bootstrap]'), 'A live browser request must still prepare its profile on demand');
  console.log('Local startup and on-demand browser smoke passed (browser/network blocked by fixture)');
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  await transport.close();
  assert(realpathSync(root).startsWith(realpathSync(tmpdir()) + sep + 'surf-lazy-start-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

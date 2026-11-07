import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeCollectionSpec, readCollectionLog, runCollection } from '../build/collect.js';

const root = mkdtempSync(join(tmpdir(), 'surf-evidence-e2e-'));
const requests = new Map();
const server = createServer((req, res) => {
  requests.set(req.url, (requests.get(req.url) ?? 0) + 1);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/blocked') return res.end('<title>Just a moment</title><main>Cloudflare checking your browser. Verify you are human.</main>');
  const prefix = '<p>General background and introduction to reference documentation.</p>'.repeat(400);
  res.end(`<html><head><title>Evidence reference</title><meta name="author" content="Fixture Author"></head><body><main><article><h1>Evidence reference</h1>${prefix}<h2>WAL constraints</h2><p>LateEvidenceMarker: WAL permits concurrent readers and one writer.</p><p>NetworkConstraint: all processes must use the same host, not a network filesystem.</p><p>WriterConstraint: only one writer is allowed at a time.</p></article></main></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/article`;
const results = [];
try {
  for (const enabled of [false, true]) {
    const directory = join(root, enabled ? 'on' : 'off');
    mkdirSync(directory);
    const log = createWriteStream(join(directory, 'stderr.log'));
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', './test/fixtures/searchapi-smoke.mjs', 'build/index.js'],
      cwd: process.cwd(), stderr: 'pipe', env: {
        ...process.env, SURF_CLOUD_MODE: 'true', SURF_ALLOW_PRIVATE: 'true',
        SURF_RESEARCH: String(enabled), SURF_RESEARCH_VECTOR_MODEL: 'off', SURF_RESEARCH_REPO_AUTO: 'false',
        SURF_RESEARCH_ROOT: join(directory, 'research'), SURF_PROFILE_ROOT: join(directory, 'profile'),
        SURF_CACHE_ROOT: join(directory, 'cache'), SURF_RESEARCH_BROKER_IDLE_MS: '500',
        SURF_SEARCH_PROVIDER: 'searchapi', SEARCH_API: 'fixture-not-a-key', SURF_SMOKE_SOURCE_URL: url,
        SURF_IDLE_CLOSE_MS: '1000', SURF_LLM_HEAL: 'false',
      },
    });
    const client = new Client({ name: 'evidence-e2e', version: '1.0.0' });
    transport.stderr?.pipe(log);
    const call = async (name, args) => client.callTool({ name, arguments: { ...args, ...(enabled && name !== 'health' ? { project_id: 'evidence-e2e' } : {}) } }, undefined, { timeout: 90000 });
    try {
      await client.connect(transport);
      if (enabled) assert.ok(!(await call('project_memory', { action: 'create', name: 'Evidence E2E' })).isError);
      const listed = await client.listTools();
      const extract = listed.tools.find(x => x.name === 'extract').inputSchema.properties;
      for (const key of ['query', 'body_handle', 'exclude_spans', 'exclude_ranges', 'evidence_mode', 'refresh']) assert.ok(key in extract);
      const metadata = await call('extract', { url, mode: 'metadata' });
      assert.ok(!metadata.isError);
      assert.equal(metadata.structuredContent.authors, 'Fixture Author');
      const coldHealth = await call('health', {});
      assert.equal(coldHealth.structuredContent.extraction_reader.initialized, false);
      const search = await call('search', { query: 'LateEvidenceMarker WAL', limit: 1, extract_mode: 'full', extract_limit: 1, response_content: 'full', max_chars: 500 });
      assert.ok(!search.isError, JSON.stringify(search.structuredContent));
      const row = search.structuredContent.results[0];
      assert.match(row.content, /LateEvidenceMarker/);
      assert.ok(row.captured_length > 20000);
      assert.match(row.body_handle, /^transient:/);
      const count = requests.get('/article');
      const read = await call('extract', { url, body_handle: row.body_handle, query: 'NetworkConstraint same host network filesystem', max_chars: 300, response_content: 'full' });
      assert.ok(!read.isError, JSON.stringify(read.structuredContent));
      assert.match(read.structuredContent.content, /NetworkConstraint/);
      assert.equal(read.structuredContent.captured_hash, row.captured_hash);
      assert.equal(requests.get('/article'), count);
      const compact = await call('extract', { url, body_handle: row.body_handle, query: 'NetworkConstraint', evidence_mode: 'compact', max_chars: 300 });
      assert.ok(!compact.isError);
      assert.match(compact.structuredContent.content, /NetworkConstraint/);
      assert.equal(compact.structuredContent.meta.evidence_mode, 'compact');
      assert.equal(requests.get('/article'), count);
      const other = await call('extract', { url, body_handle: row.body_handle, query: 'WriterConstraint only one writer', max_chars: 300, exclude_ranges: read.structuredContent.evidence_spans.map(s => [s.start, s.end]) });
      assert.ok(!other.isError);
      assert.match(other.structuredContent.content, /WriterConstraint/);
      assert.equal(requests.get('/article'), count);
      const summary = await call('search_parallel', { queries: ['LateEvidenceMarker WAL', 'NetworkConstraint host'], research_goal: 'Explain concurrency and network constraints', limit: 1, extract_mode: 'full', extract_limit: 1, response_content: 'summary' });
      for (const group of summary.structuredContent.results) for (const item of group.results) {
        assert.equal(item.content, undefined);
        assert.ok(item.description.length <= 1500);
        if (!item.evidence_ref) assert.ok(Array.isArray(item.evidence_ranges));
      }
      const spec = normalizeCollectionSpec({
        schema_version: 1, collection_id: 'evidence-followup',
        ...(enabled ? { project_id: 'evidence-e2e' } : {}),
        jobs: [
          { id: 'discover', tool: 'search_parallel', queries: ['LateEvidenceMarker WAL', 'NetworkConstraint host'],
            arguments: { extract_mode: 'full', extract_limit: 1, response_content: 'summary', limit: 1 } },
          { id: 'follow-up', tool: 'extract', url, arguments: { mode: 'full', query: 'NetworkConstraint', max_chars: 300 } },
        ],
      });
      const output = join(directory, 'collection.jsonl');
      const collected = await runCollection(spec, output, async (name, args) => {
        const before = requests.get('/article');
        const response = await call(name, args);
        if (name === 'extract') assert.equal(requests.get('/article'), before);
        return response;
      }, { test: 'evidence-e2e' });
      assert.deepEqual(collected, { completed: 2, skipped: 0, failed: 0 });
      const collection = await readCollectionLog(output);
      assert.match(collection.latest.get('follow-up').result.content, /NetworkConstraint/);
      const resumed = await runCollection(spec, output, async () => { throw new Error('Completed jobs must not run again'); }, {});
      assert.deepEqual(resumed, { completed: 0, skipped: 2, failed: 0 });
      const mismatch = await call('extract', { url: `${url}/other`, body_handle: row.body_handle });
      assert.ok(mismatch.isError);
      assert.equal(requests.get('/article/other'), undefined);
      const refreshed = await call('extract', { url, refresh: true, query: 'WriterConstraint' });
      assert.ok(!refreshed.isError);
      assert.notEqual(refreshed.structuredContent.body_handle, row.body_handle);
      assert.ok(requests.get('/article') > count);
      const blocked = await call('extract', { url: url.replace('/article', '/blocked') });
      assert.ok(blocked.isError);
      assert.equal(blocked.structuredContent.extraction_quality, 'blocked');
      const health = await call('health', {});
      assert.ok(health.structuredContent.evidence_cache.bytes <= health.structuredContent.evidence_cache.max_bytes);
      assert.equal(health.structuredContent.extraction_reader.headless, true);
      if (!enabled) assert.equal(existsSync(join(directory, 'research')), false);
      results.push({ enabled, passed: true, cached_followups: 4, collection_jobs: 2, resumed_without_calls: 2, memory_budget_bytes: health.structuredContent.evidence_cache.max_bytes });
    } finally { await transport.close(); log.end(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify({ result: 'PASS', cases: results, root }));

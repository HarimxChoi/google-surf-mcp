#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchService } from '../src/research/service.js';
import type { ProjectRootInput } from '../src/research/projectInventory.js';

const args = process.argv.slice(2);

function values(flag: string): string[] {
  return args.flatMap((argument, index) => (
    argument === flag && args[index + 1] ? [args[index + 1]] : []
  ));
}

function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseRoot(input: string): ProjectRootInput {
  const split = input.indexOf('=');
  if (split < 1) throw new Error('--root requires label=path');
  return { label: input.slice(0, split), path: resolve(input.slice(split + 1)) };
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

const roots = values('--root').map(parseRoot);
if (!roots.length) throw new Error('at least one --root label=path is required');
const projectId = value('--project') ?? 'e2e-benchmark';
const queries = values('--query');
const vectorModelValue = value('--vector-model');
const vectorModel = vectorModelValue && vectorModelValue !== 'off' ? vectorModelValue : undefined;
const workerRoot = value('--worker-root');
if (!workerRoot) {
  const root = await mkdtemp(join(tmpdir(), 'surf-e2e-'));
  // @surrealdb/node 3.0.3 releases its RocksDB lock only when the process exits.
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    ...args,
    '--worker-root',
    root,
  ], { cwd: process.cwd(), stdio: 'inherit' });
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  process.exit(exitCode);
}

const root = resolve(workerRoot);
const service = new ResearchService({ enabled: true, root, vectorModel });
const rssStart = process.memoryUsage().rss;
let peakRss = rssStart;
let queryPeakRss = 0;
let querySampling = false;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rss);
  if (querySampling) queryPeakRss = Math.max(queryPeakRss, rss);
}, 25);
let closed = false;
try {
  const started = performance.now();
  await service.createProject('E2E benchmark', projectId);
  const indexed = await service.indexProject({ project_id: projectId, roots });
  const sourceReady = performance.now();
  console.error(JSON.stringify({ phase: 'source_ready', elapsed_ms: sourceReady - started }));
  await service.waitForIdle();
  const derivedReady = performance.now();
  console.error(JSON.stringify({ phase: 'derived_ready', elapsed_ms: derivedReady - started }));
  const derived = await service.rebuildDerivedState(projectId);
  let queryBenchmark: Record<string, unknown> | undefined;
  if (queries.length) {
    const queryRssStart = process.memoryUsage().rss;
    queryPeakRss = queryRssStart;
    querySampling = true;
    const sequentialStarted = performance.now();
    const sequential = [];
    for (const query of queries) sequential.push(await service.search(projectId, query, 10));
    const sequentialMs = performance.now() - sequentialStarted;
    const batchStarted = performance.now();
    const batch = await service.searchBatch(projectId, queries[0], queries.slice(1), 10);
    const batchMs = performance.now() - batchStarted;
    querySampling = false;
    const sequentialIds = new Set(sequential.flatMap((rows) => rows.map((row) => row.document_id)));
    const primaryIds = new Set(sequential[0]?.map((row) => row.document_id) ?? []);
    const batchIds = batch.results.map((row) => row.document_id);
    queryBenchmark = {
      queries: queries.length,
      sequential_ms: sequentialMs,
      batch_ms: batchMs,
      speedup: sequentialMs / batchMs,
      batch_timings: batch.timings,
      sequential_result_digest: createHash('sha256').update(JSON.stringify(
        sequential.map((rows) => rows.map((row) => row.document_id)),
      )).digest('hex'),
      batch_result_digest: createHash('sha256').update(JSON.stringify(
        batch.results.map((row) => row.document_id),
      )).digest('hex'),
      batch_results: batch.results.length,
      sequential_unique_results: sequentialIds.size,
      batch_union_overlap: batchIds.filter((id) => sequentialIds.has(id)).length,
      batch_primary_overlap: batchIds.filter((id) => primaryIds.has(id)).length,
      peak_rss_increase_mib: (queryPeakRss - queryRssStart) / 1024 / 1024,
    };
  }
  const status = await service.getProject(projectId);
  clearInterval(sampler);
  const report = {
    schema: 'google-surf-research-e2e-benchmark-v1',
    generated_at: new Date().toISOString(),
    roots,
    source_ready_ms: sourceReady - started,
    derived_ready_ms: derivedReady - sourceReady,
    elapsed_ms: derivedReady - started,
    peak_rss_increase_mib: (peakRss - rssStart) / 1024 / 1024,
    disk_mib: await directoryBytes(root) / 1024 / 1024,
    index: indexed,
    derived,
    ...(queryBenchmark ? { query_benchmark: queryBenchmark } : {}),
    status,
  };
  const output = value('--output');
  if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ phase: 'closing' }));
  await service.close();
  closed = true;
  console.error(JSON.stringify({ phase: 'closed' }));
} finally {
  clearInterval(sampler);
  if (!closed) await service.close().catch(() => undefined);
}
process.exit(0);

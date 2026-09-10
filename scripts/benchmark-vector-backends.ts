#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createNodeEngines } from '@surrealdb/node';
import { RecordId, Surreal, Table, createRemoteEngines } from 'surrealdb';
import { cosineSimilarity, RESEARCH_VECTOR_DIMENSIONS } from '../src/research/dense.js';

type Backend = 'hnsw' | 'compact' | 'exhaustive';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);

function argument(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

const CHUNKS_PER_SOURCE = 4;
const HNSW_SEARCH_EF = 400;

function vector(index: number): number[] {
  const source = Math.floor(index / CHUNKS_PER_SOURCE);
  const chunk = index % CHUNKS_PER_SOURCE;
  const values = Array.from({ length: RESEARCH_VECTOR_DIMENSIONS }, (_, column) => (
    Math.sin((source + 1) * (column + 3) * 0.017)
      + Math.cos((source + 7) * (column + 1) * 0.011)
      + chunk * 0.002 * Math.sin((column + 1) * 0.13)
  ));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

function percentile(values: number[], fraction: number): number {
  return [...values].sort((left, right) => left - right)[Math.floor((values.length - 1) * fraction)] ?? 0;
}

async function child(backend: Backend, rowCount: number): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), `surf-vector-${backend}-`));
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  try {
    await db.connect(`rocksdb:${root.replace(/\\/g, '/')}`, { namespace: 'benchmark', database: backend });
    await db.query('DEFINE TABLE vector_row SCHEMALESS;').collect();
    if (backend !== 'exhaustive') {
      await db.query(`DEFINE INDEX vector_hnsw ON TABLE vector_row FIELDS embedding
        HNSW DIMENSION ${RESEARCH_VECTOR_DIMENSIONS} TYPE F32 DIST COSINE;`).collect();
    }
    const selected = backend === 'compact'
      ? Array.from({ length: rowCount }, (_, index) => index).filter((index) => index % 4 === 0)
      : Array.from({ length: rowCount }, (_, index) => index);
    const insertedAt = performance.now();
    for (let offset = 0; offset < selected.length; offset += 100) {
      await db.insert(new Table('vector_row'), selected.slice(offset, offset + 100).map((index) => ({
        id: new RecordId('vector_row', `v${index}`),
        item_id: `v${index}`,
        source_id: `s${Math.floor(index / CHUNKS_PER_SOURCE)}`,
        embedding: vector(index),
      })));
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    const insertMs = performance.now() - insertedAt;
    const queryCount = Math.min(20, Math.ceil(rowCount / CHUNKS_PER_SOURCE));
    const queryIndexes = Array.from({ length: queryCount },
      (_, index) => Math.min(
        rowCount - 1,
        Math.floor(index * rowCount / queryCount) + CHUNKS_PER_SOURCE - 1,
      ));
    const latencies: number[] = [];
    let recalled = 0;
    for (const queryIndex of queryIndexes) {
      const query = vector(queryIndex);
      const started = performance.now();
      let ids: string[];
      if (backend === 'exhaustive') {
        const [rows] = await db.query<[Array<{ item_id: string; source_id: string; embedding: number[] }>]>(
          'SELECT item_id, source_id, embedding FROM vector_row',
        ).collect();
        ids = rows.map((row) => ({ id: row.item_id, score: cosineSimilarity(row.embedding, query) }))
          .sort((left, right) => right.score - left.score).slice(0, 10).map((row) => row.id);
      } else {
        const [rows] = await db.query<[Array<{ item_id: string }>]>(
          `SELECT item_id FROM vector_row
           WHERE embedding <|10,${HNSW_SEARCH_EF}|> $embedding LIMIT 10`,
          { embedding: query },
        ).collect();
        ids = rows.map((row) => row.item_id);
      }
      latencies.push(performance.now() - started);
      const expectedSource = Math.floor(queryIndex / CHUNKS_PER_SOURCE);
      if (ids.some((id) => Math.floor(Number(id.slice(1)) / CHUNKS_PER_SOURCE) === expectedSource)) recalled++;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    return {
      backend,
      source_rows: rowCount,
      indexed_rows: selected.length,
      insert_ms: insertMs,
      query_p50_ms: percentile(latencies, 0.5),
      query_p95_ms: percentile(latencies, 0.95),
      source_recall_at_10: recalled / queryIndexes.length,
      baseline_rss_mib: baseline / 1024 / 1024,
      peak_rss_mib: peak / 1024 / 1024,
      rss_delta_mib: (peak - baseline) / 1024 / 1024,
    };
  } finally {
    await db.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (args.includes('--child')) {
  const backend = argument('--backend', 'hnsw') as Backend;
  const rows = Number(argument('--rows', '5000'));
  const result = `${JSON.stringify(await child(backend, rows))}\n`;
  await new Promise<void>((resolveWrite) => process.stdout.write(result, () => resolveWrite()));
  process.exit(0);
} else {
  const rows = Number(argument('--rows', '5000'));
  const timeoutMs = Number(argument('--timeout-ms', '120000'));
  if (!Number.isInteger(rows) || rows < 100) throw new Error('--rows must be an integer >= 100');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout-ms must be an integer >= 1000');
  const runs = [];
  for (const backend of ['hnsw', 'compact', 'exhaustive'] as const) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        process.argv[1], '--child', '--backend', backend, '--rows', String(rows),
      ], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
      });
      runs.push(JSON.parse(stdout.trim()));
    } catch (error) {
      const failure = error as Error & { code?: string; stderr?: string };
      runs.push({
        backend,
        error: failure.message,
        error_code: failure.code,
        stderr: failure.stderr?.slice(-2_000),
        timed_out: failure.code === 'ETIMEDOUT',
      });
    }
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'google-surf-vector-backend-benchmark-v1',
    fixture_hash: createHash('sha256').update(`deterministic-vectors:${rows}:${RESEARCH_VECTOR_DIMENSIONS}`).digest('hex'),
    generated_at: new Date().toISOString(),
    disk_ann_available: false,
    runs,
  }, null, 2)}\n`);
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeEngines } from '@surrealdb/node';
import { RecordId, Surreal, Table, createRemoteEngines } from 'surrealdb';

type Mode = 'active' | 'post_load';

interface RunResult {
  mode: Mode;
  rows: number;
  insert_ms: number;
  index_ms: number;
  ready_ms: number;
  peak_rss_mib: number;
  result_digest: string;
}

const args = process.argv.slice(2);

function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function corpus(rows: number): Array<{ content_hash: string; text: string }> {
  return Array.from({ length: rows }, (_, index) => ({
    content_hash: createHash('sha256').update(`body-${index}`).digest('hex'),
    text: `quantization kernel benchmark document ${index} group${index % 97} marker${index % 251} ${
      index === Math.floor(rows / 2) ? 'heldoutuniqueterm' : 'ordinaryterm'
    } `.repeat(8),
  }));
}

async function run(mode: Mode, rows: number): Promise<RunResult> {
  const root = await mkdtemp(join(tmpdir(), `surf-index-${mode}-`));
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  let peakRss = process.memoryUsage().rss;
  try {
    await db.connect(`rocksdb:${root.replace(/\\/g, '/')}`, {
      namespace: 'benchmark',
      database: mode,
    });
    await db.query(`
      DEFINE TABLE source_body SCHEMALESS;
      DEFINE ANALYZER research_text TOKENIZERS blank,class,camel FILTERS lowercase;
    `).collect();
    if (mode === 'active') {
      await db.query(`
        DEFINE INDEX source_body_text ON TABLE source_body FIELDS text
        FULLTEXT ANALYZER research_text BM25;
      `).collect();
    }
    const bodies = corpus(rows);
    const started = performance.now();
    for (let index = 0; index < bodies.length; index += 250) {
      const batch = bodies.slice(index, index + 250).map((body) => ({
        id: new RecordId('source_body', body.content_hash),
        ...body,
      }));
      await db.insert(new Table('source_body'), batch).ignore();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const inserted = performance.now();
    if (mode === 'post_load') {
      await db.query(`
        DEFINE INDEX source_body_text ON TABLE source_body FIELDS text
        FULLTEXT ANALYZER research_text BM25;
      `).collect();
    }
    const indexed = performance.now();
    const [results] = await db.query<[Array<{ content_hash: string; score: number }>]>(`
      SELECT content_hash, search::score(0) AS score FROM source_body
      WHERE text @0@ 'heldoutuniqueterm' ORDER BY score DESC LIMIT 10;
    `).collect();
    return {
      mode,
      rows,
      insert_ms: inserted - started,
      index_ms: indexed - inserted,
      ready_ms: indexed - started,
      peak_rss_mib: peakRss / 1024 / 1024,
      result_digest: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
    };
  } finally {
    await db.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

const rows = Number(value('--rows') ?? 5_000);
if (!Number.isInteger(rows) || rows < 1) throw new Error('--rows must be a positive integer');
const active = await run('active', rows);
const postLoad = await run('post_load', rows);
const report = {
  schema: 'google-surf-index-benchmark-v1',
  generated_at: new Date().toISOString(),
  runs: [active, postLoad],
  ready_speedup: active.ready_ms / postLoad.ready_ms,
  result_match: active.result_digest === postLoad.result_digest,
};
console.log(JSON.stringify(report, null, 2));

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCodeStructureBatchStream, type CodeSourceInput } from '../src/research/codeStructure.js';
import { searchableByPolicy } from '../src/research/inventory.js';
import { inventoryProject, type ProjectRootInput } from '../src/research/projectInventory.js';

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

async function* batches(
  inputs: CodeSourceInput[],
  maxBytes: number,
): AsyncGenerator<CodeSourceInput[]> {
  let batch: CodeSourceInput[] = [];
  let bytes = 0;
  for (const input of inputs) {
    const size = Buffer.byteLength(input.text, 'utf8');
    if (batch.length && bytes + size > maxBytes) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(input);
    bytes += size;
  }
  if (batch.length) yield batch;
}

const roots = values('--root').map(parseRoot);
if (!roots.length) throw new Error('at least one --root label=path is required');
const batchMib = Number(value('--batch-mib') ?? 8);
if (!Number.isFinite(batchMib) || batchMib <= 0) throw new Error('--batch-mib must be positive');
const started = performance.now();
const inventory = await inventoryProject({ roots });
const inventoried = performance.now();
const inputs = inventory.records.flatMap((record) => (
  record.kind === 'source' && record.text !== undefined
    && searchableByPolicy('structured', record.kind, record.tracked)
    ? [{
      project_id: 'benchmark',
      source_entry_id: record.id,
      path: record.path,
      text: record.text,
      root: record.root,
      tracked: record.tracked,
    }]
    : []
));
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 25);
const parsed = await runCodeStructureBatchStream(batches(inputs, batchMib * 1024 * 1024));
clearInterval(sampler);
const finished = performance.now();
const digest = createHash('sha256').update(JSON.stringify({
  symbols: parsed.symbols.map((row) => row.symbol_id).sort(),
  relations: parsed.relations.map((row) => row.relation_id).sort(),
})).digest('hex');
const report = {
  schema: 'google-surf-code-index-benchmark-v1',
  generated_at: new Date().toISOString(),
  roots,
  inventory_entries: inventory.records.length,
  code_sources: inputs.length,
  batch_mib: batchMib,
  symbols: parsed.symbols.length,
  relations: parsed.relations.length,
  inventory_ms: inventoried - started,
  parse_ms: finished - inventoried,
  elapsed_ms: finished - started,
  peak_rss_mib: peakRss / 1024 / 1024,
  result_digest: digest,
};
const output = value('--output');
if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

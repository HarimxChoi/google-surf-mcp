#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { searchableByPolicy, type StoragePolicy } from '../src/research/inventory.js';
import {
  inventoryProject, type ProjectInventoryRecord as InventoryRecord,
  type ProjectRootInput as RootInput,
} from '../src/research/projectInventory.js';

interface PolicyScore {
  policy: StoragePolicy;
  searchable_files: number;
  unique_searchable_bodies: number;
  searchable_bytes: number;
  duplicate_searchable_bytes: number;
  lineage_pair_coverage: number;
  lineage_pairs: number;
  explicit_reference_recall_at_5: number;
  explicit_reference_conditional_recall_at_5: number;
  explicit_reference_target_coverage: number;
  explicit_reference_queries: number;
  structured_query_recall_at_5: number;
  structured_query_target_coverage: number;
  structured_queries: number;
}

interface ReferenceQuery {
  query: string[];
  target: InventoryRecord;
}

interface SearchIndex {
  records: InventoryRecord[];
  document_frequency: Map<string, number>;
  lengths: Map<string, number>;
}

const args = process.argv.slice(2);
const benchmarkStarted = performance.now();

function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag && args[index + 1] ? [args[index + 1]] : []);
}

function parseRoot(input: string): RootInput {
  const split = input.indexOf('=');
  if (split < 1) throw new Error('--root requires label=path');
  return { label: input.slice(0, split), path: resolve(input.slice(split + 1)) };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

function tokenCounts(record: InventoryRecord): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(`${basename(record.path)} ${record.text ?? ''}`)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function rank(
  query: string[],
  index: SearchIndex,
  tokensById: Map<string, Map<string, number>>,
): InventoryRecord[] {
  const terms = new Set(query);
  return index.records.map((record) => {
    const counts = tokensById.get(record.id) ?? new Map<string, number>();
    const length = index.lengths.get(record.id) ?? 0;
    const score = [...terms].reduce((sum, term) => {
      const frequency = counts.get(term) ?? 0;
      if (!frequency) return sum;
      const df = index.document_frequency.get(term) ?? 0;
      const idf = Math.log(1 + (index.records.length - df + 0.5) / (df + 0.5));
      return sum + idf * frequency / (frequency + 1.2 * (0.25 + 0.75 * length / 500));
    }, 0);
    return { record, score };
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.record.path.localeCompare(b.record.path))
    .map((row) => row.record);
}

function buildSearchIndex(
  records: InventoryRecord[],
  tokensById: Map<string, Map<string, number>>,
): SearchIndex {
  const documentFrequency = new Map<string, number>();
  const lengths = new Map<string, number>();
  for (const record of records) {
    const counts = tokensById.get(record.id) ?? new Map<string, number>();
    lengths.set(record.id, [...counts.values()].reduce((sum, count) => sum + count, 0));
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return { records, document_frequency: documentFrequency, lengths };
}

function uniqueBodies(records: InventoryRecord[]): InventoryRecord[] {
  const unique = new Map<string, InventoryRecord>();
  for (const record of records) {
    const key = record.content_hash ?? record.id;
    const existing = unique.get(key);
    if (!existing || record.path.localeCompare(existing.path) < 0) unique.set(key, record);
  }
  return [...unique.values()];
}

function referenceQueries(records: InventoryRecord[], roots: RootInput[]): ReferenceQuery[] {
  const byBasename = new Map<string, InventoryRecord[]>();
  for (const record of records) {
    if (record.entry_type !== 'file') continue;
    const key = basename(record.path).toLowerCase();
    const matches = byBasename.get(key) ?? [];
    matches.push(record);
    byBasename.set(key, matches);
  }
  const rootPrefixes = roots.map((root) => root.path.replace(/\\/g, '/').toLowerCase());
  const seen = new Set<string>();
  const output: ReferenceQuery[] = [];
  const pattern = /(?:[a-z]:)?[a-z0-9_./\\:-]{3,}\.(?:conf|cpp|cu|h|json|md|mjs|py|sh|toml|ts|yaml|yml)/gi;
  for (const source of records) {
    if (!source.text) continue;
    for (const match of source.text.matchAll(pattern)) {
      const raw = match[0].replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
      const stripped = rootPrefixes.reduce(
        (path, prefix) => path.startsWith(prefix.replace(/^\/+/, ''))
          ? path.slice(prefix.replace(/^\/+/, '').length).replace(/^\/+/, '')
          : path,
        raw,
      ).replace(/^tools\/warp-quant\//, '');
      const candidates = records.filter((record) => {
        const path = record.path.replace(/\\/g, '/').toLowerCase();
        return path === stripped || path.endsWith(`/${stripped}`);
      });
      const basenameMatches = byBasename.get(basename(stripped).toLowerCase()) ?? [];
      const target = candidates.length === 1
        ? candidates[0]
        : basenameMatches.length === 1 ? basenameMatches[0] : undefined;
      if (!target?.text || target.id === source.id) continue;
      const start = Math.max(0, (match.index ?? 0) - 400);
      const end = Math.min(source.text.length, (match.index ?? 0) + match[0].length + 400);
      const context = source.text.slice(start, end).replace(match[0], ' ');
      const terms = [...new Set(tokenize(context))].filter((term) => term.length > 2).slice(0, 24);
      if (terms.length < 3) continue;
      const key = `${source.id}:${target.id}:${terms.slice(0, 12).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ query: terms, target });
      if (output.length >= 500) return output;
    }
  }
  return output;
}

function structuredQueries(records: InventoryRecord[]): ReferenceQuery[] {
  const keys = new Set(['candidate', 'condition', 'decision', 'hypothesis', 'method', 'name', 'objective']);
  const output: ReferenceQuery[] = [];
  function collect(value: unknown, parent: string | undefined, fields: string[]): void {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, parent, fields);
      return;
    }
    if (!value || typeof value !== 'object') {
      if (parent && keys.has(parent) && ['string', 'number', 'boolean'].includes(typeof value)) {
        fields.push(String(value));
      }
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, key.toLowerCase(), fields);
    }
  }
  for (const record of records) {
    if (!record.text || !record.path.toLowerCase().endsWith('.json')) continue;
    if (!['prereg', 'result', 'config'].includes(record.kind)) continue;
    try {
      const fields: string[] = [];
      collect(JSON.parse(record.text), undefined, fields);
      const terms = [...new Set(tokenize(fields.join(' ')))].filter((term) => term.length > 2).slice(0, 24);
      if (terms.length >= 3) output.push({ query: terms, target: record });
    } catch {
      continue;
    }
    if (output.length >= 500) break;
  }
  return output;
}

function evaluateQueries(
  queries: ReferenceQuery[],
  searchIndex: SearchIndex,
  tokensById: Map<string, Map<string, number>>,
): { coverage: number; recall: number; conditionalRecall: number } {
  let covered = 0;
  let hits = 0;
  for (const query of queries) {
    const targetHash = query.target.content_hash;
    const targetPresent = searchIndex.records.some((record) => record.id === query.target.id
      || (!!targetHash && record.content_hash === targetHash));
    if (targetPresent) covered++;
    const hit = rank(query.query, searchIndex, tokensById).slice(0, 5)
      .some((record) => record.id === query.target.id
        || (!!targetHash && record.content_hash === targetHash));
    if (hit) hits++;
  }
  return {
    coverage: queries.length ? covered / queries.length : 0,
    recall: queries.length ? hits / queries.length : 0,
    conditionalRecall: covered ? hits / covered : 0,
  };
}

function policyScore(
  policy: StoragePolicy,
  records: InventoryRecord[],
  tokensById: Map<string, Map<string, number>>,
  references: ReferenceQuery[],
  structured: ReferenceQuery[],
): PolicyScore {
  const searchable = records.filter((record) => record.text !== undefined
    && searchableByPolicy(policy, record.kind, record.tracked));
  const uniqueSearchable = uniqueBodies(searchable);
  const searchIndex = buildSearchIndex(uniqueSearchable, tokensById);
  const hashes = new Map<string, number>();
  for (const record of searchable) {
    if (!record.content_hash) continue;
    hashes.set(record.content_hash, (hashes.get(record.content_hash) ?? 0) + record.size);
  }
  const duplicateBytes = [...hashes.values()].reduce((sum, bytes) => sum + Math.max(0, bytes), 0)
    - [...new Set(searchable.map((record) => record.content_hash).filter(Boolean))]
      .reduce((sum, hash) => sum + (searchable.find((record) => record.content_hash === hash)?.size ?? 0), 0);
  const groups = new Map<string, InventoryRecord[]>();
  for (const record of records) {
    if (!record.experiment_key) continue;
    const group = groups.get(record.experiment_key) ?? [];
    group.push(record);
    groups.set(record.experiment_key, group);
  }
  let lineagePairs = 0;
  let lineageHits = 0;
  for (const group of groups.values()) {
    const prereg = group.find((record) => record.kind === 'prereg');
    const result = group.find((record) => record.kind === 'result');
    if (!prereg || !result) continue;
    lineagePairs++;
    if (records.some((record) => record.id === result.id)) lineageHits++;
  }
  const referenceEvaluation = evaluateQueries(references, searchIndex, tokensById);
  const structuredEvaluation = evaluateQueries(structured, searchIndex, tokensById);
  return {
    policy,
    searchable_files: searchable.length,
    unique_searchable_bodies: uniqueSearchable.length,
    searchable_bytes: searchable.reduce((sum, record) => sum + record.size, 0),
    duplicate_searchable_bytes: duplicateBytes,
    lineage_pair_coverage: lineagePairs ? lineageHits / lineagePairs : 0,
    lineage_pairs: lineagePairs,
    explicit_reference_recall_at_5: referenceEvaluation.recall,
    explicit_reference_conditional_recall_at_5: referenceEvaluation.conditionalRecall,
    explicit_reference_target_coverage: referenceEvaluation.coverage,
    explicit_reference_queries: references.length,
    structured_query_recall_at_5: structuredEvaluation.recall,
    structured_query_target_coverage: structuredEvaluation.coverage,
    structured_queries: structured.length,
  };
}

const roots = values('--root').map(parseRoot);
if (!roots.length) throw new Error('at least one --root label=path is required');
const gitRoot = value('--git-root');
const outputPath = resolve(value('--output') ?? 'project-storage-benchmark.local');
const inventory = await inventoryProject({
  roots,
  ...(gitRoot ? { git_root: resolve(gitRoot) } : {}),
});
const records = inventory.records;
const tokensById = new Map(records.filter((record) => record.text !== undefined)
  .map((record) => [record.id, tokenCounts(record)]));
const references = referenceQueries(records, roots);
const structured = structuredQueries(records);
const kinds = Object.fromEntries([...new Set(records.map((record) => record.kind))].sort()
  .map((kind) => [kind, records.filter((record) => record.kind === kind).length]));
const policies = (['index_all', 'structured', 'terminal_on_demand'] as StoragePolicy[])
  .map((policy) => policyScore(policy, records, tokensById, references, structured));
const baseline = policies.find((policy) => policy.policy === 'index_all')!;
const elapsedMs = Math.round(performance.now() - benchmarkStarted);
const eligible = policies.filter((policy) => policy.lineage_pair_coverage === 1
  && policy.explicit_reference_target_coverage >= baseline.explicit_reference_target_coverage - 0.05
  && policy.structured_query_recall_at_5 >= baseline.structured_query_recall_at_5 - 0.05
  && elapsedMs < 120_000);
const candidatePolicy = eligible.sort((a, b) =>
  (a.searchable_bytes - a.duplicate_searchable_bytes)
  - (b.searchable_bytes - b.duplicate_searchable_bytes))[0]?.policy;
const manifest = {
  schema: 'google-surf-project-storage-benchmark-v1',
  roots,
  git_root: gitRoot ? resolve(gitRoot) : undefined,
  file_count: records.length,
  collection_count: records.filter((record) => record.entry_type === 'collection').length,
  total_bytes: records.reduce((sum, record) => sum + record.size, 0),
  kinds,
  policies,
  candidate_policy: candidatePolicy ?? null,
  inventory_digest: inventory.digest,
  git: inventory.git,
  elapsed_ms: elapsedMs,
  records: records.map(({ text: _text, ...record }) => record),
};
await writeFile(outputPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({
  output: outputPath,
  file_count: manifest.file_count,
  kinds,
  policies,
  candidate_policy: manifest.candidate_policy,
  inventory_digest: manifest.inventory_digest,
  elapsed_ms: manifest.elapsed_ms,
}, null, 2));

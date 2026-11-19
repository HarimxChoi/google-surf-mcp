import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { validateCatalogFields } from './catalogFields.js';

const Catalog = z.object({ kind: z.enum(['project', 'track', 'plan', 'task', 'method', 'experiment',
  'attempt', 'arm', 'measurement', 'byte_ledger', 'artifact', 'document', 'decision', 'session']),
  operation: z.enum(['create', 'patch', 'append_evidence', 'relocate', 'correct']),
  fields: z.record(z.string(), z.unknown()).optional(), missing_fields: z.array(z.string()).optional(),
  asset_id: z.string().min(1).optional(), body: z.string().max(4 * 1024 * 1024).optional(),
  idempotency_key: z.string().min(1).max(500).refine(key => key.trim().length > 0, 'idempotency_key required') }).passthrough();
const Ontology = z.object({ kind: z.enum(['entity_type', 'relation']), name: z.string().trim().min(1).max(200),
  idempotency_key: z.string().min(1).max(500).refine(key => key.trim().length > 0, 'idempotency_key required') }).passthrough();
const Assertion = z.object({ subject: z.string().trim().min(1), predicate: z.string().trim().min(1),
  source: z.enum(['deterministic', 'sidecar', 'explicit']),
  idempotency_key: z.string().min(1).max(500).refine(key => key.trim().length > 0, 'idempotency_key required'),
  object: z.string().optional(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
}).passthrough().refine(row => (row.object !== undefined) !== (row.value !== undefined), 'provide exactly one value or object');
const Entity = z.object({ name: z.string().trim().min(1), kind: z.string().trim().min(1),
  source: z.enum(['explicit', 'deterministic', 'sidecar']) }).passthrough();
const Entry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('catalog'), record: Catalog }),
  z.object({ type: z.literal('ontology'), record: Ontology }),
  z.object({ type: z.literal('assertion'), record: Assertion }),
  z.object({ type: z.literal('entity'), record: Entity }),
]);
export type BulkImportEntry = z.infer<typeof Entry>;

export async function* importLines(path: string): AsyncGenerator<{ line: number; entry?: BulkImportEntry; error?: string }> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of lines) {
      line++;
      if (!text.trim()) continue;
      try {
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('line exceeds 8388608 bytes; use body_path');
        const entry = Entry.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
        if (entry.type === 'catalog') {
          if (entry.record.operation === 'create') validateCatalogFields(entry.record.kind,
            { ...entry.record.fields }, entry.record.missing_fields ?? []);
          else if (!entry.record.asset_id) throw new Error('asset_id required for non-create operations');
        }
        yield { line, entry };
      } catch (error) { yield { line, error: error instanceof Error ? error.message : String(error) }; }
    }
  } finally { lines.close(); stream.destroy(); }
}

export async function inspectImport(path: string) {
  const file = await stat(path);
  if (!file.isFile() || file.size > 1024 ** 3) throw new Error('import_path must be a JSONL file no larger than 1 GiB');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  let valid = 0, invalid = 0;
  const types: Record<string, number> = {};
  const errors: Array<{ line: number; message: string }> = [];
  const keys = new Set<string>();
  for await (const row of importLines(path)) {
    if (row.entry) {
      const key = row.entry.record.idempotency_key;
      const identity = key ? `${row.entry.type}:${key}` : undefined;
      if (identity && keys.has(identity)) {
        invalid++; if (errors.length < 20) errors.push({ line: row.line, message: 'duplicate idempotency_key in import file' });
      } else {
        if (identity) keys.add(identity);
        valid++; types[row.entry.type] = (types[row.entry.type] ?? 0) + 1;
      }
    } else { invalid++; if (errors.length < 20) errors.push({ line: row.line, message: row.error!.slice(0, 500) }); }
  }
  return { sha256: hash.digest('hex'), bytes: file.size, valid, invalid, types, errors,
    validation: 'syntax_and_required_fields' as const, reference_checks: 'performed_during_apply' as const };
}

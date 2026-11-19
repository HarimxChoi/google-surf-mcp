import { createHash } from 'node:crypto';
import type { CatalogAssetKind } from './contracts.js';

const COMMON = ['metric', 'value', 'unit', 'evaluator_contract', 'dataset', 'split', 'source_locator'];
const LLM = ['tokenizer', 'context_length', 'targets', 'carrier_precision'];
const LEDGER = ['byte_components', 'denominator', 'scope'];

export function legacyCatalogFields(kind: CatalogAssetKind, input: Record<string, unknown>): Record<string, unknown> {
  const fields = { ...input };
  const identity = kind === 'measurement'
    ? ['metric', 'unit', 'evaluator_contract', 'dataset', 'split', 'tokenizer', 'context_length', 'targets', 'carrier_precision', 'source_locator']
    : kind === 'byte_ledger' ? LEDGER : undefined;
  if (identity) fields[kind === 'measurement' ? 'comparison_contract_id' : 'ledger_scope_id'] = createHash('sha256')
    .update(stable(Object.fromEntries(identity.map(key => [key, fields[key] ?? null])))).digest('hex');
  return fields;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function validateCatalogFields(kind: CatalogAssetKind, fields: Record<string, unknown>,
  missing: string[], previous?: Record<string, unknown>, relocating = false): Record<string, unknown> {
  const profile = fields.measurement_profile;
  if (kind === 'measurement' && profile !== undefined && !['generic', 'llm'].includes(String(profile))) {
    throw new Error('measurement_profile must be generic or llm');
  }
  const llm = profile === 'llm' || (profile !== 'generic'
    && ['tokenizer', 'context_length', 'carrier_precision'].some(key => fields[key] !== undefined));
  const required = kind === 'measurement' ? [...COMMON, ...(llm ? LLM : [])]
    : kind === 'byte_ledger' ? LEDGER : [];
  const notApplicable = fields.not_applicable_fields ?? [];
  if (!Array.isArray(notApplicable) || notApplicable.some(key => typeof key !== 'string')) {
    throw new Error('not_applicable_fields must be an array of field names');
  }
  if (notApplicable.some(key => missing.includes(key) || fields[key] !== undefined)) {
    throw new Error('not_applicable_fields cannot also have values or appear in missing_fields');
  }
  const absent = required.filter(key => fields[key] === undefined && !missing.includes(key)
    && !notApplicable.includes(key));
  if (absent.length) throw new Error(`${kind} fields missing: ${absent.join(', ')}; provide values or list unknowns in missing_fields; list inapplicable fields in not_applicable_fields`);
  if (kind === 'measurement') {
    const identity = [...COMMON.filter(key => !['value', 'source_locator'].includes(key)),
      'model_id', 'targets', ...(llm ? LLM : [])];
    // Physical locations are observations, not evaluation conditions. Preserve legacy IDs on relocation.
    fields.comparison_contract_id = relocating && previous?.comparison_contract_id
      ? previous.comparison_contract_id
      : createHash('sha256').update(stable(Object.fromEntries([...new Set(identity)]
        .map(key => [key, fields[key] ?? null])))).digest('hex');
  }
  if (kind === 'byte_ledger') fields.ledger_scope_id = createHash('sha256')
    .update(stable(Object.fromEntries(LEDGER.map(key => [key, fields[key] ?? null])))).digest('hex');
  return fields;
}

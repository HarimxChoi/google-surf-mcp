import { createHash } from 'node:crypto';
import type { AssertionAggregateInput } from './contracts.js';

export interface NumericGroup { unit?: string; numeric_count: number; sum: number; min: number; max: number }
const BYTE_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

export function summarizeAssertionAggregate(input: AssertionAggregateInput, matched: number, groups: NumericGroup[]) {
  const numericCount = groups.reduce((n, g) => n + g.numeric_count, 0);
  const units = [...new Set(groups.map(g => g.unit ?? ''))];
  const unit = input.unit ?? (units.length === 1 ? units[0] : undefined);
  let status = input.operation === 'count' ? 'complete' : !matched ? 'empty' : numericCount !== matched ? 'non_numeric_values' : 'complete';
  if (groups.length > 100) status = 'too_many_units';
  const factors = groups.map(g => (g.unit ?? '') === (unit ?? '') ? 1
    : BYTE_UNITS[g.unit ?? ''] && BYTE_UNITS[unit ?? ''] ? BYTE_UNITS[g.unit!] / BYTE_UNITS[unit!] : undefined);
  if (input.operation !== 'count' && factors.some(f => f === undefined)) status = 'unit_mismatch';
  let value: number | null = null;
  if (status === 'complete') {
    if (input.operation === 'count') value = matched;
    else if (input.operation === 'sum' || input.operation === 'mean') {
      value = groups.reduce((n, g, i) => n + g.sum * factors[i]!, 0) / (input.operation === 'mean' ? numericCount : 1);
    } else if (input.operation === 'min') value = Math.min(...groups.map((g, i) => g.min * factors[i]!));
    else value = Math.max(...groups.map((g, i) => g.max * factors[i]!));
    if (!Number.isFinite(value)) { value = null; status = 'non_finite_result'; }
  }
  const result = { operation: input.operation, status, value, ...(input.operation !== 'count' && unit ? { unit } : {}),
    matched_count: matched, ...(input.operation !== 'count' ? { numeric_count: numericCount, excluded_non_numeric: matched - numericCount } : {}) };
  return { ...result, result_hash: createHash('sha256').update(JSON.stringify({ input, groups, result })).digest('hex') };
}

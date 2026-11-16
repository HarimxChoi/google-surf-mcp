import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExcludedEvidenceRangeSchema } from '../src/evidenceSchemas.js';

describe('portable evidence range schema', () => {
  it('preserves integer-pair and ordering validation', () => {
    expect(ExcludedEvidenceRangeSchema.parse([0, 1])).toEqual([0, 1]);
    expect(ExcludedEvidenceRangeSchema.parse([10, 30])).toEqual([10, 30]);
    for (const value of [[], [1], [0, 1, 2], [-1, 2], [0, 0], [2, 1], [0, 0.5], ['0', 1]]) {
      expect(ExcludedEvidenceRangeSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each(['draft-7', 'draft-2020-12'] as const)('emits homogeneous items for %s', target => {
    const schema = z.toJSONSchema(ExcludedEvidenceRangeSchema, { target, io: 'input' });
    expect(schema).toMatchObject({ type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'integer', minimum: 0 } });
    expect(Array.isArray(schema.items)).toBe(false);
    expect(schema).not.toHaveProperty('prefixItems');
  });
});

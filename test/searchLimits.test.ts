import { describe, expect, it } from 'vitest';
import { parseSearchExtractLimit } from '../src/searchLimits.js';

describe('search extraction limit contract', () => {
  it('accepts single and parallel mode boundaries', () => {
    expect(parseSearchExtractLimit(1)).toBe(1);
    expect(parseSearchExtractLimit(10)).toBe(10);
    expect(parseSearchExtractLimit(undefined, 'parallel', 'abstract')).toBe(12);
    expect(parseSearchExtractLimit(20, 'parallel', 'abstract')).toBe(20);
    expect(parseSearchExtractLimit(undefined, 'parallel', 'full')).toBe(10);
    expect(parseSearchExtractLimit(10, 'parallel', 'full')).toBe(10);
  });

  it('rejects values outside the public contract', () => {
    expect(() => parseSearchExtractLimit(0)).toThrow(
      'extract_limit must be an integer between 1 and 10 for abstract search; received 0',
    );
    expect(() => parseSearchExtractLimit(21, 'parallel', 'abstract')).toThrow(
      'extract_limit must be an integer between 1 and 20 for abstract parallel; received 21',
    );
    expect(() => parseSearchExtractLimit(11, 'parallel', 'full')).toThrow(
      'extract_limit must be an integer between 1 and 10 for full parallel; received 11',
    );
  });
});

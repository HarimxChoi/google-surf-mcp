import { describe, expect, it } from 'vitest';
import { isTransactionConflict } from '../src/research/errors.js';

describe('research transaction errors', () => {
  it('recognizes retryable embedded database conflicts', () => {
    expect(isTransactionConflict(new Error(
      'Transaction conflict: Resource busy: . This transaction can be retried',
    ))).toBe(true);
    expect(isTransactionConflict(new Error('project not found'))).toBe(false);
  });
});

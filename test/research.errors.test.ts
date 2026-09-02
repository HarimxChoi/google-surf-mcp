import { describe, expect, it, vi } from 'vitest';
import { isRetryableTransactionError, isTransactionConflict } from '../src/research/errors.js';
import { ResearchStore } from '../src/research/store.js';

describe('research transaction errors', () => {
  it('recognizes retryable embedded database conflicts', () => {
    expect(isTransactionConflict(new Error(
      'Transaction conflict: Resource busy: . This transaction can be retried',
    ))).toBe(true);
    expect(isTransactionConflict(new Error('project not found'))).toBe(false);
  });

  it('retries an expired embedded transaction handle', () => {
    expect(isRetryableTransactionError(new Error('Transaction not found'))).toBe(true);
    expect(isRetryableTransactionError(new Error('project not found'))).toBe(false);
  });

  it('retries the atomic operation without masking rollback failure', async () => {
    const first = {
      commit: vi.fn(async () => {}),
      cancel: vi.fn(async () => { throw new Error('Transaction not found'); }),
    };
    const second = {
      commit: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
    const db = {
      beginTransaction: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    };
    const store = new ResearchStore('unused');
    const transaction = (store as unknown as {
      transaction: <T>(value: unknown, operation: (tx: unknown) => Promise<T>) => Promise<T>;
    }).transaction.bind(store);
    let attempts = 0;

    const result = await transaction(db, async () => {
      attempts++;
      if (attempts === 1) throw new Error('Transaction conflict: transaction can be retried');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.commit).toHaveBeenCalledOnce();
  });
});

export function isTransactionConflict(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('transaction conflict') || message.includes('transaction can be retried');
}

export function isRetryableTransactionError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return isTransactionConflict(error) || message.includes('transaction not found');
}

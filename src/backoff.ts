export interface BackoffOptions {
  initialMs: number;
  maxAttempts: number;
  factor: number;
  isRetryable?: (e: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withBackoff<T>(
  op: () => Promise<T>,
  opts: BackoffOptions,
): Promise<T> {
  const { initialMs, maxAttempts, factor, isRetryable, onRetry } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      if (isRetryable && !isRetryable(e)) throw e;
      if (attempt === maxAttempts - 1) throw e;
      const delayMs = initialMs * Math.pow(factor, attempt);
      onRetry?.(attempt + 1, delayMs, e);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

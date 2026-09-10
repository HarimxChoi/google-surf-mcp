export function queryResponseDeadlineMs(value?: number): number | undefined {
  return value === undefined ? undefined : Math.min(Math.max(value, 1_000), 300_000);
}

export class ResearchQueryInterrupted extends Error {
  readonly code: 'QUERY_TIMEOUT' | 'QUERY_CANCELLED';

  constructor(
    readonly reason = 'caller_cancelled',
    readonly request_id?: string,
    readonly phase?: string,
  ) {
    super(reason === 'response_deadline'
      ? 'research query response deadline exceeded'
      : 'research search cancelled');
    this.name = 'ResearchQueryInterrupted';
    this.code = reason === 'response_deadline' ? 'QUERY_TIMEOUT' : 'QUERY_CANCELLED';
  }
}

export function waitForQuery<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new ResearchQueryInterrupted());
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    // Observe the native work even after cancellation; it may not support abort.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

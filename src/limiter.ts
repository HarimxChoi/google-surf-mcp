// Soft rate limiter: caps Google-facing requests/min so an LLM tool-call burst
// doesn't cluster into a non-human pattern. Overflow rejects (not blocks) so the
// caller can return retry_after_ms within an MCP call timeout.

export class RateLimitedError extends Error {
  constructor(public retryAfterMs: number) {
    super('internal rate limit exceeded');
    this.name = 'RateLimitedError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RateLimiter {
  private hits: number[] = [];
  private waiters: Waiter[] = [];

  constructor(private perMin: number, private maxWaitMs = 5_000) {}

  acquire(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new RateLimitedError(this.retryAfterMs()));
        }, this.maxWaitMs),
      };
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 60_000);
    while (this.waiters.length > 0 && this.hits.length < this.perMin) {
      this.hits.push(now);
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve();
    }
    if (this.waiters.length > 0) {
      const wait = Math.max(0, 60_000 - (now - this.hits[0])) + 5;
      setTimeout(() => this.drain(), wait).unref?.();
    }
  }

  private retryAfterMs(): number {
    const now = Date.now();
    const live = this.hits.filter((t) => now - t < 60_000);
    if (live.length < this.perMin) return 0;
    return Math.max(0, 60_000 - (now - live[0])) + 5;
  }

  get queueSize(): number {
    return this.waiters.length;
  }

  get recentCount(): number {
    const now = Date.now();
    return this.hits.filter((t) => now - t < 60_000).length;
  }
}

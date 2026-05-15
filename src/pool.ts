import type { BrowserContext } from 'playwright';
import { launch, cloneProfile, getPage } from './browser.js';
import { search, CaptchaError } from './search.js';
import { extract, type ExtractResult, type ExtractMode } from './extract.js';
import type { SearchResult, ResultClassification } from './types.js';

interface Worker {
  ctx: BrowserContext;
  busy: boolean;
}

interface Waiter {
  resolve: (w: Worker) => void;
  reject: (e: Error) => void;
}

export interface PoolSearchResult {
  query: string;
  results: SearchResult[];
  dropped?: number;
  dropped_reasons?: ResultClassification[];
  error?: string;
}

export class SearchPool {
  // Bound rebuild attempts and waiter wait time so a fully-dead pool cannot
  // hang acquires indefinitely.
  private static readonly MAX_REBUILD_FAILURES = 5;
  private static readonly WAITER_TIMEOUT_MS = 60_000;

  private workers: Worker[] = [];
  private waiters: Waiter[] = [];
  private size: number;
  private warmed = false;
  private closing = false;
  private rebuildFailureCount = 0;

  constructor(size = 4) {
    this.size = Math.max(1, size);
  }

  async warm(): Promise<void> {
    if (this.warmed) return;
    const dirs = await Promise.all(
      Array.from({ length: this.size }, (_, i) => cloneProfile(i)),
    );
    const settled = await Promise.allSettled(
      dirs.map(async (d) => {
        const ctx = await launch({ profileDir: d });
        const page = await getPage(ctx);
        await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
        return { ctx, busy: false } as Worker;
      }),
    );
    const ok = settled
      .filter((r): r is PromiseFulfilledResult<Worker> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failed = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length > 0) {
      // partial failure: close successful chrome to avoid leaks, then throw
      await Promise.all(ok.map((w) => w.ctx.close().catch(() => {})));
      const reason = failed[0].reason;
      throw new Error(`pool warm failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    this.workers = ok;
    this.warmed = true;
  }

  async runMany(queries: string[], limit = 10, opts?: { locale?: string }): Promise<PoolSearchResult[]> {
    if (!this.warmed) await this.warm();
    return Promise.all(queries.map((q) => this.searchOne(q, limit, opts)));
  }

  async searchOne(query: string, limit: number, opts?: { locale?: string }): Promise<PoolSearchResult> {
    if (!this.warmed) await this.warm();
    const w = await this.acquire();
    try {
      const page = await getPage(w.ctx);
      const outcome = await search(page, query, limit, opts);
      return { query, results: outcome.results, dropped: outcome.dropped, dropped_reasons: outcome.dropped_reasons };
    } catch (e) {
      if (e instanceof CaptchaError) throw e;
      return { query, results: [], error: (e as Error).message };
    } finally {
      this.release(w);
    }
  }

  async extractOne(url: string, maxChars: number, mode?: ExtractMode, navTimeoutMs?: number): Promise<ExtractResult> {
    if (!this.warmed) await this.warm();
    const w = await this.acquire();
    try {
      return await extract(w.ctx, url, { maxChars, mode, navTimeoutMs });
    } finally {
      this.release(w);
    }
  }

  private isContextAlive(ctx: BrowserContext): boolean {
    try {
      ctx.pages();
      return true;
    } catch {
      return false;
    }
  }

  private async rebuildWorker(idx: number): Promise<Worker> {
    const dir = await cloneProfile(idx);
    const ctx = await launch({ profileDir: dir });
    const page = await getPage(ctx);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return { ctx, busy: false };
  }

  private async acquire(): Promise<Worker> {
    if (this.closing) throw new Error('pool closing');
    if (this.rebuildFailureCount >= SearchPool.MAX_REBUILD_FAILURES) {
      throw new Error(
        `pool: rebuild failure limit (${SearchPool.MAX_REBUILD_FAILURES}) reached, all workers may be dead`,
      );
    }
    // try size+1 times to find a live free worker, rebuild dead ones inline
    let attempts = 0;
    while (attempts++ < this.size + 1) {
      const free = this.workers.find((w) => !w.busy);
      if (!free) break;
      free.busy = true;
      if (this.isContextAlive(free.ctx)) return free;
      const idx = this.workers.indexOf(free);
      try {
        const fresh = await this.rebuildWorker(idx);
        fresh.busy = true;
        this.workers[idx] = fresh;
        this.rebuildFailureCount = 0; // success → reset
        return fresh;
      } catch {
        free.busy = false;
        this.rebuildFailureCount++;
        if (this.rebuildFailureCount >= SearchPool.MAX_REBUILD_FAILURES) {
          throw new Error('pool: rebuild failure limit reached during acquire');
        }
        // dead and unrebuildable, try next free worker
      }
    }
    return new Promise<Worker>((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timeoutHandle = null;
        // remove from waiters array
        const idx = this.waiters.findIndex(w => w.reject === wrappedReject);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`pool: waiter timeout after ${SearchPool.WAITER_TIMEOUT_MS}ms`));
      }, SearchPool.WAITER_TIMEOUT_MS);

      const wrappedResolve = (w: Worker) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        resolve(w);
      };
      const wrappedReject = (e: Error) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        reject(e);
      };
      this.waiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  private release(w: Worker): void {
    if (this.closing) {
      w.busy = false;
      return;
    }
    const next = this.waiters.shift();
    if (!next) {
      w.busy = false;
      return;
    }
    if (this.isContextAlive(w.ctx)) {
      next.resolve(w);
      return;
    }
    // dead worker, rebuild before handing off
    const idx = this.workers.indexOf(w);
    this.rebuildWorker(idx)
      .then((fresh) => {
        fresh.busy = true;
        this.workers[idx] = fresh;
        next.resolve(fresh);
      })
      .catch((e) => {
        w.busy = false;
        next.reject(e instanceof Error ? e : new Error(String(e)));
      });
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = this.waiters;
    this.waiters = [];
    pending.forEach(({ reject }) => reject(new Error('pool closed')));
    await Promise.all(this.workers.map((w) => w.ctx.close().catch(() => {})));
    this.workers = [];
    this.warmed = false;
    // closing stays true: closed pool is final
  }
}

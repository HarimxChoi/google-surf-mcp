import type { BrowserContext } from 'playwright';
import { launch, cloneProfile, getPage } from './browser.js';
import { search } from './search.js';
import type { SearchResult } from './types.js';

interface Worker {
  ctx: BrowserContext;
  busy: boolean;
}

export class SearchPool {
  private workers: Worker[] = [];
  private waiters: Array<(w: Worker) => void> = [];
  private size: number;
  private warmed = false;

  constructor(size = 4) {
    this.size = Math.max(1, size);
  }

  async warm(): Promise<void> {
    if (this.warmed) return;
    const dirs = await Promise.all(
      Array.from({ length: this.size }, (_, i) => cloneProfile(i)),
    );
    this.workers = await Promise.all(
      dirs.map(async d => {
        const ctx = await launch({ profileDir: d, headless: true });
        const page = await getPage(ctx);
        await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
        return { ctx, busy: false };
      }),
    );
    this.warmed = true;
  }

  async runMany(queries: string[], limit = 10): Promise<{ query: string; results: SearchResult[]; error?: string }[]> {
    if (!this.warmed) await this.warm();
    return Promise.all(queries.map(q => this.runOne(q, limit)));
  }

  private async runOne(query: string, limit: number) {
    const w = await this.acquire();
    try {
      const page = await getPage(w.ctx);
      const results = await search(page, query, limit);
      return { query, results };
    } catch (e) {
      return { query, results: [], error: (e as Error).message };
    } finally {
      this.release(w);
    }
  }

  private acquire(): Promise<Worker> {
    const free = this.workers.find(w => !w.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise<Worker>(resolve => this.waiters.push(resolve));
  }

  private release(w: Worker) {
    const next = this.waiters.shift();
    if (next) next(w);
    else w.busy = false;
  }

  async close(): Promise<void> {
    this.waiters = [];
    await Promise.all(this.workers.map(w => w.ctx.close().catch(() => {})));
    this.workers = [];
    this.warmed = false;
  }
}

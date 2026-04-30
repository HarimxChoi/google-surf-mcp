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
  private size: number;
  private warmed = false;

  constructor(size = 4) {
    this.size = size;
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

    const tasks = queries.map(q => () => this.runOne(q, limit));
    return Promise.all(tasks.map(t => t()));
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
      w.busy = false;
    }
  }

  private async acquire(): Promise<Worker> {
    while (true) {
      const free = this.workers.find(w => !w.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.ctx.close().catch(() => {})));
    this.workers = [];
    this.warmed = false;
  }
}

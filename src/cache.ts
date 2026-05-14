import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type CacheNamespace = 'search' | 'extract' | 'selector' | 'layoutSig' | 'fingerprint';

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number | null;
  key: string;
}

export class UnifiedCache {
  constructor(private root: string, private maxEntries = 1000) {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
    }
  }

  private nsDir(namespace: CacheNamespace): string {
    const dir = join(this.root, namespace);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private filePath(namespace: CacheNamespace, key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return join(this.nsDir(namespace), `${hash}.json`);
  }

  async get<T>(namespace: CacheNamespace, key: string): Promise<T | null> {
    const path = this.filePath(namespace, key);
    try {
      const raw = await readFile(path, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(raw);
      if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
        await unlink(path).catch(() => {});
        return null;
      }
      // Hash-prefix collision guard.
      if (entry.key !== key) return null;
      return entry.value;
    } catch {
      return null;
    }
  }

  async set<T>(
    namespace: CacheNamespace,
    key: string,
    value: T,
    ttlMs: number | null = 3600_000,
  ): Promise<void> {
    const path = this.filePath(namespace, key);
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const tmpPath = `${path}.tmp.${unique}`;
    const entry: CacheEntry<T> = {
      value,
      storedAt: Date.now(),
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
      key,
    };
    try {
      await writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
      await rename(tmpPath, path);
    } catch (e) {
      // Concurrent writes can race the temp file; only re-throw real disk errors.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await this.evictIfOverCap(namespace);
  }

  // LRU eviction by mtime keeps the on-disk cache bounded.
  private async evictIfOverCap(namespace: CacheNamespace): Promise<void> {
    const dir = this.nsDir(namespace);
    let files: string[];
    try { files = await readdir(dir); } catch { return; }
    if (files.length <= this.maxEntries) return;
    const stats = await Promise.all(files.map(async (f) => {
      const p = join(dir, f);
      try { return { p, mtime: (await stat(p)).mtimeMs }; } catch { return null; }
    }));
    const live = stats.filter((s): s is { p: string; mtime: number } => s !== null);
    live.sort((a, b) => a.mtime - b.mtime);
    const excess = live.length - this.maxEntries;
    await Promise.all(live.slice(0, excess).map((s) => unlink(s.p).catch(() => {})));
  }

  async delete(namespace: CacheNamespace, key: string): Promise<void> {
    const path = this.filePath(namespace, key);
    await unlink(path).catch(() => {});
  }

  async clear(namespace: CacheNamespace): Promise<number> {
    const dir = this.nsDir(namespace);
    let count = 0;
    try {
      const files = await readdir(dir);
      await Promise.all(files.map(async (f) => {
        await unlink(join(dir, f)).catch(() => {});
        count++;
      }));
    } catch { /* dir not exist */ }
    return count;
  }

  async size(namespace: CacheNamespace): Promise<number> {
    try {
      const files = await readdir(this.nsDir(namespace));
      return files.length;
    } catch { return 0; }
  }

  searchKey(query: string, locale: string, limit: number): string {
    return `${query}|${locale}|${limit}`;
  }

  selectorKey(layoutSig: string): string {
    return layoutSig;
  }
}

let _cacheInstance: UnifiedCache | null = null;
export function getCache(cacheRoot: string, maxEntries?: number): UnifiedCache {
  if (!_cacheInstance) {
    _cacheInstance = new UnifiedCache(resolve(cacheRoot), maxEntries);
  }
  return _cacheInstance;
}

export function _resetCache(): void {
  _cacheInstance = null;
}

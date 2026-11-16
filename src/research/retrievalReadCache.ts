import { AsyncLocalStorage } from 'node:async_hooks';

interface ReadScope {
  entries: Map<string, Promise<unknown>>;
  bytes: number;
}

export class RetrievalReadCache {
  private readonly scopes = new AsyncLocalStorage<ReadScope>();

  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxEntries = 512) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.scopes.getStore() ? operation() : this.scopes.run({ entries: new Map(), bytes: 0 }, operation);
  }

  async read<T>(namespace: string, keys: string[], load: (missing: string[]) => Promise<Map<string, T>>,
    weight: (value: T) => number): Promise<Map<string, T>> {
    const unique = [...new Set(keys)];
    if (!unique.length) return new Map();
    const scope = this.scopes.getStore();
    if (!scope) return await load(unique);
    const cacheKey = (key: string) => JSON.stringify([namespace, key]);
    const missing = unique.filter(key => !scope.entries.has(cacheKey(key)));
    const requested = new Map<string, Promise<T | undefined>>();
    if (missing.length) {
      const work = load(missing);
      for (const key of missing) {
        const id = cacheKey(key);
        const keep = scope.entries.size < this.maxEntries;
        const pending = work.then(rows => {
          const value = rows.get(key);
          if (keep) {
            const bytes = value === undefined ? Infinity : weight(value) + id.length * 2;
            if (bytes <= this.maxBytes - scope.bytes) scope.bytes += bytes;
            else scope.entries.delete(id);
          }
          return value;
        }, error => {
          if (keep) scope.entries.delete(id);
          throw error;
        });
        requested.set(key, pending);
        if (keep) scope.entries.set(id, pending);
      }
    }
    const values = await Promise.all(unique.map(async key => {
      const value = await (requested.get(key) ?? scope.entries.get(cacheKey(key))) as T | undefined;
      return value === undefined ? undefined : [key, value] as const;
    }));
    const output = new Map<string, T>();
    for (const row of values) if (row) output.set(row[0], row[1]);
    return output;
  }
}

export function retrievalBodyBytes(text: string, sourceMap?: unknown): number {
  const metadata = sourceMap === undefined ? '' : JSON.stringify(sourceMap);
  return Math.max(text.length * 2, Buffer.byteLength(text))
    + Math.max(metadata.length * 2, Buffer.byteLength(metadata)) + 256;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 8;

export function embeddingBatchSize(value = DEFAULT_EMBEDDING_BATCH_SIZE): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(32, Math.floor(value))) : DEFAULT_EMBEDDING_BATCH_SIZE;
}

const EMBEDDED_STORAGE_DEFAULTS = {
  SURREAL_HNSW_CACHE_SIZE: String(128 * 1024 * 1024),
  SURREAL_ROCKSDB_BLOCK_CACHE_SIZE: String(512 * 1024 * 1024),
  SURREAL_ROCKSDB_WRITE_BUFFER_SIZE: String(32 * 1024 * 1024),
  SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER: '2',
  SURREAL_ROCKSDB_THREAD_COUNT: '2',
  SURREAL_ROCKSDB_JOBS_COUNT: '2',
} as const;

export function embeddedStorageEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(EMBEDDED_STORAGE_DEFAULTS)
    .map(([key, value]) => [key, env[key] ?? value]));
}

export function applyEmbeddedStorageDefaults(env: NodeJS.ProcessEnv = process.env): void {
  Object.assign(env, embeddedStorageEnvironment(env));
}

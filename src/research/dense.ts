import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RESEARCH_VECTOR_MODEL = 'Xenova/multilingual-e5-small';
export const DEFAULT_RESEARCH_VECTOR_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const RESEARCH_VECTOR_DIMENSIONS = 384;

type FeatureExtractor = ((
  texts: string[],
  options: { pooling: 'mean'; normalize: true; truncation: true },
) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };

export interface EmbeddingProvider {
  enabled(): boolean;
  modelId(): string | undefined;
  dimensions(): number;
  embedQuery(text: string): Promise<number[]>;
  embedPassages(texts: string[]): Promise<number[][]>;
  dispose?(): Promise<void>;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export class LocalEmbeddingModel implements EmbeddingProvider {
  private extractor?: Promise<FeatureExtractor>;
  private readonly cache = new Map<string, number[]>();
  private readonly revision?: string;

  constructor(
    private readonly model?: string,
    private readonly extractorFactory?: () => Promise<FeatureExtractor>,
    revision?: string,
  ) {
    this.revision = revision
      ?? (model === DEFAULT_RESEARCH_VECTOR_MODEL ? DEFAULT_RESEARCH_VECTOR_REVISION : undefined);
  }

  enabled(): boolean {
    return Boolean(this.model);
  }

  modelId(): string | undefined {
    return this.model && this.revision ? `${this.model}@${this.revision}` : this.model;
  }

  dimensions(): number {
    return RESEARCH_VECTOR_DIMENSIONS;
  }

  private async load(): Promise<FeatureExtractor> {
    if (!this.model) throw new Error('vector search disabled');
    const runtimeUrl = [
      new URL('../../vendor/transformers.node.min.mjs', import.meta.url),
      new URL('../../../vendor/transformers.node.min.mjs', import.meta.url),
    ].find((candidate) => existsSync(fileURLToPath(candidate)));
    if (!runtimeUrl) throw new Error('vendored Transformers.js runtime missing');
    this.extractor ??= this.extractorFactory?.() ?? import(runtimeUrl.href)
      .then(async ({ pipeline }) => await pipeline(
        'feature-extraction',
        this.model!,
        { dtype: 'q8', ...(this.revision ? { revision: this.revision } : {}) },
      ) as unknown as FeatureExtractor);
    return await this.extractor;
  }

  private key(text: string): string {
    return createHash('sha256').update(`${this.model}\0${this.revision ?? ''}\0${text}`).digest('hex');
  }

  private prefix(kind: 'query' | 'passage', text: string): string {
    return this.model?.toLowerCase().includes('e5') ? `${kind}: ${text}` : text;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const output = new Array<number[]>(texts.length);
    const missing: Array<{ index: number; text: string; key: string }> = [];
    texts.forEach((text, index) => {
      const key = this.key(text);
      const cached = this.cache.get(key);
      if (cached) output[index] = cached;
      else missing.push({ index, text, key });
    });
    if (missing.length) {
      const extractor = await this.load();
      for (let index = 0; index < missing.length; index += 32) {
        const batch = missing.slice(index, index + 32);
        const vectors = (await extractor(
          batch.map((row) => row.text.slice(0, 4_000)),
          { pooling: 'mean', normalize: true, truncation: true },
        )).tolist();
        if (vectors.length !== batch.length
          || vectors.some((vector) => vector.length !== RESEARCH_VECTOR_DIMENSIONS)) {
          throw new Error(`vector model must return ${RESEARCH_VECTOR_DIMENSIONS} dimensions`);
        }
        batch.forEach((row, batchIndex) => {
          output[row.index] = vectors[batchIndex];
          this.cache.set(row.key, vectors[batchIndex]);
        });
      }
      while (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
    }
    return output;
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.embed([this.prefix('query', text)]))[0];
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return await this.embed(texts.map((text) => this.prefix('passage', text)));
  }

  async dispose(): Promise<void> {
    const pending = this.extractor;
    this.extractor = undefined;
    this.cache.clear();
    if (pending) await (await pending).dispose?.();
  }
}

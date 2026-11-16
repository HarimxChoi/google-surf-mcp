import { createHash } from 'node:crypto';
import type { RetrievalIndexItem } from './contracts.js';

export function retrievalGenerationDigest(items: readonly RetrievalIndexItem[]): string {
  const digest = createHash('sha256').update('[');
  for (let offset = 0; offset < items.length; offset += 64) {
    if (offset) digest.update(',');
    const batch = items.slice(offset, offset + 64).map(item => ({
      item_id: item.item_id, content_hash: item.content_hash, exact_terms: item.exact_terms,
      text_hash: createHash('sha256').update(item.text).digest('hex'),
    }));
    digest.update(JSON.stringify(batch).slice(1, -1));
  }
  return digest.update(']').digest('hex');
}

export function compactSourceVectorItems<T extends { item_id: string; source_id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...items].sort((left, right) => left.item_id.localeCompare(right.item_id)).filter(item => {
    if (seen.has(item.source_id)) return false;
    seen.add(item.source_id); return true;
  });
}

export function prunedVectorIds(existing: readonly string[], items: readonly { item_id: string }[]): string[] {
  const active = new Set(items.map(item => item.item_id));
  return existing.filter(id => !active.has(id));
}

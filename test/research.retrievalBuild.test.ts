import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RetrievalIndexItem } from '../src/research/contracts.js';
import { compactSourceVectorItems, prunedVectorIds, retrievalGenerationDigest } from '../src/research/retrievalBuild.js';

const item = (id: string, source: string, text = ''): RetrievalIndexItem => ({ item_id: id, source_id: source,
  project_id: 'project-a', source_family: 'document', title: source, url: 'surf://project-a/' + source,
  content_hash: createHash('sha256').update(text).digest('hex'), text, exact_terms: [source, '조건\n"value"'] });
const oldDigest = (items: RetrievalIndexItem[]): string => createHash('sha256').update(JSON.stringify(items.map(row => ({
  item_id: row.item_id, content_hash: row.content_hash, exact_terms: row.exact_terms,
  text_hash: createHash('sha256').update(row.text).digest('hex'),
})))).digest('hex');

describe('bounded retrieval generation preparation', () => {
  it('preserves the generation digest including empty and Unicode inputs', () => {
    for (const rows of [[], [item('a', 's')], [item('한글-1', 's', '\u{1f642}\n\0"'), item('b', 't', '\ud800')]]) {
      expect(retrievalGenerationDigest(rows)).toBe(oldDigest(rows));
    }
  });
  it.each([0, 1, 63, 64, 65, 127, 128, 129, 1024])('keeps byte-identical digests across the %i-item batch boundary', count => {
    const rows = Array.from({ length: count }, (_, index) => item(String(index), `source-${index % 8}`, `조건\u{1f642}\n${index}`));
    expect(retrievalGenerationDigest(rows)).toBe(oldDigest(rows));
  });
  it('retains order sensitivity and exact-term changes without serializing the whole array', () => {
    const rows = [item('a', 's', 'same'), item('b', 't', 'same')];
    expect(retrievalGenerationDigest(rows)).not.toBe(retrievalGenerationDigest([...rows].reverse()));
    const changed = rows.map(row => ({ ...row, exact_terms: [...row.exact_terms, 'new'] }));
    expect(retrievalGenerationDigest(changed)).toBe(oldDigest(changed));
    expect(retrievalGenerationDigest(changed)).not.toBe(retrievalGenerationDigest(rows));
  });
  it('selects exactly the same source representative and preserves stable ties', () => {
    const rows = [item('z', 's1'), item('한글', 's2'), item('a', 's1'), item('a', 's3'), item('b', 's2')];
    const originalOrder = [...rows];
    const old = [...rows].sort((a, b) => a.item_id.localeCompare(b.item_id))
      .filter((row, index, all) => all.findIndex(other => other.source_id === row.source_id) === index);
    expect(compactSourceVectorItems(rows)).toEqual(old);
    expect(rows).toEqual(originalOrder);
    expect(compactSourceVectorItems([])).toEqual([]);
  });
  it('keeps the previous pruning order and duplicates without scanning active items for each id', () => {
    const existing = ['old', 'b', 'old', 'a', 'other'], active = [item('a', 's1'), item('b', 's2')];
    expect(prunedVectorIds(existing, active)).toEqual(existing.filter(id => !active.some(row => row.item_id === id)));
    expect(prunedVectorIds([], active)).toEqual([]);
    expect(prunedVectorIds(existing, [])).toEqual(existing);
  });
});

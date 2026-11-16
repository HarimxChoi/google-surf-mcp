import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHUNK_CHARS, documentChunks } from '../src/research/documentChunks.js';

describe('single-pass document chunk offsets', () => {
  it.each([0, 3999, 4000, 4001, 8001])('preserves the existing chunk boundary for %i ASCII characters', length => {
    const text = 'a'.repeat(length), chunks = documentChunks(text);
    expect(chunks.map(row => row.text).join('')).toBe(text);
    expect(chunks).toHaveLength(Math.ceil(length / DOCUMENT_CHUNK_CHARS));
    chunks.forEach((chunk, index) => {
      expect(chunk.start).toBe(index * DOCUMENT_CHUNK_CHARS);
      expect(chunk.byte_start).toBe(chunk.start);
      expect(chunk.byte_end).toBe(chunk.start + chunk.text.length);
    });
  });
  it.each(['a'.repeat(3999) + '\u{1f642}' + '한글'.repeat(6000), '日本語\n'.repeat(2000) + 'café', 'a'.repeat(3999) + '\ud800x\udc00' + 'b'.repeat(4500)])
  ('matches exact UTF-8 source spans without re-encoding the prefix', text => {
    const bytes = Buffer.from(text, 'utf8'), chunks = documentChunks(text);
    expect(chunks.map(row => row.text).join('')).toBe(text);
    chunks.forEach((chunk, index) => {
      expect(chunk.chunk_index).toBe(index);
      expect(chunk.text.length).toBeLessThanOrEqual(DOCUMENT_CHUNK_CHARS);
      expect(chunk.byte_start).toBe(Buffer.byteLength(text.slice(0, chunk.start), 'utf8'));
      expect(chunk.byte_end).toBe(Buffer.byteLength(text.slice(0, chunk.start + chunk.text.length), 'utf8'));
      expect(bytes.subarray(chunk.byte_start, chunk.byte_end)).toEqual(Buffer.from(chunk.text, 'utf8'));
      expect(chunk.content_hash).toBe(createHash('sha256').update(chunk.text).digest('hex'));
      if (index) expect(chunk.byte_start).toBe(chunks[index - 1].byte_end);
    });
  });
});

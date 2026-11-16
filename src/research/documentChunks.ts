import { createHash } from 'node:crypto';

export const DOCUMENT_CHUNK_CHARS = 4_000;

export function documentChunks(text: string): Array<{
  chunk_index: number; start: number; text: string; content_hash: string; byte_start: number; byte_end: number;
}> {
  const chunks = [];
  let byteOffset = 0;
  for (let start = 0, index = 0; start < text.length; index++) {
    let end = Math.min(start + DOCUMENT_CHUNK_CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const chunk = text.slice(start, end), byteEnd = byteOffset + Buffer.byteLength(chunk, 'utf8');
    chunks.push({ chunk_index: index, start, text: chunk,
      content_hash: createHash('sha256').update(chunk).digest('hex'), byte_start: byteOffset, byte_end: byteEnd });
    start = end; byteOffset = byteEnd;
  }
  return chunks;
}

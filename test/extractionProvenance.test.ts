import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractionProvenance, readExtractionProvenance } from '../src/extractionProvenance.js';

describe('binary extraction provenance', () => {
  it('hashes original bytes independently from OCR text', () => {
    const bytes = Buffer.from([0, 255, 13, 10]);
    const provenance = extractionProvenance(bytes, 'image', 'liteparse', 'enabled', 'eng+kor', 'markdown');
    expect(provenance).toEqual({ source_sha256: createHash('sha256').update(bytes).digest('hex'),
      source_format: 'image', parser: 'liteparse', ocr_policy: 'enabled', ocr_language: 'eng+kor', content_format: 'markdown' });
    expect(readExtractionProvenance(provenance)).toEqual(provenance);
  });

  it('keeps disabled OCR distinct and does not retain arbitrary input fields', () => {
    const provenance = extractionProvenance(Buffer.alloc(0), 'pdf', 'pdf-lib', 'off', 'eng+kor');
    expect(provenance.ocr_language).toBeUndefined();
    expect(readExtractionProvenance({ ...provenance, content: 'unbounded body', ocr_language: 'ignored' }))
      .toEqual(provenance);
  });

  it.each(['xberg', 'kreuzberg'] as const)('retains current and historical %s parser identities', parser => {
    const provenance = extractionProvenance(Buffer.from('office'), 'docx', parser);
    expect(readExtractionProvenance(provenance)).toEqual(provenance);
  });

  it.each([undefined, null, {}, { source_sha256: 'bad' },
    { source_sha256: 'a'.repeat(64), source_format: 'pdf', parser: 'shell', ocr_policy: 'off' }])
  ('ignores invalid provenance rather than inventing a source', value => {
    expect(readExtractionProvenance(value)).toBeUndefined();
  });
});

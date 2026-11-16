import * as CFB from 'cfb';
import { describe, expect, it } from 'vitest';
import { inspectDocumentArchive } from '../src/documentArchive.js';
import { documentFormatFromPath, isNativeDocumentCandidate, MAX_DOCUMENT_BYTES } from '../src/documentFormats.js';

function archive(entries: Record<string, string>): Uint8Array {
  const container = CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(entries)) CFB.utils.cfb_add(container, name, Buffer.from(text));
  return CFB.write(container, { type: 'buffer', fileType: 'zip', compression: true });
}

describe('bounded native document archives', () => {
  it.each([['word/document.xml', 'docx'], ['ppt/presentation.xml', 'pptx'], ['Contents/section0.xml', 'hwpx']])
  ('recognizes %s from package entries', async (entry, expected) => {
    expect(await inspectDocumentArchive(archive({ [entry]: '<document/>' }))).toBe(expected);
  });
  it('does not accept arbitrary ZIP files as Office documents', async () => {
    await expect(inspectDocumentArchive(archive({ 'random.txt': 'text' }))).rejects.toThrow('unsupported archive');
  });
  it('rejects malformed and oversized archives before document parsing', async () => {
    await expect(inspectDocumentArchive(Buffer.from('not a ZIP'))).rejects.toThrow();
    await expect(inspectDocumentArchive(Buffer.alloc(MAX_DOCUMENT_BYTES + 1))).rejects.toThrow('25 MiB');
  });
  it('accepts valid empty HWP streams without treating absent CFB content as a Buffer', async () => {
    const container = CFB.utils.cfb_new();
    const header = Buffer.alloc(256); header.write('HWP Document File', 'ascii');
    CFB.utils.cfb_add(container, 'FileHeader', header);
    CFB.utils.cfb_add(container, 'DocInfo', Buffer.alloc(0));
    CFB.utils.cfb_add(container, 'PrvText', Buffer.alloc(0));
    const bytes = CFB.write(container, { type: 'buffer', fileType: 'cfb' });
    expect(await inspectDocumentArchive(bytes)).toBe('hwp');
  });
  it('rejects expanded archives even when the compressed bytes are small', async () => {
    const bytes = archive({ 'word/document.xml': 'x'.repeat(65 * 1024 * 1024) });
    expect(bytes.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    await expect(inspectDocumentArchive(bytes)).rejects.toThrow('64 MiB');
  });
  it('checks actual signatures and URL hints without treating HTML as document bytes', () => {
    expect(documentFormatFromPath('ROOT/REPORT.DOCX')).toBe('docx');
    expect(documentFormatFromPath('model.onnx')).toBeUndefined();
    expect(documentFormatFromPath('scan.tiff')).toBe('image');
    expect(isNativeDocumentCandidate(archive({ 'word/document.xml': '<w/>' }), '', 'https://example.com/download')).toBe(true);
    expect(isNativeDocumentCandidate(Buffer.from('<html/>'), 'text/html', 'https://example.com/article')).toBe(false);
  });
});

import * as CFB from 'cfb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { htmlToHwpx } from 'hwp-convert';
import { parseNativeDocument } from '../src/documentParse.js';
import { createRequire } from 'node:module';

const nativeAvailable = (() => {
  try { createRequire(import.meta.url)('@xberg-io/xberg'); return true; } catch { return false; }
})();

function docx(): Uint8Array {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, '[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  CFB.utils.cfb_add(container, 'word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cedar native context 8192; extended context 32768.</w:t></w:r></w:p></w:body></w:document>'));
  return CFB.write(container, { type: 'buffer', fileType: 'zip', compression: true });
}

afterEach(() => vi.unstubAllEnvs());
describe('native document representations', () => {
  it.skipIf(!nativeAvailable).each(['auto', 'xberg', 'kreuzberg'])(
    'reads native DOCX with Xberg via the %s setting without OCR', async preferred => {
      vi.stubEnv('SURF_EXTRACT_OFFICE_PARSER', preferred);
      const result = await parseNativeDocument(docx(), 'full', 500);
      expect(result.content).toContain('8192');
      expect(result.content).toContain('32768');
      expect(result.extraction_provenance).toMatchObject({ parser: 'xberg', ocr_policy: 'off' });
      expect(result.document_format).toBe('docx');
    },
  );
  it('keeps HWPX table conditions and reports the source-byte identity', async () => {
    const bytes = await htmlToHwpx('<h1>Cedar</h1><table><tr><th>Limit</th><th>Value</th></tr><tr><td>Native</td><td>8192</td></tr><tr><td>Extended</td><td>32768</td></tr></table>');
    const result = await parseNativeDocument(bytes, 'full', 1000);
    expect(result.content).toContain('| Native | 8192 |');
    expect(result.content).toContain('| Extended | 32768 |');
    expect(result.extraction_provenance).toMatchObject({ source_format: 'hwpx', parser: 'hwp-convert', ocr_policy: 'off' });
    expect(result.quality_reason).toContain('may be omitted');
  });
  it('reads DOCX natively with the documented modern Office API', async () => {
    vi.stubEnv('SURF_EXTRACT_OFFICE_PARSER', 'officeparser');
    const result = await parseNativeDocument(docx(), 'full', 500);
    expect(result.content).toContain('8192');
    expect(result.extraction_provenance).toMatchObject({ parser: 'officeparser', source_format: 'docx' });
    expect(result.document_format).toBe('docx');
  });
  it('checks native HWPX text before Markdown escaping can hide secret signatures', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const bytes = await htmlToHwpx(`<p>${token}</p>`);
    const result = await parseNativeDocument(bytes, 'full', 1000);
    expect(result.contains_sensitive_content).toBe(true);
  });
  it('does not invent body text for metadata mode and honors zero output budget', async () => {
    const metadata = await parseNativeDocument(docx(), 'metadata', 100);
    expect(metadata.content).toBeUndefined();
    expect(metadata.extraction_provenance?.parser).toBe('archive');
    vi.stubEnv('SURF_EXTRACT_OFFICE_PARSER', 'officeparser');
    const empty = await parseNativeDocument(docx(), 'full', 0);
    expect(empty.content).toBe('');
    expect(empty.truncated).toBe(true);
    expect(empty.source_length).toBeGreaterThan(0);
  });
});

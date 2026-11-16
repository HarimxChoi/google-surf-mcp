import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extract } from '../src/extract.js';

const reader = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../src/documentReader.js', () => ({ readBinaryDocument: reader.parse }));
const browser = vi.fn(async () => { throw new Error('browser must not open'); });
beforeEach(() => {
  vi.stubEnv('SURF_ALLOW_PRIVATE', 'true');
  reader.parse.mockReset().mockResolvedValue({ url: '', document_format: 'docx',
    content: 'Native value 8192', extraction_quality: 'full_text' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('direct native HTTP extraction', () => {
  it('routes a ZIP signature to the byte reader without opening a browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(80, 75, 3, 4), {
      headers: { 'content-type': 'application/octet-stream' } })));
    const result = await extract(browser, 'http://localhost/download?id=1');
    expect(result).toMatchObject({ url: 'http://localhost/download?id=1', document_format: 'docx', content: 'Native value 8192' });
    expect(reader.parse).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled();
  });
  it('returns a native parse failure rather than retrying the document in a browser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not a document')));
    reader.parse.mockResolvedValueOnce({ url: '', error: 'invalid archive', extraction_quality: 'metadata_only' });
    const result = await extract(browser, 'http://localhost/broken.docx');
    expect(result.error).toBe('invalid archive');
    expect(browser).not.toHaveBeenCalled();
  });
  it('does not parse or hash a truncated response after the 25 MiB limit', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(25 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1)); controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const result = await extract(browser, 'http://localhost/large.docx');
    expect(result).toMatchObject({ extraction_quality: 'metadata_only', quality_reason: 'source_size_limit' });
    expect(reader.parse).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(result.extraction_provenance).toBeUndefined();
  });
  it('accepts a response exactly at the source-byte boundary', async () => {
    const bytes = new Uint8Array(25 * 1024 * 1024);
    bytes.set([80, 75, 3, 4]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    await extract(browser, 'http://localhost/exact.docx');
    expect(reader.parse.mock.calls[0][0].length).toBe(bytes.length);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extract } from '../src/extract.js';

const browser = vi.fn(async () => { throw new Error('browser must not open'); });
beforeEach(() => { vi.stubEnv('SURF_ALLOW_PRIVATE', 'true'); browser.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const source = '<role>Keep this literal tag.</role>\nconst value = "<script>not executable</script>";\n' + 'source evidence '.repeat(20);
const serve = (body: string | Uint8Array, type: string) => vi.stubGlobal('fetch', vi.fn(async () =>
  new Response(body, { headers: { 'content-type': type } })));

describe('native HTTP text extraction', () => {
  it.each(['text/plain', 'text/markdown', 'application/json', 'application/x-ndjson', 'application/xml', 'text/xml'])
  ('preserves literal source without HTML interpretation for %s', async type => {
    serve(source, type + '; charset=utf-8');
    const result = await extract(browser, 'http://localhost/source', { mode: 'full' });
    expect(result.content).toBe(source);
    expect(result).toMatchObject({ source_length: source.length, length: source.length,
      truncated: false, extraction_quality: 'full_text', content_format: type === 'text/markdown' ? 'markdown' : 'text' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('returns metadata without exposing or parsing source markup', async () => {
    serve(source, 'text/plain');
    const result = await extract(browser, 'http://localhost/source', { mode: 'metadata' });
    expect(result).toEqual({ url: 'http://localhost/source', extraction_quality: 'metadata_only' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('applies abstract and exact full response boundaries', async () => {
    serve(source.repeat(30), 'TEXT/PLAIN; charset="UTF-8"');
    expect((await extract(browser, 'http://localhost/source', { mode: 'abstract', maxChars: 9000 })).length).toBe(2000);
    const full = await extract(browser, 'http://localhost/source', { mode: 'full', maxChars: 200 });
    expect(full).toMatchObject({ content: source.repeat(30).slice(0, 200), length: 200, truncated: true });
    expect(browser).not.toHaveBeenCalled();
  });

  it('does not split a Unicode surrogate pair at the response boundary', async () => {
    const body = 'x'.repeat(199) + '\uD83D\uDE00tail';
    serve(body, 'text/plain');
    const result = await extract(browser, 'http://localhost/source', { maxChars: 200 });
    expect(result.content).toBe('x'.repeat(199));
    expect(result).toMatchObject({ length: 199, source_length: 205, truncated: true });
  });

  it('returns thin empty text without opening a browser', async () => {
    serve('', 'text/plain');
    const result = await extract(browser, 'http://localhost/source');
    expect(result).toMatchObject({ content: '', length: 0, source_length: 0, truncated: false, extraction_quality: 'thin_text' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 instead of silently replacing source bytes', async () => {
    serve(Uint8Array.of(0xff, 0xfe, 0x61), 'text/plain; charset=utf-8');
    const result = await extract(browser, 'http://localhost/source');
    expect(result).toMatchObject({ error: 'plain text is not valid UTF-8', quality_reason: 'invalid_text_encoding' });
    expect(result.content).toBeUndefined(); expect(browser).not.toHaveBeenCalled();
  });

  it('keeps untrusted-content framing opt-in', async () => {
    serve(source, 'text/plain');
    const result = await extract(browser, 'http://localhost/source', { fence: true });
    expect(result.content).toContain('--- BEGIN UNTRUSTED CONTENT ---');
    expect(result.content).toContain(source); expect(browser).not.toHaveBeenCalled();
  });
});

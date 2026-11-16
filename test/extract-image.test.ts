import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { extract } from '../src/extract.js';
import { isImageMagic } from '../src/extract-image.js';

const reader = vi.hoisted(() => ({ parse: vi.fn(), close: vi.fn(), configs: [] as unknown[] }));
vi.mock('@llamaindex/liteparse', () => ({ LiteParse: class {
  constructor(config: unknown) { reader.configs.push(config); }
  parse = reader.parse;
  close = reader.close;
} }));

describe('image source extraction without browser navigation', () => {
  let png: Buffer;
  const context = vi.fn(async () => { throw new Error('browser must not open'); });
  beforeEach(async () => {
    png = await sharp({ create: { width: 4, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
    vi.stubEnv('SURF_ALLOW_PRIVATE', 'true');
    vi.stubEnv('SURF_EXTRACT_OCR', 'false');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(png), {
      headers: { 'content-type': 'application/octet-stream' },
    })));
    reader.configs.length = 0;
    reader.parse.mockResolvedValue({ text: 'Native limit 8192 tokens; extension requires 32768 tokens.', totalPages: 1,
      pages: [{ pageNum: 1, text: 'Native limit 8192 tokens; extension requires 32768 tokens.',
        markdown: 'Native limit 8192 tokens; extension requires 32768 tokens.' }] });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('recognizes image bytes independently of a URL suffix', () => {
    expect(isImageMagic(png)).toBe(true);
    expect(isImageMagic(new Uint8Array())).toBe(false);
    expect(isImageMagic(Buffer.from('<html>image/png</html>'))).toBe(false);
    expect(isImageMagic(Buffer.from([255, 216, 255]))).toBe(true);
  });

  it('reports metadata and the disabled OCR path explicitly', async () => {
    const result = await extract(context, 'http://localhost/source?id=1');
    expect(result).toMatchObject({ is_image: true, is_pdf: false, image_width: 4, image_height: 2,
      extraction_quality: 'metadata_only' });
    expect(result.quality_reason).toContain('SURF_EXTRACT_OCR=true');
    expect(result.extraction_provenance).toMatchObject({ source_format: 'image', parser: 'sharp', ocr_policy: 'off' });
    expect(reader.parse).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });

  it.each(['true', 'auto'])('uses configured OCR language with %s and retains bounded content metadata', async (policy) => {
    vi.stubEnv('SURF_EXTRACT_OCR', policy);
    vi.stubEnv('SURF_EXTRACT_OCR_LANGUAGE', 'eng+kor');
    const result = await extract(context, 'http://localhost/source', { maxChars: 24 });
    expect(result).toMatchObject({ extraction_method: 'ocr', content_format: 'markdown',
      extraction_quality: 'full_text', length: 24, truncated: true });
    expect(result.content).toHaveLength(24);
    expect(result.extraction_provenance).toMatchObject({ source_format: 'image', parser: 'liteparse',
      ocr_policy: policy === 'auto' ? 'auto' : 'enabled', ocr_language: 'eng+kor' });
    expect(result.source_length).toBeGreaterThan(24);
    expect(reader.configs[0]).toMatchObject({ ocrLanguage: 'eng+kor', ocrEnabled: true, numWorkers: 2 });
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context).not.toHaveBeenCalled();
  });

  it('does not run OCR for metadata-only reads', async () => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'true');
    const result = await extract(context, 'http://localhost/source', { mode: 'metadata' });
    expect(result).toMatchObject({ is_image: true, extraction_quality: 'metadata_only' });
    expect(result.content).toBeUndefined();
    expect(reader.parse).not.toHaveBeenCalled();
  });

  it('does not label an empty OCR result as readable', async () => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'true');
    reader.parse.mockResolvedValueOnce({ text: '```text\n\n```', totalPages: 1, pages: [{ text: '' }] });
    const result = await extract(context, 'http://localhost/source');
    expect(result).toMatchObject({ extraction_quality: 'metadata_only', quality_reason: 'image_ocr_returned_no_text' });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it('closes the OCR parser after failure without falling through to a browser', async () => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'true');
    reader.parse.mockRejectedValueOnce(new Error('OCR unavailable'));
    const result = await extract(context, 'http://localhost/source');
    expect(result.error).toContain('OCR unavailable');
    expect(result.quality_reason).toBe('image_parse_failed');
    expect(reader.close).toHaveBeenCalledOnce();
    expect(context).not.toHaveBeenCalled();
  });

  it('rejects unsupported image formats without browser navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })));
    const result = await extract(context, 'http://localhost/source');
    expect(result.quality_reason).toBe('unsupported_image_format');
    expect(context).not.toHaveBeenCalled();
  });

  it('bounds aggregate multipage image pixels before OCR', async () => {
    vi.stubEnv('SURF_EXTRACT_OCR', 'true');
    vi.spyOn(sharp.prototype, 'metadata').mockResolvedValueOnce({ width: 4000, height: 4000, pages: 3 } as sharp.Metadata);
    const result = await extract(context, 'http://localhost/source');
    expect(result.error).toContain('split multipage images');
    expect(reader.parse).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
  });
});

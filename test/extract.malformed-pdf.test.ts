import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extract } from '../src/extract.js';

const URL_OK = 'https://example.com/broken.pdf';

describe('extract: malformed PDF containment', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns ExtractResult.error instead of throwing on parser failure', async () => {
    const garbagePdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('not-actually-a-pdf-just-random-bytes-' + 'x'.repeat(200)),
    ]);
    global.fetch = vi.fn(async () => new Response(garbagePdf, {
      status: 200, headers: { 'content-type': 'application/pdf' },
    })) as typeof global.fetch;

    const fakeCtx = { newPage: async () => { throw new Error('playwright should not be reached'); } } as any;

    let result: any;
    let threw = false;
    try {
      result = await extract(fakeCtx, URL_OK, { mode: 'abstract' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result.error).toMatch(/pdf parse failed/i);
    expect(result.url).toBe(URL_OK);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extract } from '../src/extract.js';

const PUBLIC_URL = 'https://example.com/redirect-me';
const PRIVATE_TARGET = 'http://127.0.0.1/secret';

describe('extract: redirect SSRF guard', () => {
  let originalFetch: typeof global.fetch;
  let calls: string[];

  beforeEach(() => {
    originalFetch = global.fetch;
    calls = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SURF_ALLOW_PRIVATE;
  });

  it('refuses to follow redirects to private addresses', async () => {
    global.fetch = vi.fn(async (url: any, opts: any) => {
      const u = url.toString();
      calls.push(u);
      expect(opts?.redirect).toBe('manual');
      if (u === PUBLIC_URL) {
        return new Response('', { status: 302, headers: { location: PRIVATE_TARGET } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof global.fetch;

    const fakeCtx = { newPage: async () => { throw new Error('playwright should not be reached'); } } as any;
    const result = await extract(fakeCtx, PUBLIC_URL, { mode: 'abstract' });

    expect(calls).toEqual([PUBLIC_URL]);
    expect(result.error).toMatch(/private|internal|blocked/i);
    expect(result.error).not.toMatch(/playwright should not be reached/);
  });

  it('also blocks SSRF redirect on full mode (no Playwright fallback)', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = url.toString();
      calls.push(u);
      if (u === PUBLIC_URL) {
        return new Response('', { status: 302, headers: { location: PRIVATE_TARGET } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof global.fetch;

    const fakeCtx = { newPage: async () => { throw new Error('playwright should not be reached'); } } as any;
    const result = await extract(fakeCtx, PUBLIC_URL, { mode: 'full' });

    expect(calls).toEqual([PUBLIC_URL]);
    expect(result.error).toMatch(/private|internal|blocked/i);
    expect(result.error).not.toMatch(/playwright should not be reached/);
  });

  it('honors SURF_ALLOW_PRIVATE=true (private redirects allowed)', async () => {
    process.env.SURF_ALLOW_PRIVATE = 'true';

    global.fetch = vi.fn(async (url: any, opts: any) => {
      const u = url.toString();
      calls.push(u);
      expect(opts?.redirect).toBe('manual');
      if (u === PUBLIC_URL) {
        return new Response('', { status: 302, headers: { location: PRIVATE_TARGET } });
      }
      return new Response('<html><body>ok</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }) as typeof global.fetch;

    const fakeCtx = { newPage: async () => { throw new Error('playwright should not be reached'); } } as any;
    await extract(fakeCtx, PUBLIC_URL, { mode: 'abstract' });

    expect(calls).toEqual([PUBLIC_URL, PRIVATE_TARGET]);
  });
});

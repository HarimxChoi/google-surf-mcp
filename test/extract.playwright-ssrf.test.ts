import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extract } from '../src/extract.js';

const PUBLIC_URL = 'https://example.com/open-redirect';
const PRIVATE_TARGET = 'http://127.0.0.1/latest/meta-data';

// PUBLIC_URL serves plain HTML (no PDF, no meta abstract) so discoverViaFetch
// returns null and extract() falls through to the Playwright path under test.
function htmlFetch(): typeof global.fetch {
  return vi.fn(async (url: any) => {
    const u = url.toString();
    if (u === PUBLIC_URL) {
      return new Response('<html><body>nothing useful</body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof global.fetch;
}

describe('extract: Playwright-path redirect SSRF guard', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.SURF_ALLOW_PRIVATE;
  });

  it('blocks a server-side redirect that lands on a private address', async () => {
    global.fetch = htmlFetch();
    let evaluated = false;
    const fakeCtx = {
      newPage: async () => ({
        goto: async () => ({ status: () => 200, url: () => PRIVATE_TARGET }),
        url: () => PRIVATE_TARGET,
        waitForTimeout: async () => {},
        addScriptTag: async () => {},
        evaluate: async () => { evaluated = true; return null; },
        close: async () => {},
      }),
    } as any;

    const result = await extract(fakeCtx, PUBLIC_URL, { mode: 'full' });

    expect(result.error).toMatch(/private|internal|blocked/i);
    expect(result.content).toBeUndefined();
    expect(evaluated).toBe(false);
  });

  it('honors SURF_ALLOW_PRIVATE=true (private redirect allowed through)', async () => {
    process.env.SURF_ALLOW_PRIVATE = 'true';
    global.fetch = htmlFetch();
    const fakeCtx = {
      newPage: async () => ({
        goto: async () => ({ status: () => 200, url: () => PRIVATE_TARGET }),
        url: () => PRIVATE_TARGET,
        waitForTimeout: async () => {},
        addScriptTag: async () => {},
        evaluate: async () => ({ title: 'meta', text: 'sensitive content' }),
        close: async () => {},
      }),
    } as any;

    const result = await extract(fakeCtx, PUBLIC_URL, { mode: 'full' });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('sensitive content');
  });
});

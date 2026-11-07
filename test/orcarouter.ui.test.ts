import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startUiServer, type UiServerHandle } from '../src/orcarouter/ui.js';
import { loadStoredCredential } from '../src/orcarouter/credentials.js';

const API_KEY = 'sk-orca-ui-test-key-00000000001';
const realFetch = globalThis.fetch.bind(globalThis);

async function mutationHeaders(url: string): Promise<Record<string, string>> {
  const page = await (await realFetch(url)).text();
  const token = page.match(/name="orcarouter-csrf" content="([^"]+)"/)?.[1];
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { origin: new URL(url).origin, 'content-type': 'application/json', 'x-orca-csrf': token! };
}

function rawRequest(url: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

const CATALOG = {
  data: [
    {
      id: 'openai/gpt-5.5',
      context_length: 400_000,
      reasoning: true,
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text'] },
    },
    {
      id: 'openai/gpt-image-1',
      supported_endpoint_types: ['image-generation'],
      architecture: { input_modalities: ['text'] },
    },
  ],
};

/** Stub only the upstream catalog call; the test's own HTTP calls pass through. */
function stubUpstreamCatalog(handler: () => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.orcarouter.ai')) return handler();
    return realFetch(input as RequestInfo, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

let root: string;
let handle: UiServerHandle | null = null;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-ui-'));
  env = { SURF_PROFILE_ROOT: root, ORCAROUTER_API_KEY: API_KEY };
  stubUpstreamCatalog(() => new Response(JSON.stringify(CATALOG), { status: 200 }));
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('OrcaRouter configuration UI', () => {
  it('keeps the API key on the server: the page and model payload never carry it', async () => {
    const upstream = stubUpstreamCatalog(() => new Response(JSON.stringify(CATALOG), { status: 200 }));
    handle = await startUiServer({ env });

    const response = await realFetch(handle.url);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const page = await response.text();
    // The page carries no key and no template for one.
    expect(page).not.toContain(API_KEY);
    expect(page).toContain('type="password"');
    expect(page).toContain('Connect with OrcaRouter');

    const models = await (await realFetch(`${handle.url}api/models?capability=chat`)).json() as {
      models: Array<{ id: string }>; source: string; degraded: boolean;
    };
    expect(JSON.stringify(models)).not.toContain(API_KEY);
    // The upstream request did carry it, from the server side only.
    const catalogCalls = upstream.mock.calls.filter(([url]) => String(url).includes('api.orcarouter.ai'));
    expect(String((catalogCalls[0][1]?.headers as Record<string, string>).authorization)).toBe(`Bearer ${API_KEY}`);
  });

  it('reports exactly one credential entry point at a time, masked', async () => {
    handle = await startUiServer({ env });
    const status = await (await realFetch(`${handle.url}api/status`)).json() as Record<string, unknown>;

    expect(status.configured).toBe(true);
    expect(status.source).toBe('api-key');
    expect(status.needsReauth).toBe(false);
    expect(String(status.keyMasked)).not.toContain(API_KEY);
    // The label carries no key material at all, only the one-way fingerprint.
    expect(String(status.keyMasked)).not.toMatch(/sk-orca/);
    expect(String(status.keyMasked)).toBe(`orca-key#${status.generation}`);
    expect(status.origins).toEqual({
      auth: 'https://www.orcarouter.ai',
      api: 'https://api.orcarouter.ai',
    });
  });

  it('stores a pasted key and clears it again', async () => {
    handle = await startUiServer({ env: { SURF_PROFILE_ROOT: root } });
    const headers = await mutationHeaders(handle.url);

    const saved = await (await realFetch(`${handle.url}api/key`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: API_KEY }),
    })).json() as { saved: boolean; formatLooksValid: boolean; keyMasked: string };

    expect(saved.saved).toBe(true);
    expect(saved.formatLooksValid).toBe(true);
    expect(saved.keyMasked).not.toContain(API_KEY);
    expect(loadStoredCredential(env)?.key).toBe(API_KEY);
    expect(loadStoredCredential(env)?.source).toBe('api-key');

    const cleared = await (await realFetch(`${handle.url}api/key`, { method: 'DELETE', headers })).json();
    expect(cleared).toEqual({ cleared: true });
    expect(loadStoredCredential(env)).toBeNull();
  });

  it('rejects cross-origin form payloads and unauthorized mutations without replacing a key', async () => {
    handle = await startUiServer({ env: { SURF_PROFILE_ROOT: root } });
    const headers = await mutationHeaders(handle.url);
    const endpoint = `${handle.url}api/key`;
    expect((await realFetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify({ key: API_KEY }),
    })).status).toBe(200);

    const form = await realFetch(endpoint, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'text/plain' },
      body: '{"key":"attacker-key","padding":"="}\r\n',
    });
    expect(form.status).toBe(403);

    for (const invalid of [
      { ...headers, origin: 'https://attacker.example' },
      { ...headers, origin: `${headers.origin}.attacker.example` },
      { ...headers, origin: '' },
      { ...headers, 'x-orca-csrf': '' },
      { ...headers, 'x-orca-csrf': 'wrong-token' },
    ]) {
      for (const method of ['POST', 'DELETE']) {
        expect((await realFetch(endpoint, {
          method, headers: invalid, body: method === 'POST' ? '{"key":"attacker-key"}' : undefined,
        })).status).toBe(403);
      }
    }
    for (const method of ['POST', 'DELETE']) {
      expect((await realFetch(endpoint, {
        method, headers: { ...headers, 'content-type': 'text/plain' },
        body: method === 'POST' ? '{"key":"attacker-key"}' : undefined,
      })).status).toBe(415);
    }
    expect(loadStoredCredential(env)?.key).toBe(API_KEY);
  });

  it('uses a fresh CSRF token for each UI server', async () => {
    handle = await startUiServer({ env });
    const other = await startUiServer({ env });
    try {
      const headers = await mutationHeaders(handle.url);
      const otherHeaders = await mutationHeaders(other.url);
      expect(headers['x-orca-csrf']).not.toBe(otherHeaders['x-orca-csrf']);
      expect((await realFetch(`${handle.url}api/key`, {
        method: 'DELETE', headers: { ...headers, 'x-orca-csrf': otherHeaders['x-orca-csrf'] },
      })).status).toBe(403);
    } finally {
      await other.close();
    }
  });

  it('rejects a foreign Host even on read-only endpoints', async () => {
    handle = await startUiServer({ env });
    expect(await rawRequest(handle.url, '/api/status', { host: 'attacker.example' })).toBe(403);
    expect((await realFetch(`${handle.url}api/status`)).status).toBe(200);
  });

  it.each(['//[', '//attacker.example/path', '/\\attacker.example/path', 'http://attacker.example/'])
    ('returns 400 for unsafe raw request target %s and keeps serving', async (target) => {
      handle = await startUiServer({ env });
      expect(await rawRequest(handle.url, target)).toBe(400);
      expect((await realFetch(`${handle.url}api/status`)).status).toBe(200);
    });

  it('uses the injected API origin and bearer key for cached catalog discovery', async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const upstream = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CATALOG));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    try {
      handle = await startUiServer({ env: { ...env, ORCA_API_BASE_URL: api } });
      const status = await (await realFetch(`${handle.url}api/status`)).json() as { origins: { api: string } };
      expect(status.origins.api).toBe(api);
      for (let i = 0; i < 2; i++) {
        const catalog = await (await realFetch(`${handle.url}api/models`)).json() as { source: string };
        expect(catalog.source).toBe('live');
      }
      expect(seen).toEqual([{ url: '/v1/models?capability=chat', authorization: `Bearer ${API_KEY}` }]);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('serves the text selector only chat models and the multimodal selector only image-input chat models', async () => {
    handle = await startUiServer({ env });

    const text = await (await realFetch(`${handle.url}api/models?capability=chat`)).json() as {
      models: Array<{ id: string }>; count: number;
    };
    expect(text.models.map((m) => m.id).sort())
      .toEqual(['deepseek/deepseek-v4-pro', 'openai/gpt-5.5']);

    const multimodal = await (await realFetch(`${handle.url}api/models?capability=chat&input_modality=image`)).json() as {
      models: Array<{ id: string }>;
    };
    // The text-only model drops out; the image generator never appears.
    expect(multimodal.models.map((m) => m.id)).toEqual(['openai/gpt-5.5']);
  });

  it('surfaces the degraded state when live discovery fails instead of a free-text input', async () => {
    stubUpstreamCatalog(() => { throw new TypeError('fetch failed'); });
    handle = await startUiServer({ env });

    const payload = await (await realFetch(`${handle.url}api/models?capability=chat`)).json() as {
      degraded: boolean; source: string; reason: string; models: Array<{ id: string }>;
    };
    expect(payload.degraded).toBe(true);
    expect(payload.source).toBe('seed');
    expect(payload.reason).toBeTruthy();
    expect(payload.models.length).toBeGreaterThan(0);
    // The page offers a listbox, never a free-text model field.
    const page = await (await realFetch(handle.url)).text();
    expect(page).toContain('role="listbox"');
    expect(page).not.toMatch(/<input[^>]+id="model"/);
  });
});

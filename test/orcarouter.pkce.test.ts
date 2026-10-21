import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEndpoints } from '../src/orcarouter/endpoints.js';
import {
  codeChallenge,
  connectLoopback,
  connectOutOfBand,
  createPkceAttempt,
  exchangeCode,
  OrcaAuthError,
  safeEqual,
} from '../src/orcarouter/pkce.js';
import { loadStoredCredential } from '../src/orcarouter/credentials.js';

const AUTH = 'https://www.orcarouter.ai';
const endpoints = resolveEndpoints({});

let root: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-pkce-'));
  env = { SURF_PROFILE_ROOT: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('PKCE primitives', () => {
  it('derives an unpadded base64url S256 challenge from the verifier', () => {
    const verifier = 'fixed-verifier-for-hash-check';
    const expected = createHash('sha256').update(verifier).digest('base64url');
    const challenge = codeChallenge(verifier);
    expect(challenge).toBe(expected);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
    // Under S256 the challenge is a hash, never the verifier itself.
    expect(challenge).not.toBe(verifier);
  });

  it('builds a fresh verifier and state on every attempt', () => {
    const first = createPkceAttempt(endpoints, { appName: 'Google Surf MCP', callbackUrl: 'http://127.0.0.1:1234/cb' });
    const second = createPkceAttempt(endpoints, { appName: 'Google Surf MCP', callbackUrl: 'http://127.0.0.1:1234/cb' });
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    // 32 random bytes -> 43 base64url chars.
    expect(first.verifier).toHaveLength(43);
    expect(first.challenge).toBe(codeChallenge(first.verifier));
  });

  it('puts the challenge, state and app name on the authorize URL and the verifier nowhere', () => {
    const attempt = createPkceAttempt(endpoints, {
      appName: 'Google Surf MCP',
      callbackUrl: 'http://127.0.0.1:1234/cb',
      scope: 'api',
    });
    const url = new URL(attempt.authorizeUrl);

    expect(url.origin).toBe(AUTH);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('code_challenge')).toBe(attempt.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(attempt.state);
    expect(url.searchParams.get('app_name')).toBe('Google Surf MCP');
    expect(url.searchParams.get('scope')).toBe('api');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:1234/cb');
    // The verifier must never ride on the URL.
    expect(attempt.authorizeUrl).not.toContain(attempt.verifier);
  });

  it('always sends S256, even in Flow A where a human can still be shown a code', () => {
    const attempt = createPkceAttempt(endpoints, { appName: 'x', callbackUrl: 'oob' });
    expect(new URL(attempt.authorizeUrl).searchParams.get('code_challenge_method')).toBe('S256');
    expect(attempt.authorizeUrl).not.toContain('plain');
  });

  it('compares state in constant time and rejects a mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('exchange', () => {
  const okBody = { key: 'sk-orca-issued-from-exchange', user_id: '12345', scope: 'api' };

  it('posts the code and verifier to the auth origin keys path, never the relay', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    const result = await exchangeCode(endpoints, 'one-time-code', 'the-verifier', fetchMock as unknown as typeof fetch);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AUTH}/api/v1/auth/keys`);
    expect(url).not.toContain('api.orcarouter.ai');
    expect(url).not.toBe('https://api.orcarouter.ai/v1/auth/keys');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'one-time-code',
      code_verifier: 'the-verifier',
      code_challenge_method: 'S256',
    });
    expect(result).toEqual({ key: okBody.key, scope: 'api', userId: '12345' });
  });

  it('reports the granted scope rather than assuming the requested one', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ key: 'sk-orca-k', user_id: '1', scope: 'connector' }), { status: 200 },
    ));
    const result = await exchangeCode(endpoints, 'c', 'v', fetchMock as unknown as typeof fetch);
    expect(result.scope).toBe('connector');
  });

  it('classifies 400 as a rejected code_challenge_method', async () => {
    const fetchMock = vi.fn(async () => new Response('unsupported method', { status: 400 }));
    await expect(exchangeCode(endpoints, 'c', 'v', fetchMock as unknown as typeof fetch))
      .rejects.toMatchObject({ code: 'challenge_method_rejected', status: 400 });
  });

  it('classifies 403 as an unknown, expired or reused code', async () => {
    const fetchMock = vi.fn(async () => new Response('code already used', { status: 403 }));
    const failure = exchangeCode(endpoints, 'c', 'v', fetchMock as unknown as typeof fetch);
    await expect(failure).rejects.toMatchObject({ code: 'code_rejected', status: 403 });
    await expect(failure).rejects.toBeInstanceOf(OrcaAuthError);
  });

  it('classifies 429 as the per-user key-issuance cap', async () => {
    const fetchMock = vi.fn(async () => new Response('too many keys', { status: 429 }));
    const failure = exchangeCode(endpoints, 'c', 'v', fetchMock as unknown as typeof fetch);
    await expect(failure).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(failure).rejects.toThrow(/24 hours/);
  });

  it('fails safely on a network error without leaking the verifier', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const failure = exchangeCode(endpoints, 'one-time-code', 'super-secret-verifier', fetchMock as unknown as typeof fetch);
    await expect(failure).rejects.toMatchObject({ code: 'network_error' });
    await expect(failure).rejects.not.toThrow(/super-secret-verifier/);
  });

  it('never echoes the verifier or code out of an error body', async () => {
    const fetchMock = vi.fn(async () => new Response(
      'verifier mismatch for super-secret-verifier and code one-time-code', { status: 403 },
    ));
    const failure = exchangeCode(endpoints, 'one-time-code', 'super-secret-verifier', fetchMock as unknown as typeof fetch);
    await expect(failure).rejects.not.toThrow(/super-secret-verifier/);
    await expect(failure).rejects.not.toThrow(/one-time-code/);
  });

  it('rejects a success body with no key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ scope: 'api' }), { status: 200 }));
    await expect(exchangeCode(endpoints, 'c', 'v', fetchMock as unknown as typeof fetch))
      .rejects.toMatchObject({ code: 'malformed_response' });
  });
});

/**
 * A local stand-in for the consent screen plus the exchange endpoint.
 * `browser` plays the part the user's real browser plays: it opens the
 * authorize URL the flow hands out, and the fake consent screen then delivers
 * the code back to the loopback listener.
 */
async function fakeAuthServer(options: {
  exchangeStatus?: number;
  grantedScope?: string;
  deny?: boolean;
}): Promise<{ authBase: string; close: () => void; presented: { state: string; challenge: string; verifier?: string } }> {
  const presented: { state: string; challenge: string; verifier?: string } = { state: '', challenge: '' };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/v1/auth/keys') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { code?: string; code_verifier?: string };
        presented.verifier = parsed.code_verifier;
        if (options.exchangeStatus && options.exchangeStatus !== 200) {
          res.writeHead(options.exchangeStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code rejected' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          key: 'sk-orca-issued-by-fake-consent',
          user_id: 'fake-user',
          scope: options.grantedScope ?? 'api',
        }));
      });
      return;
    }
    if (url.pathname === '/auth') {
      presented.state = url.searchParams.get('state') ?? '';
      presented.challenge = url.searchParams.get('code_challenge') ?? '';
      const callback = url.searchParams.get('callback_url') ?? '';
      if (callback.startsWith('http://127.0.0.1:')) {
        // Approve or deny: deliver to the loopback listener exactly as the real
        // consent screen would. The code is one-time and short-lived there.
        const query = options.deny
          ? `error=access_denied&state=${encodeURIComponent(presented.state)}`
          : `code=local-one-time-code&state=${encodeURIComponent(presented.state)}`;
        void fetch(`${callback}?${query}`);
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>consent</p>');
      return;
    }
    res.writeHead(404).end();
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { authBase: `http://127.0.0.1:${port}`, close: () => server.close(), presented };
}

/** Stands in for the user's browser opening the authorize URL. */
function browser(onAuthorizeUrl: (url: string) => void) {
  return (url: string) => {
    onAuthorizeUrl(url);
    void fetch(url).catch(() => {});
  };
}

describe('Flow A — loopback redirect end to end', () => {
  it('authorizes, exchanges and persists a reusable key', async () => {
    const fake = await fakeAuthServer({});
    try {
      const urls: string[] = [];
      const result = await connectLoopback(
        {
          appName: 'Google Surf MCP',
          onAuthorizeUrl: browser((url) => urls.push(url)),
          env,
          timeoutMs: 10_000,
        },
        resolveEndpoints({ ORCA_BASE_URL: fake.authBase }),
      );

      expect(result.key).toBe('sk-orca-issued-by-fake-consent');
      expect(result.scope).toBe('api');
      expect(result.scopeDowngraded).toBe(false);

      // The authorize URL went to the auth origin and carried only the challenge.
      expect(urls).toHaveLength(1);
      const authorize = new URL(urls[0]);
      expect(authorize.origin).toBe(fake.authBase);
      expect(authorize.pathname).toBe('/auth');
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('code_challenge')).toBe(fake.presented.challenge);
      expect(authorize.searchParams.get('state')).toBe(fake.presented.state);
      expect(authorize.searchParams.get('callback_url')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/);

      // The consent screen saw the verifier that hashes to the challenge it was
      // sent — and the verifier never rode on the authorize URL.
      expect(fake.presented.verifier).toBeTruthy();
      expect(codeChallenge(fake.presented.verifier!)).toBe(fake.presented.challenge);
      expect(urls[0]).not.toContain(fake.presented.verifier!);

      // The key is persisted, so the next launch reuses it.
      expect(loadStoredCredential(env)?.key).toBe(result.key);
    } finally {
      fake.close();
    }
  });

  it('refuses a code delivered with a state it did not send', async () => {
    // A hostile page drops a valid-looking code on the loopback listener with a
    // state the flow never issued.
    const hostile = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/auth') {
        res.writeHead(404).end();
        return;
      }
      const callback = url.searchParams.get('callback_url') ?? '';
      void fetch(`${callback}?code=someone-elses-code&state=attacker-supplied-state`);
      res.writeHead(200).end('');
    });
    const port = await new Promise<number>((resolve) => {
      hostile.listen(0, '127.0.0.1', () => resolve((hostile.address() as AddressInfo).port));
    });
    try {
      const failure = connectLoopback(
        {
          appName: 'Google Surf MCP',
          onAuthorizeUrl: (url) => { void fetch(url).catch(() => {}); },
          env,
          timeoutMs: 10_000,
        },
        resolveEndpoints({ ORCA_BASE_URL: `http://127.0.0.1:${port}` }),
      );
      await expect(failure).rejects.toMatchObject({ code: 'state_mismatch' });
      // The foreign code was never exchanged and nothing was stored.
      expect(loadStoredCredential(env)).toBeNull();
    } finally {
      hostile.close();
    }
  });

  it('compares state in a way that rejects any foreign value', () => {
    const attempt = createPkceAttempt(endpoints, { appName: 'Google Surf MCP', callbackUrl: 'oob' });
    // The state comparison is the only thing between the listener and a code
    // somebody else's page dropped on it.
    expect(safeEqual('attacker-supplied-state', attempt.state)).toBe(false);
    expect(safeEqual(attempt.state, attempt.state)).toBe(true);
  });

  it('surfaces a denial without hanging', async () => {
    const fake = await fakeAuthServer({ deny: true });
    try {
      const failure = connectLoopback(
        {
          appName: 'Google Surf MCP',
          onAuthorizeUrl: browser(() => {}),
          env,
          timeoutMs: 10_000,
        },
        resolveEndpoints({ ORCA_BASE_URL: fake.authBase }),
      );
      await expect(failure).rejects.toMatchObject({ code: 'access_denied' });
      // A denial is terminal and stores nothing.
      expect(loadStoredCredential(env)).toBeNull();
    } finally {
      fake.close();
    }
  });

  it('times out and releases the listener instead of hot-looping', async () => {
    const server = createServer((_req, res) => { res.writeHead(200).end(''); });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    try {
      const started = Date.now();
      const failure = connectLoopback(
        {
          appName: 'Google Surf MCP',
          // The browser never comes back with a code.
          onAuthorizeUrl: () => {},
          env,
          timeoutMs: 400,
        },
        resolveEndpoints({ ORCA_BASE_URL: `http://127.0.0.1:${port}` }),
      );
      await expect(failure).rejects.toMatchObject({ code: 'timeout' });
      // Bounded: the abandoned listener must not keep the process alive.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });

  it('does not persist anything when the exchange is rejected', async () => {
    const fake = await fakeAuthServer({ exchangeStatus: 403 });
    try {
      const failure = connectLoopback(
        {
          appName: 'Google Surf MCP',
          onAuthorizeUrl: browser(() => {}),
          env,
          timeoutMs: 10_000,
        },
        resolveEndpoints({ ORCA_BASE_URL: fake.authBase }),
      );
      await expect(failure).rejects.toMatchObject({ code: 'code_rejected' });
      expect(loadStoredCredential(env)).toBeNull();
    } finally {
      fake.close();
    }
  });

  it('records a scope downgrade instead of storing the requested scope', async () => {
    const fake = await fakeAuthServer({ grantedScope: 'connector' });
    try {
      const result = await connectLoopback(
        {
          appName: 'Google Surf MCP',
          onAuthorizeUrl: browser(() => {}),
          env,
          timeoutMs: 10_000,
        },
        resolveEndpoints({ ORCA_BASE_URL: fake.authBase }),
      );
      // We asked for "api" and were granted something else.
      expect(result.scope).toBe('connector');
      expect(result.scopeDowngraded).toBe(true);
      expect(loadStoredCredential(env)?.scope).toBe('connector');
    } finally {
      fake.close();
    }
  });
});

describe('Flow B — out-of-band code', () => {
  it('uses callback_url=oob, mandatory S256, and persists the exchanged key', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ key: 'sk-orca-oob-key', user_id: 'u-9', scope: 'api' }), { status: 200 },
    ));
    const urls: string[] = [];
    const result = await connectOutOfBand(
      {
        appName: 'Google Surf MCP',
        onAuthorizeUrl: (url) => urls.push(url),
        readCode: async () => 'code-from-screen',
        fetchImpl: fetchMock as unknown as typeof fetch,
        env,
      },
      endpoints,
    );

    const authorize = new URL(urls[0]);
    expect(authorize.searchParams.get('callback_url')).toBe('oob');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.key).toBe('sk-orca-oob-key');
    expect(loadStoredCredential(env)?.key).toBe('sk-orca-oob-key');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AUTH}/api/v1/auth/keys`);
    const body = JSON.parse(String(init.body)) as { code: string; code_verifier: string };
    expect(body.code).toBe('code-from-screen');
    // The verifier is the one that matches the challenge on the authorize URL.
    expect(codeChallenge(body.code_verifier)).toBe(authorize.searchParams.get('code_challenge'));
    expect(urls[0]).not.toContain(body.code_verifier);
  });

  it('reports an empty code instead of sending an empty exchange', async () => {
    const fetchMock = vi.fn();
    const failure = connectOutOfBand(
      {
        appName: 'Google Surf MCP',
        onAuthorizeUrl: () => {},
        readCode: async () => '   ',
        fetchImpl: fetchMock as unknown as typeof fetch,
        env,
      },
      endpoints,
    );
    await expect(failure).rejects.toMatchObject({ code: 'missing_code' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

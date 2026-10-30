// OAuth 2.0 + PKCE against OrcaRouter.
//
// Flow A (loopback redirect) is the default: the connect command is a local
// process that can bind 127.0.0.1, so the code comes back on its own. Flow B
// (out-of-band) is offered for sessions with a browser but no reachable
// loopback listener. Both always send S256 — a user can pick "Show me a code"
// on the consent screen even in Flow A, so `plain` is never safe here.
//
// The exchanged value is a durable OrcaRouter API key, not an OAuth access
// token. There is no refresh grant: the key is reused until revoked.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AUTH_PATHS, resolveEndpoints, type OrcaEndpoints } from './endpoints.js';
import { randomUrlSafe, savePkceCredential } from './credentials.js';

const CALLBACK_PATH = '/cb';
const DEFAULT_SCOPE = 'api';
const EXCHANGE_TIMEOUT_MS = 30_000;

export class OrcaAuthError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'OrcaAuthError';
    this.code = code;
    this.status = status;
  }
}

export interface PkceAttempt {
  /** Never leaves the process before the exchange; never logged or serialized. */
  verifier: string;
  challenge: string;
  state: string;
  callbackUrl: string;
  authorizeUrl: string;
}

export interface PkceAttemptOptions {
  appName: string;
  /** `oob` for Flow B, or the concrete loopback callback URL for Flow A. */
  callbackUrl: string;
  scope?: string;
  loginHint?: string;
  workspaceHint?: string;
  /** Force re-approval even when the user approved this app before. */
  prompt?: 'consent';
}

function base64url(raw: Buffer): string {
  return raw.toString('base64url');
}

/** `base64url(sha256(verifier))`, unpadded. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/**
 * Build a fresh attempt. The verifier and state come from the cryptographic RNG
 * on every call — never a timestamp, a username, or a fixed salt.
 */
export function createPkceAttempt(
  endpoints: OrcaEndpoints,
  options: PkceAttemptOptions,
): PkceAttempt {
  const verifier = randomUrlSafe(32);
  const challenge = codeChallenge(verifier);
  const state = randomUrlSafe(16);

  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('callback_url', options.callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('app_name', options.appName);
  url.searchParams.set('scope', options.scope ?? DEFAULT_SCOPE);
  if (options.loginHint) url.searchParams.set('login_hint', options.loginHint);
  if (options.workspaceHint) url.searchParams.set('workspace_hint', options.workspaceHint);
  if (options.prompt) url.searchParams.set('prompt', options.prompt);

  return { verifier, challenge, state, callbackUrl: options.callbackUrl, authorizeUrl: url.toString() };
}

/** Constant-time comparison that does not leak length through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export interface ExchangeResult {
  key: string;
  scope: string;
  userId?: string;
}

/**
 * Exchange an auth code for a durable key. Form encoding is accepted by the
 * endpoint but JSON is what the flow documents, so JSON is what is sent.
 */
export async function exchangeCode(
  endpoints: OrcaEndpoints,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoints.keysUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    // Transport failures must never echo the verifier or the code.
    throw new OrcaAuthError('network_error', `OrcaRouter exchange unreachable: ${errorName(error)}`);
  }

  if (!response.ok) {
    const body = await safeText(response, verifier, code);
    if (response.status === 400) {
      throw new OrcaAuthError(
        'challenge_method_rejected',
        `OrcaRouter rejected the PKCE method (400): ${body}`,
        400,
      );
    }
    if (response.status === 403) {
      throw new OrcaAuthError(
        'code_rejected',
        `OrcaRouter rejected the authorization code (403) — it may be unknown, expired, or already used: ${body}`,
        403,
      );
    }
    if (response.status === 429) {
      throw new OrcaAuthError(
        'rate_limited',
        'OrcaRouter rate-limited this authorization (429). Ten PKCE keys per user per 24 hours; reuse the stored key instead of reconnecting.',
        429,
      );
    }
    throw new OrcaAuthError('exchange_failed', `OrcaRouter exchange failed (${response.status}): ${body}`, response.status);
  }

  const payload = (await response.json().catch(() => null)) as
    | { key?: unknown; scope?: unknown; user_id?: unknown }
    | null;
  const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
  if (!key) throw new OrcaAuthError('malformed_response', 'OrcaRouter exchange returned no key');

  return {
    key,
    // The response states what was granted, not what was requested.
    scope: typeof payload?.scope === 'string' ? payload.scope : '',
    userId: typeof payload?.user_id === 'string' ? payload.user_id : undefined,
  };
}

async function safeText(response: Response, ...secrets: string[]): Promise<string> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    return '';
  }
  let out = body;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, '[redacted]');
  }
  return out.slice(0, 500);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'unknown error';
}

export interface ConnectResult extends ExchangeResult {
  /** True when the granted scope is not the scope this client asked for. */
  scopeDowngraded: boolean;
}

/**
 * Persist the exchanged key. Called only after a successful, scope-checked
 * exchange: an earlier secret is never deleted before its replacement exists.
 */
export function persistConnectResult(
  result: ExchangeResult,
  requestedScope: string,
  env: Record<string, string | undefined> = process.env,
): ConnectResult {
  const granted = result.scope || requestedScope;
  savePkceCredential(result.key, granted, result.userId, env);
  return { ...result, scope: granted, scopeDowngraded: granted !== requestedScope };
}

export interface LoopbackConnectOptions {
  appName: string;
  scope?: string;
  loginHint?: string;
  /** Receives the authorize URL; the caller opens a browser or prints it. */
  onAuthorizeUrl: (url: string) => void;
  /** Milliseconds to wait for the browser before giving up. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface LoopbackConnectDeps {
  /** Injected so tests can drive a fake consent server end to end. */
  listen?: (handler: (code: string, state: string) => void) => Promise<{
    port: number;
    waitForCode: () => Promise<{ code?: string; state?: string; error?: string }>;
    close: () => void;
  }>;
}

/**
 * Flow A — bind loopback first so the port is known before the browser opens,
 * compare `state` before touching the code, then exchange and persist.
 */
export async function connectLoopback(
  options: LoopbackConnectOptions,
  endpoints: OrcaEndpoints = resolveEndpoints(options.env ?? process.env),
): Promise<ConnectResult> {
  const env = options.env ?? process.env;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const { port, waitForCode, close } = await startCallbackListener();
  let attempt: PkceAttempt;
  try {
    attempt = createPkceAttempt(endpoints, {
      appName: options.appName,
      callbackUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      scope,
      loginHint: options.loginHint,
    });
    options.onAuthorizeUrl(attempt.authorizeUrl);

    const callback = await withTimeout(waitForCode(), timeoutMs, close);

    // Compare state before doing anything else with the payload.
    if (callback.error) {
      throw new OrcaAuthError('access_denied', `OrcaRouter authorization was refused: ${callback.error}`);
    }
    if (!callback.state || !safeEqual(callback.state, attempt.state)) {
      throw new OrcaAuthError('state_mismatch', 'OrcaRouter callback state did not match; refusing the code');
    }
    if (!callback.code) {
      throw new OrcaAuthError('missing_code', 'OrcaRouter callback carried no authorization code');
    }

    const exchanged = await exchangeCode(endpoints, callback.code, attempt.verifier, options.fetchImpl ?? fetch);
    return persistConnectResult(exchanged, scope, env);
  } finally {
    close();
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new OrcaAuthError('timeout', `OrcaRouter authorization timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startCallbackListener(): Promise<{
  port: number;
  waitForCode: () => Promise<{ code?: string; state?: string; error?: string }>;
  close: () => void;
}> {
  let settle: (value: { code?: string; state?: string; error?: string }) => void;
  const codePromise = new Promise<{ code?: string; state?: string; error?: string }>((resolve) => {
    settle = resolve;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Connected. You can close this tab.</p>');
    settle({
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  return {
    port,
    waitForCode: () => codePromise,
    close: () => {
      try {
        server.close();
      } catch {
        // already closed
      }
    },
  };
}

export interface OutOfBandConnectOptions {
  appName: string;
  scope?: string;
  loginHint?: string;
  onAuthorizeUrl: (url: string) => void;
  /** Supplies the code the consent screen displayed. */
  readCode: () => Promise<string>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Flow B — for a session with a browser but no reachable loopback listener. */
export async function connectOutOfBand(
  options: OutOfBandConnectOptions,
  endpoints: OrcaEndpoints = resolveEndpoints(options.env ?? process.env),
): Promise<ConnectResult> {
  const env = options.env ?? process.env;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const attempt = createPkceAttempt(endpoints, {
    // The literal three letters: the mode is asked for, not guessed at.
    callbackUrl: 'oob',
    appName: options.appName,
    scope,
    loginHint: options.loginHint,
  });
  options.onAuthorizeUrl(attempt.authorizeUrl);

  const code = (await options.readCode()).trim();
  if (!code) throw new OrcaAuthError('missing_code', 'no authorization code was entered');

  const exchanged = await exchangeCode(endpoints, code, attempt.verifier, options.fetchImpl ?? fetch);
  return persistConnectResult(exchanged, scope, env);
}

/** Discovery document URL for deployments that prefer to read the endpoints. */
export function discoveryUrl(endpoints: OrcaEndpoints): string {
  return `${endpoints.authBase}${AUTH_PATHS.discovery}`;
}

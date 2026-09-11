// The credential seam.
//
// Both ways of getting an OrcaRouter credential — pasting an `sk-orca-…` key
// and the OAuth 2.0 + PKCE connect flow — are adapters on the same tiny
// interface and both yield the same `OrcaCredential`. The repair provider, the
// model catalog and every tool call consume the credential and never care which
// adapter produced it, so no auth logic is duplicated downstream.

import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type OrcaCredentialSource = 'api-key' | 'pkce';

export interface OrcaCredential {
  /** The bearer token. Never log, never serialize. */
  key: string;
  source: OrcaCredentialSource;
  /** Scope actually granted by the exchange response, when known. */
  scope: string;
  /**
   * Stable fingerprint of this exact credential generation. A late failure
   * from an old generation must not be attributed to a newly stored one.
   */
  generation: string;
  /** Owning OrcaRouter account, when the flow reported one. */
  accountId?: string;
}

export interface OrcaCredentialProvider {
  readonly source: OrcaCredentialSource;
  resolve(): Promise<OrcaCredential | null>;
}

export interface StoredCredential {
  key: string;
  scope: string;
  userId?: string;
  issuedAt: string;
  /** Which entry point wrote it: a pasted key or a PKCE connect. */
  source: OrcaCredentialSource;
}

export interface ReauthState {
  generation: string;
  accountId?: string;
  markedAt: string;
}

function profileRoot(env: Record<string, string | undefined>): string {
  return resolve(env.SURF_PROFILE_ROOT || join(homedir(), '.google-surf-mcp'));
}

export function credentialFile(env: Record<string, string | undefined> = process.env): string {
  return env.SURF_ORCAROUTER_CREDENTIAL_FILE || join(profileRoot(env), '.orcarouter', 'credential.json');
}

function reauthFile(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(credentialFile(env)), 'reauth.json');
}

/** Fingerprint of a credential generation. One-way; safe to log. */
export function credentialGeneration(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Display form for a credential. It carries no key material at all: only the
 * one-way generation fingerprint, so the value is safe in a UI, a screenshot,
 * a terminal, or a health payload.
 */
export function redactKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '[redacted]';
  return `orca-key#${credentialGeneration(trimmed)}`;
}

/** Replace every known secret in a string destined for a log, error, or UI. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 6) continue;
    out = out.replaceAll(value, '[redacted]');
  }
  return out;
}

/**
 * Lightweight format check only. An `sk-orca-` prefix is not proof that a
 * credential is valid, and there is no non-billing validation endpoint, so
 * validity stays unknown until the first real request.
 */
export function looksLikeOrcaKey(value: string): boolean {
  return /^sk-orca-[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writePrivateJson(file: string, payload: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  renameSync(tmp, file);
}

export function loadStoredCredential(
  env: Record<string, string | undefined> = process.env,
): StoredCredential | null {
  const stored = readJson<StoredCredential>(credentialFile(env));
  if (!stored || typeof stored.key !== 'string' || !stored.key.trim()) return null;
  return stored;
}

/** Path shown in CLI output so users know where the secret lives. */
export function credentialsPathHint(env: Record<string, string | undefined> = process.env): string {
  return credentialFile(env);
}

/** Persist an explicitly entered key so it survives a restart. */
export function saveApiKeyCredential(
  key: string,
  scope: string,
  env: Record<string, string | undefined> = process.env,
  now: string = new Date().toISOString(),
): StoredCredential {
  const stored: StoredCredential = { key: key.trim(), scope, issuedAt: now, source: 'api-key' };
  writePrivateJson(credentialFile(env), stored);
  return stored;
}

/** Persist a PKCE-issued key so a second launch reuses it instead of re-authorizing. */
export function savePkceCredential(
  key: string,
  scope: string,
  userId?: string,
  env: Record<string, string | undefined> = process.env,
  now: string = new Date().toISOString(),
): StoredCredential {
  const stored: StoredCredential = { key: key.trim(), scope, userId, issuedAt: now, source: 'pkce' };
  writePrivateJson(credentialFile(env), stored);
  return stored;
}

/**
 * Drop the stored credential. Deliberately explicit: a transient 401 must not
 * silently delete a working secret before a replacement exists.
 */
export function clearStoredCredential(env: Record<string, string | undefined> = process.env): void {
  const file = credentialFile(env);
  if (existsSync(file)) rmSync(file, { force: true });
  const reauth = reauthFile(env);
  if (existsSync(reauth)) rmSync(reauth, { force: true });
}

/** Terminal reauthentication state for one exact credential generation. */
export function readReauthState(
  env: Record<string, string | undefined> = process.env,
): ReauthState | null {
  return readJson<ReauthState>(reauthFile(env));
}

export function markNeedsReauth(
  credential: Pick<OrcaCredential, 'generation' | 'accountId'>,
  env: Record<string, string | undefined> = process.env,
  now: string = new Date().toISOString(),
): ReauthState {
  const state: ReauthState = {
    generation: credential.generation,
    accountId: credential.accountId,
    markedAt: now,
  };
  writePrivateJson(reauthFile(env), state);
  return state;
}

/**
 * Apply a `401` to the exact account and credential generation that made the
 * rejected request. A stale failure from an old generation is ignored so it
 * cannot poison a credential the user just reauthorized.
 */
export function applyUpstream401(
  rejected: Pick<OrcaCredential, 'generation' | 'accountId'>,
  current: OrcaCredential | null,
  env: Record<string, string | undefined> = process.env,
): ReauthState | null {
  if (!current) return null;
  const a = Buffer.from(current.generation);
  const b = Buffer.from(rejected.generation);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return markNeedsReauth(rejected, env);
}

export function isCredentialStale(generation: string, env: Record<string, string | undefined> = process.env): boolean {
  const state = readReauthState(env);
  return state?.generation === generation;
}

/** True when the resolved credential has been marked for reauthentication. */
export function needsReauth(
  credential: OrcaCredential,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isCredentialStale(credential.generation, env);
}

/**
 * Adapter 1 — a key the user pasted into the project's existing environment
 * configuration (`ORCAROUTER_API_KEY`, with `ORCA_KEY` as the documented
 * alias). An explicitly configured key always wins over a stored one.
 */
export function apiKeyProvider(env: OrcaEnv = process.env): OrcaCredentialProvider {
  return {
    source: 'api-key',
    async resolve(): Promise<OrcaCredential | null> {
      const configured = env.ORCAROUTER_API_KEY?.trim() || env.ORCA_KEY?.trim();
      if (configured) {
        return {
          key: configured,
          source: 'api-key',
          scope: env.ORCA_SCOPE?.trim() || 'api',
          generation: credentialGeneration(configured),
          // Same key set as the PKCE adapter so consumers see one shape.
          accountId: env.ORCA_ACCOUNT_ID?.trim() || undefined,
        };
      }
      const stored = loadStoredCredential(env);
      if (stored && (stored.source ?? 'pkce') === 'api-key') {
        return {
          key: stored.key,
          source: 'api-key',
          scope: stored.scope || 'api',
          generation: credentialGeneration(stored.key),
          accountId: stored.userId,
        };
      }
      return null;
    },
  };
}

type OrcaEnv = Record<string, string | undefined>;

/**
 * Adapter 2 — a key issued by the PKCE connect flow and persisted under the
 * project's profile directory. Reused until the user revokes it; there is no
 * refresh grant for a durable key grant, so nothing here ever renews it.
 */
export function pkceProvider(env: OrcaEnv = process.env): OrcaCredentialProvider {
  return {
    source: 'pkce',
    async resolve(): Promise<OrcaCredential | null> {
      const stored = loadStoredCredential(env);
      if (!stored || (stored.source ?? 'pkce') !== 'pkce') return null;
      return {
        key: stored.key,
        source: 'pkce',
        scope: stored.scope || 'api',
        generation: credentialGeneration(stored.key),
        accountId: stored.userId,
      };
    },
  };
}

export interface ResolvedCredential extends OrcaCredential {
  needsReauth: boolean;
}

/**
 * Resolve the active credential. Both adapters produce the same shape; callers
 * downstream cannot tell them apart.
 */
export async function resolveCredential(
  env: OrcaEnv = process.env,
): Promise<ResolvedCredential | null> {
  for (const provider of [apiKeyProvider(env), pkceProvider(env)]) {
    const credential = await provider.resolve();
    if (!credential) continue;
    return { ...credential, needsReauth: needsReauth(credential, env) };
  }
  return null;
}

/** Fresh opaque random string suitable for a PKCE verifier or a state value. */
export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiKeyProvider,
  applyUpstream401,
  clearStoredCredential,
  credentialFile,
  credentialGeneration,
  isCredentialStale,
  loadStoredCredential,
  looksLikeOrcaKey,
  markNeedsReauth,
  needsReauth,
  pkceProvider,
  readReauthState,
  redactKey,
  redactSecrets,
  resolveCredential,
  saveApiKeyCredential,
  savePkceCredential,
} from '../src/orcarouter/credentials.js';

const PASTED = 'sk-orca-pasted-key-0000000001';
const ISSUED = 'sk-orca-pkce-issued-key-00000002';

let root: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cred-'));
  env = { SURF_PROFILE_ROOT: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('credential storage', () => {
  it('persists a PKCE-issued key under the profile directory with owner-only mode', () => {
    savePkceCredential(ISSUED, 'api', 'user-42', env, '2026-09-11T00:00:00.000Z');

    expect(credentialFile(env)).toBe(join(root, '.orcarouter', 'credential.json'));
    const stored = loadStoredCredential(env);
    expect(stored?.key).toBe(ISSUED);
    expect(stored?.source).toBe('pkce');
    expect(stored?.userId).toBe('user-42');
    // The file is a secret: it must not be world-readable.
    expect(statSync(credentialFile(env)).mode & 0o077).toBe(0);

    const raw = readFileSync(credentialFile(env), 'utf8');
    expect(raw).toContain('sk-orca-'); // it is the store, not a log
  });

  it('reuses the stored key across restarts instead of re-authorizing', async () => {
    savePkceCredential(ISSUED, 'api', undefined, env);
    const first = await pkceProvider(env).resolve();
    const second = await pkceProvider(env).resolve();
    expect(first?.key).toBe(ISSUED);
    expect(second?.key).toBe(ISSUED);
    expect(second?.generation).toBe(first?.generation);
  });

  it('clears the stored credential and its reauth marker on request', async () => {
    savePkceCredential(ISSUED, 'api', undefined, env);
    markNeedsReauth({ generation: credentialGeneration(ISSUED) }, env);
    expect(await pkceProvider(env).resolve()).not.toBeNull();

    clearStoredCredential(env);

    expect(await pkceProvider(env).resolve()).toBeNull();
    expect(readReauthState(env)).toBeNull();
  });

  it('survives a corrupted credential file without throwing', async () => {
    savePkceCredential(ISSUED, 'api', undefined, env);
    // Overwrite with garbage the way a partial write would.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(credentialFile(env), '{not json', 'utf8');
    expect(loadStoredCredential(env)).toBeNull();
    expect(await pkceProvider(env).resolve()).toBeNull();
  });
});

describe('two adapters, one credential result', () => {
  it('produces the same credential shape from the API-key and PKCE adapters', async () => {
    const pasted = await apiKeyProvider({ ...env, ORCAROUTER_API_KEY: PASTED }).resolve();

    savePkceCredential(ISSUED, 'api', undefined, env);
    const issued = await pkceProvider(env).resolve();

    expect(pasted).not.toBeNull();
    expect(issued).not.toBeNull();
    // Same keys, same shape — a downstream consumer cannot tell them apart.
    expect(Object.keys(pasted!).sort()).toEqual(Object.keys(issued!).sort());
    expect(pasted!.source).toBe('api-key');
    expect(issued!.source).toBe('pkce');
    expect(pasted!.scope).toBe(issued!.scope);
  });

  it('resolves a stored API key through the api-key adapter, not the PKCE one', async () => {
    saveApiKeyCredential(PASTED, 'api', env);
    expect(await apiKeyProvider(env).resolve()).toMatchObject({ source: 'api-key', key: PASTED });
    expect(await pkceProvider(env).resolve()).toBeNull();
  });

  it('prefers an explicitly configured key over a stored PKCE key', async () => {
    savePkceCredential(ISSUED, 'api', undefined, env);
    const resolved = await resolveCredential({ ...env, ORCAROUTER_API_KEY: PASTED });
    expect(resolved?.source).toBe('api-key');
    expect(resolved?.key).toBe(PASTED);
  });

  it('accepts ORCA_KEY as the documented alias', async () => {
    const resolved = await resolveCredential({ ...env, ORCA_KEY: PASTED });
    expect(resolved?.key).toBe(PASTED);
  });

  it('returns null when neither entry point has a credential', async () => {
    expect(await resolveCredential(env)).toBeNull();
  });
});

describe('redaction', () => {
  it('masks a key for display without revealing any key material', () => {
    const masked = redactKey(ISSUED);
    expect(masked).not.toBe(ISSUED);
    expect(masked).not.toContain(ISSUED);
    // No prefix, suffix, or any substring of the key leaks into the label.
    expect(masked).not.toMatch(/sk-orca/);
    for (const fragment of [ISSUED.slice(0, 8), ISSUED.slice(-4), ISSUED.slice(9, 16)]) {
      expect(masked).not.toContain(fragment);
    }
    // The label is still a stable identifier for this credential generation.
    expect(masked).toBe(redactKey(ISSUED));
    expect(masked).toContain(credentialGeneration(ISSUED));
    expect(redactKey('short')).toBe(`orca-key#${credentialGeneration('short')}`);
    expect(redactKey('')).toBe('[redacted]');
  });

  it('strips every known secret from text destined for a log or error', () => {
    const message = `failed with ${PASTED} and verifier ${ISSUED}`;
    const safe = redactSecrets(message, [PASTED, ISSUED]);
    expect(safe).not.toContain(PASTED);
    expect(safe).not.toContain(ISSUED);
    expect(safe).toContain('[redacted]');
  });

  it('checks the documented key format without claiming validity', () => {
    expect(looksLikeOrcaKey('sk-orca-abcdefgh1234')).toBe(true);
    expect(looksLikeOrcaKey('sk-orca-ab')).toBe(false);
    expect(looksLikeOrcaKey('sk-openai-abcdefgh1234')).toBe(false);
    expect(looksLikeOrcaKey('')).toBe(false);
  });
});

describe('durable key grant lifecycle', () => {
  it('marks a revoked credential needsReauth instead of refreshing it', async () => {
    savePkceCredential(ISSUED, 'api', 'user-42', env);
    const credential = await resolveCredential(env);
    expect(credential?.needsReauth).toBe(false);

    markNeedsReauth(credential!, env);

    const after = await resolveCredential(env);
    expect(after?.needsReauth).toBe(true);
    expect(needsReauth(after!, env)).toBe(true);
    expect(readReauthState(env)?.accountId).toBe('user-42');
  });

  it('updates only the exact account and generation that made the rejected request', async () => {
    savePkceCredential(ISSUED, 'api', 'user-42', env);
    const stale = await resolveCredential(env);

    // The user reauthorizes; a new key replaces the old one.
    savePkceCredential(PASTED, 'api', 'user-42', env);
    const fresh = await resolveCredential(env);
    expect(fresh?.generation).not.toBe(stale?.generation);

    // A late 401 from the old request must not poison the new credential.
    const marked = applyUpstream401(stale!, fresh, env);
    expect(marked).toBeNull();
    expect(isCredentialStale(fresh!.generation, env)).toBe(false);
    expect((await resolveCredential(env))?.needsReauth).toBe(false);
  });

  it('marks the current generation when the rejected request is the current one', async () => {
    savePkceCredential(ISSUED, 'api', 'user-42', env);
    const current = await resolveCredential(env);
    const marked = applyUpstream401(current!, current, env);
    expect(marked?.generation).toBe(current!.generation);
    expect(isCredentialStale(current!.generation, env)).toBe(true);
  });

  it('keeps the stored secret after a 401 so recovery is not irreversible', async () => {
    savePkceCredential(ISSUED, 'api', 'user-42', env);
    const current = await resolveCredential(env);
    applyUpstream401(current!, current, env);
    // Still on disk: a transient or misclassified failure must not delete it.
    expect(loadStoredCredential(env)?.key).toBe(ISSUED);
  });
});

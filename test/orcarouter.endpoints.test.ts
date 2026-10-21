import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE, DEFAULT_AUTH_BASE, resolveEndpoints } from '../src/orcarouter/endpoints.js';

describe('OrcaRouter endpoint resolution', () => {
  it('uses the two documented public origins with the correct auth path', () => {
    const endpoints = resolveEndpoints({});
    expect(endpoints.authBase).toBe(DEFAULT_AUTH_BASE);
    expect(endpoints.apiBase).toBe(DEFAULT_API_BASE);
    // The auth API is /api/v1/auth on the auth origin. The relay is /v1 on the
    // API origin. Mixing them 404s.
    expect(endpoints.keysUrl).toBe('https://www.orcarouter.ai/api/v1/auth/keys');
    expect(endpoints.keysUrl).not.toContain('api.orcarouter.ai');
    expect(endpoints.authorizeUrl).toBe('https://www.orcarouter.ai/auth');
    expect(endpoints.chatCompletionsUrl).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect(endpoints.modelsUrl).toBe('https://api.orcarouter.ai/v1/models');
    expect(endpoints.keysUrl).not.toBe('https://api.orcarouter.ai/v1/auth/keys');
  });

  it('lets explicit auth and API overrides win over the shared base', () => {
    const endpoints = resolveEndpoints({
      ORCA_BASE_URL: 'https://shared.example.test',
      ORCA_AUTH_BASE_URL: 'https://auth.example.test',
      ORCA_API_BASE_URL: 'https://relay.example.test',
    });
    expect(endpoints.authBase).toBe('https://auth.example.test');
    expect(endpoints.apiBase).toBe('https://relay.example.test');
    expect(endpoints.keysUrl).toBe('https://auth.example.test/api/v1/auth/keys');
    expect(endpoints.chatCompletionsUrl).toBe('https://relay.example.test/v1/chat/completions');
  });

  it('supports a single-origin self-hosted deployment through the shared base', () => {
    const endpoints = resolveEndpoints({ ORCA_BASE_URL: 'https://orca.internal.example' });
    expect(endpoints.authBase).toBe('https://orca.internal.example');
    expect(endpoints.apiBase).toBe('https://orca.internal.example');
  });

  it('preserves a self-hosted path prefix without doubling slashes', () => {
    const endpoints = resolveEndpoints({ ORCA_BASE_URL: 'https://gw.example.test/orca/' });
    expect(endpoints.authBase).toBe('https://gw.example.test/orca');
    expect(endpoints.keysUrl).toBe('https://gw.example.test/orca/api/v1/auth/keys');
  });

  it('requires HTTPS for remote origins and allows HTTP only on loopback', () => {
    expect(() => resolveEndpoints({ ORCA_AUTH_BASE_URL: 'http://orca.example.test' }))
      .toThrow(/HTTPS/);
    expect(resolveEndpoints({ ORCA_AUTH_BASE_URL: 'http://127.0.0.1:8080' }).authBase)
      .toBe('http://127.0.0.1:8080');
    expect(resolveEndpoints({ ORCA_AUTH_BASE_URL: 'http://localhost:8080' }).authBase)
      .toBe('http://localhost:8080');
  });

  it('rejects origins carrying userinfo or a fragment', () => {
    expect(() => resolveEndpoints({ ORCA_API_BASE_URL: 'https://user:pass@orca.example.test' }))
      .toThrow(/userinfo/);
    expect(() => resolveEndpoints({ ORCA_API_BASE_URL: 'https://orca.example.test/#x' }))
      .toThrow(/fragment/);
  });

  it('never derives one origin from the other', () => {
    const endpoints = resolveEndpoints({ ORCA_AUTH_BASE_URL: 'https://auth.example.test' });
    // Auth override must not move the inference origin.
    expect(endpoints.apiBase).toBe(DEFAULT_API_BASE);
    // The inference URL must not be hostname-swapped from the auth origin.
    expect(endpoints.chatCompletionsUrl).not.toContain('auth.example.test');
  });
});

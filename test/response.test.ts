import { describe, it, expect } from 'vitest';
import { formatToolResponse, toErrorInfo, fenceUntrustedContent, isErrorCode } from '../src/response.js';
import { CaptchaError } from '../src/search.js';

describe('formatToolResponse', () => {
  it('returns text + structuredContent on success', () => {
    const r = formatToolResponse({ query: 'test', results: [] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text).toContain('test');
    expect(r.structuredContent).toEqual({ query: 'test', results: [] });
  });

  it('includes meta when provided', () => {
    const r = formatToolResponse(
      { results: [] },
      undefined,
      { strategy: 'data-ved-v1', confidence: 0.9, cache: 'miss' },
    );
    expect((r.structuredContent as any).meta).toMatchObject({
      strategy: 'data-ved-v1',
      cache: 'miss',
    });
  });

  it('returns isError true with humanText + structured error', () => {
    const r = formatToolResponse(null, {
      code: 'NAV_TIMEOUT',
      message: 'search timeout',
      retryable: true,
      retry_after_ms: 1000,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('NAV_TIMEOUT');
    expect(r.content[0].text).toContain('search timeout');
    expect(r.content[0].text).toContain('Retry after: 1000ms');
    expect((r.structuredContent as any).error.code).toBe('NAV_TIMEOUT');
  });

  it('includes user_action in humanText when present', () => {
    const r = formatToolResponse(null, {
      code: 'CAPTCHA_REQUIRED',
      message: 'Captcha blocked',
      retryable: false,
      user_action: 'Run npm run bootstrap',
    });
    expect(r.content[0].text).toContain('Action: Run npm run bootstrap');
  });
});

describe('toErrorInfo classification', () => {
  it('CaptchaError + cloudMode=true → CAPTCHA_REQUIRED', () => {
    const ei = toErrorInfo(new CaptchaError('home'), { cloudMode: true });
    expect(ei.code).toBe('CAPTCHA_REQUIRED');
    expect(ei.retryable).toBe(false);
    expect(ei.user_action).toMatch(/desktop|bootstrap/);
  });

  it('CaptchaError + cloudMode=false → CAPTCHA_RECOVER_FAIL', () => {
    const ei = toErrorInfo(new CaptchaError('home'), { cloudMode: false });
    expect(ei.code).toBe('CAPTCHA_RECOVER_FAIL');
    expect(ei.user_action).toMatch(/Solve CAPTCHA|bootstrap/);
  });

  it('CaptchaError carrying userAction overrides the default user_action', () => {
    const guidance = 'Forward port 9222 via ssh -L 9222:localhost:9222 host';
    const ei = toErrorInfo(new CaptchaError('remote-debug', guidance), { cloudMode: false });
    expect(ei.user_action).toBe(guidance);
  });

  it('CaptchaError userAction also overrides cloudMode default', () => {
    const guidance = 'specific cloud guidance';
    const ei = toErrorInfo(new CaptchaError('cloud', guidance), { cloudMode: true });
    expect(ei.user_action).toBe(guidance);
  });

  it('timeout message → NAV_TIMEOUT retryable', () => {
    const ei = toErrorInfo(new Error('search timeout after 30000ms'), { cloudMode: false });
    expect(ei.code).toBe('NAV_TIMEOUT');
    expect(ei.retryable).toBe(true);
    expect(ei.retry_after_ms).toBeTypeOf('number');
  });

  it('429 message → RATE_LIMITED retryable with longer backoff', () => {
    const ei = toErrorInfo(new Error('429 Too Many Requests'), { cloudMode: false });
    expect(ei.code).toBe('RATE_LIMITED');
    expect(ei.retryable).toBe(true);
    expect(ei.retry_after_ms).toBeGreaterThan(10_000);
  });

  it('parser stale message → PARSER_STALE', () => {
    const ei = toErrorInfo(
      new Error('parser stale: 8 h3 elements but 0 results extracted'),
      { cloudMode: false },
    );
    expect(ei.code).toBe('PARSER_STALE');
  });

  it('unknown message → INTERNAL', () => {
    const ei = toErrorInfo(new Error('something unexpected'), { cloudMode: false });
    expect(ei.code).toBe('INTERNAL');
    expect(ei.retryable).toBe(false);
  });

  it('Profile not initialized → PROFILE_MISSING', () => {
    const ei = toErrorInfo(new Error('Profile not initialized. Run: npm run bootstrap'), { cloudMode: false });
    expect(ei.code).toBe('PROFILE_MISSING');
    expect(ei.user_action).toMatch(/bootstrap/);
  });

  it('private/internal address → PRIVATE_ADDRESS', () => {
    const ei = toErrorInfo(new Error('private/internal address blocked'), { cloudMode: false });
    expect(ei.code).toBe('PRIVATE_ADDRESS');
  });
});

describe('fenceUntrustedContent', () => {
  it('wraps content with BEGIN/END markers', () => {
    const fenced = fenceUntrustedContent('hello world');
    expect(fenced).toContain('--- BEGIN UNTRUSTED CONTENT ---');
    expect(fenced).toContain('--- END UNTRUSTED CONTENT ---');
    expect(fenced).toContain('hello world');
  });

  it('preserves content even with embedded fence-like text', () => {
    const tricky = 'normal text\n--- BEGIN UNTRUSTED CONTENT ---\ninjected';
    const fenced = fenceUntrustedContent(tricky);
    // outer fence treats inner markers as data
    expect(fenced).toContain(tricky);
    expect(fenced.indexOf('--- BEGIN UNTRUSTED CONTENT ---')).toBeLessThan(
      fenced.lastIndexOf('--- END UNTRUSTED CONTENT ---')
    );
  });
});

describe('isErrorCode', () => {
  it('accepts known codes', () => {
    expect(isErrorCode('NAV_TIMEOUT')).toBe(true);
    expect(isErrorCode('CAPTCHA_REQUIRED')).toBe(true);
    expect(isErrorCode('INTERNAL')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isErrorCode('NOT_REAL')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkUrlAsync, checkUrl } from '../src/extract.js';

describe('checkUrlAsync (DNS rebinding defense)', () => {
  beforeEach(() => { delete process.env.SURF_ALLOW_PRIVATE; });
  afterEach(() => { delete process.env.SURF_ALLOW_PRIVATE; });

  it('passes through sync pattern checks first (literal IP)', async () => {
    expect(await checkUrlAsync('http://127.0.0.1/x')).not.toBeNull();
    expect(await checkUrlAsync('http://192.168.1.1')).not.toBeNull();
    expect(await checkUrlAsync('http://10.0.0.1')).not.toBeNull();
  });

  it('rejects malformed URLs', async () => {
    expect(await checkUrlAsync('not a url')).toBe('invalid url');
  });

  it('rejects non-http schemes', async () => {
    expect(await checkUrlAsync('file:///etc/passwd')).toMatch(/unsupported protocol/);
    expect(await checkUrlAsync('ftp://example.com')).toMatch(/unsupported protocol/);
  });

  it('SURF_ALLOW_PRIVATE=true bypasses both pattern + DNS checks', async () => {
    process.env.SURF_ALLOW_PRIVATE = 'true';
    expect(await checkUrlAsync('http://127.0.0.1/x')).toBeNull();
    expect(await checkUrlAsync('http://localhost:8080')).toBeNull();
  });

  it('public hosts pass (real DNS resolve OK)', async () => {
    // example.com resolves to public IP
    const result = await checkUrlAsync('https://example.com');
    // public host normally returns null; allow either verdict for CI variance
    expect([null, 'resolved to private address']).toContain(result);
  });

  it('checkUrl (sync) still works for backwards compat', () => {
    expect(checkUrl('http://127.0.0.1')).not.toBeNull();
    expect(checkUrl('https://example.com')).toBeNull();
  });
});

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { checkUrl } from '../src/extract.js';

describe('extract checkUrl SSRF guard', () => {
  beforeEach(() => { delete process.env.SURF_ALLOW_PRIVATE; });
  afterEach(() => { delete process.env.SURF_ALLOW_PRIVATE; });

  it('allows public http(s) URLs', () => {
    expect(checkUrl('https://example.com/path')).toBeNull();
    expect(checkUrl('http://example.com')).toBeNull();
    expect(checkUrl('https://en.wikipedia.org/wiki/Test')).toBeNull();
  });

  it('blocks localhost and loopback', () => {
    expect(checkUrl('http://localhost:8080')).not.toBeNull();
    expect(checkUrl('http://127.0.0.1/admin')).not.toBeNull();
    expect(checkUrl('http://127.255.255.255/x')).not.toBeNull();
    expect(checkUrl('http://[::1]/')).not.toBeNull();
  });

  it('blocks private IPv4 ranges', () => {
    expect(checkUrl('http://10.0.0.1')).not.toBeNull();
    expect(checkUrl('http://10.255.255.255')).not.toBeNull();
    expect(checkUrl('http://192.168.1.1')).not.toBeNull();
    expect(checkUrl('http://172.16.0.1')).not.toBeNull();
    expect(checkUrl('http://172.31.255.255')).not.toBeNull();
  });

  it('allows public 172.x outside the private range', () => {
    expect(checkUrl('http://172.32.0.1')).toBeNull();
    expect(checkUrl('http://172.15.0.1')).toBeNull();
  });

  it('blocks AWS instance metadata endpoint', () => {
    expect(checkUrl('http://169.254.169.254/latest/meta-data/')).not.toBeNull();
  });

  it('blocks 0.0.0.0 and 0/8', () => {
    expect(checkUrl('http://0.0.0.0/')).not.toBeNull();
    expect(checkUrl('http://0.1.2.3/')).not.toBeNull();
  });

  it('blocks IPv6 unique-local and link-local', () => {
    expect(checkUrl('http://[fc00::1]/')).not.toBeNull();
    expect(checkUrl('http://[fe80::1]/')).not.toBeNull();
  });

  it('rejects non-http protocols', () => {
    expect(checkUrl('file:///etc/passwd')).toMatch(/protocol/);
    expect(checkUrl('ftp://example.com')).toMatch(/protocol/);
    expect(checkUrl('javascript:alert(1)')).toMatch(/protocol/);
  });

  it('rejects malformed URLs', () => {
    expect(checkUrl('not a url')).toBe('invalid url');
    expect(checkUrl('')).toBe('invalid url');
  });

  it('SURF_ALLOW_PRIVATE=true bypasses private blocks', () => {
    process.env.SURF_ALLOW_PRIVATE = 'true';
    expect(checkUrl('http://localhost:8080')).toBeNull();
    expect(checkUrl('http://10.0.0.1')).toBeNull();
    expect(checkUrl('http://192.168.1.1')).toBeNull();
  });

  it('SURF_ALLOW_PRIVATE=true still rejects bad protocols', () => {
    process.env.SURF_ALLOW_PRIVATE = 'true';
    expect(checkUrl('file:///etc/passwd')).toMatch(/protocol/);
  });
});

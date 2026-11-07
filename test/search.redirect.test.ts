import { describe, expect, it, vi } from 'vitest';
import { resolveGoogleResult, resolveGoogleResultUrl } from '../src/search.js';

describe('Google result redirect resolution', () => {
  it('honors a delayed Google-only refresh without fetching the external destination', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('<html><head><meta content="3;url=/goto?url=next&amp;step=2" http-equiv="refresh"></head></html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://duckdb.org/docs/tips' } }));
    const wait = vi.fn(async () => {});
    expect(await resolveGoogleResult('https://www.google.com/goto?url=first', fetchFn, wait))
      .toEqual({ url: 'https://duckdb.org/docs/tips' });
    expect(wait).toHaveBeenCalledWith(3000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1][0])).toBe('https://www.google.com/goto?url=next&step=2');
  });

  it.each([
    ['<meta http-equiv="refresh" content="0;url=http://127.0.0.1/private">', 'verification_required'],
    ['<meta http-equiv="refresh" content="0;url=https://www.google.com.evil.example/goto">', 'verification_required'],
    ['<meta http-equiv="refresh" content="0;url=/sorry/index">', 'verification_required'],
    ['<meta http-equiv="refresh" content="30;url=/goto?url=next">', 'verification_pending'],
    ['<script>location="https://example.org"</script>', 'verification_required'],
  ])('does not execute, bypass or follow an unsafe refresh: %s', async (html, reason) => {
    const fetchFn = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    const wait = vi.fn(async () => {});
    expect(await resolveGoogleResult('https://www.google.com/goto?url=first', fetchFn, wait)).toEqual({ reason });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('bounds cyclic redirects and does not send requests to non-HTTPS Google origins', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/goto?url=first' } }));
    expect(await resolveGoogleResult('https://www.google.com/goto?url=first', fetchFn)).toEqual({ reason: 'redirect_loop' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await resolveGoogleResult('http://www.google.com/goto?url=first', fetchFn)).toEqual({ reason: 'unsupported_google_url' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('keeps direct external URLs without fetching', async () => {
    const fetchFn = vi.fn();
    await expect(resolveGoogleResultUrl('https://example.com/docs', fetchFn as typeof fetch))
      .resolves.toBe('https://example.com/docs');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reads direct targets from legacy Google wrappers', async () => {
    const fetchFn = vi.fn();
    const wrapped = 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpaper';
    await expect(resolveGoogleResultUrl(wrapped, fetchFn as typeof fetch))
      .resolves.toBe('https://example.com/paper');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resolves opaque goto tokens without following the destination', async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/resolved' },
    })) as typeof fetch;
    await expect(resolveGoogleResultUrl('https://www.google.com/goto?url=opaque', fetchFn))
      .resolves.toBe('https://example.com/resolved');
    expect(fetchFn).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects unresolved Google-owned targets', async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://www.google.com/search?q=internal' },
    })) as typeof fetch;
    await expect(resolveGoogleResultUrl('https://www.google.com/goto?url=opaque', fetchFn))
      .resolves.toBeUndefined();
  });
});

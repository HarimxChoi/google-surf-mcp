import { describe, expect, it, vi } from 'vitest';
import { resolveGoogleResultUrl } from '../src/search.js';

describe('Google result redirect resolution', () => {
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

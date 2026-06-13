import { describe, it, expect } from 'vitest';
import { isBlocked, dismissConsent } from '../src/browser.js';
import type { Page } from 'playwright';

describe('isBlocked', () => {
  it('flags /sorry/ and consent URLs as blocked', () => {
    expect(isBlocked('https://www.google.com/sorry/index?continue=foo')).toBe(true);
    expect(isBlocked('https://www.google.com/sorry/?q=bar')).toBe(true);
    expect(isBlocked('https://consent.google.com/m?continue=foo')).toBe(true);
  });

  it('does not flag normal search URLs', () => {
    expect(isBlocked('https://www.google.com/search?q=foo')).toBe(false);
    expect(isBlocked('https://www.google.com/')).toBe(false);
    expect(isBlocked('')).toBe(false);
  });
});

function consentPage(present: Record<string, number>) {
  const clicked: string[] = [];
  const frame = {
    locator: (sel: string) => ({
      first: () => ({
        count: async () => present[sel] ?? 0,
        click: async () => { clicked.push(sel); },
      }),
    }),
  };
  const page = { frames: () => [frame], waitForLoadState: async () => {} } as unknown as Page;
  return { page, clicked };
}

describe('dismissConsent', () => {
  it('clicks Reject all when the consent overlay is present', async () => {
    const { page, clicked } = consentPage({ '#W0wltc': 1, '#L2AGLb': 1 });
    await dismissConsent(page);
    expect(clicked).toEqual(['#W0wltc']);
  });

  it('falls back to Accept all when Reject is absent', async () => {
    const { page, clicked } = consentPage({ '#L2AGLb': 1 });
    await dismissConsent(page);
    expect(clicked).toEqual(['#L2AGLb']);
  });

  it('is a no-op when no consent overlay is present', async () => {
    const { page, clicked } = consentPage({});
    await expect(dismissConsent(page)).resolves.toBeUndefined();
    expect(clicked).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { navigateHome } from '../src/navigate.js';
import { CaptchaError } from '../src/search.js';
import type { Page } from 'playwright';

function mockPage(url: string, gotoMock: any = vi.fn(async () => null)): Page {
  return {
    url: () => url,
    goto: gotoMock,
  } as unknown as Page;
}

describe('navigateHome', () => {
  it('skips goto when already on https://www.google.com/', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com/', goto);
    await navigateHome(page);
    expect(goto).not.toHaveBeenCalled();
  });

  it('skips goto when on https://www.google.com (no trailing slash)', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com', goto);
    await navigateHome(page);
    expect(goto).not.toHaveBeenCalled();
  });

  it('imghp/finance/preferences trigger goto (not treated as home)', async () => {
    const cases = [
      'https://www.google.com/imghp',
      'https://www.google.com/finance/quote/AAPL:NASDAQ',
      'https://www.google.com/preferences',
      'https://www.google.com/maps',
    ];
    for (const url of cases) {
      const goto = vi.fn(async () => null);
      const page = mockPage(url, goto);
      await navigateHome(page);
      expect(goto, `should goto for ${url}`).toHaveBeenCalledOnce();
    }
  });

  it('throws CaptchaError when on /sorry/', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com/sorry/index?continue=foo', goto);
    await expect(navigateHome(page)).rejects.toThrow(CaptchaError);
    expect(goto).not.toHaveBeenCalled();
  });

  it('does not throw on /sorry/ when throwOnBlocked=false', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com/sorry/index', goto);
    await expect(navigateHome(page, { throwOnBlocked: false })).resolves.toBeUndefined();
  });

  it('navigates to home when on a search results page', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com/search?q=test', goto);
    await navigateHome(page);
    expect(goto).toHaveBeenCalledOnce();
    expect(goto.mock.calls[0][0]).toBe('https://www.google.com/');
  });

  it('uses custom timeout', async () => {
    const goto = vi.fn(async () => null);
    const page = mockPage('https://www.google.com/search?q=x', goto);
    await navigateHome(page, { timeout: 5_000 });
    expect(goto).toHaveBeenCalledWith(
      'https://www.google.com/',
      expect.objectContaining({ timeout: 5_000 }),
    );
  });
});

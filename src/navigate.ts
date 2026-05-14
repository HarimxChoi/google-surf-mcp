import type { Page } from 'playwright';
import { isBlocked } from './browser.js';
import { CaptchaError } from './search.js';

export interface NavigateOpts {
  timeout?: number;
  throwOnBlocked?: boolean;
}

export async function navigateHome(
  page: Page,
  opts: NavigateOpts = {},
): Promise<void> {
  const { timeout = 20_000, throwOnBlocked = true } = opts;

  if (isBlocked(page.url())) {
    if (throwOnBlocked) throw new CaptchaError('home');
    return;
  }

  // Skip redundant goto when already at home (avoids ERR_ABORTED).
  const url = page.url();
  if (url === 'https://www.google.com/' || url === 'https://www.google.com') {
    return;
  }

  await page.goto('https://www.google.com/', {
    waitUntil: 'domcontentloaded',
    timeout,
  });
}

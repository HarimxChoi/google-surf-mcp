import { launch, getPage, PROFILE_MAIN } from './browser.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Open a visible Chrome window pointed at Google. Wait until the user solves
// the CAPTCHA and lands on a /search? URL, then close. Profile updates persist
// because the visible context shares profileDir with the runtime context.
export async function recoverFromCaptcha(timeoutMs = 120_000): Promise<void> {
  console.error('[google-surf-mcp] CAPTCHA detected. Opening browser for human resolution...');
  const ctx = await launch({ profileDir: PROFILE_MAIN, headless: false });
  try {
    const page = await getPage(ctx);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (page.url().includes('/search?')) {
        console.error('[google-surf-mcp] Search detected, profile re-warmed.');
        await sleep(2000);
        return;
      }
      await sleep(1500);
    }
    throw new Error(`CAPTCHA not solved within ${Math.round(timeoutMs / 1000)}s`);
  } finally {
    await ctx.close();
  }
}

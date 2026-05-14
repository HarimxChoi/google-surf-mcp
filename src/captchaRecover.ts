import { launch, getPage, PROFILE_MAIN, isBlocked } from './browser.js';
import { CaptchaError } from './search.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Module-level mutex: two simultaneous recoveries against PROFILE_MAIN would
// collide on SingletonLock.
let recoveryInFlight: Promise<void> | null = null;

export async function recoverFromCaptcha(timeoutMs = 120_000): Promise<void> {
  if (recoveryInFlight) return recoveryInFlight;

  recoveryInFlight = (async () => {
    const ctx = await launch({ profileDir: PROFILE_MAIN, headless: false });
    try {
      const page = await getPage(ctx);
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const u = page.url();
        // real /search? page, not /sorry/?continue=...search?... false-positive
        if (u.includes('/search?') && !isBlocked(u)) {
          await sleep(2000);
          return;
        }
        await sleep(1500);
      }
      throw new Error(`captcha not solved within ${Math.round(timeoutMs / 1000)}s`);
    } finally {
      // ctx.close() can throw if user closed the window manually; swallow it.
      await ctx.close().catch(() => {});
    }
  })();

  try {
    await recoveryInFlight;
  } finally {
    recoveryInFlight = null;
  }
}

export async function withCaptchaFallback<T>(
  op: () => Promise<T>,
  beforeRecover?: () => Promise<void>,
): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!(e instanceof CaptchaError)) throw e;
    console.error('[google-surf-mcp] captcha detected, opening browser...');
    if (beforeRecover) await beforeRecover();
    await recoverFromCaptcha();
    console.error('[google-surf-mcp] captcha cleared, retrying...');
    return await op();
  }
}

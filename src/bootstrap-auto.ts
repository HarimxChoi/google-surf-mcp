import { launch, getPage, PROFILE_MAIN, profileExists, isBlocked } from './browser.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function bootstrapAuto() {
  console.error(`profile: ${PROFILE_MAIN}`);
  if (profileExists()) {
    console.error('profile already exists, skipping');
    return;
  }

  console.error('opening Chrome (headed) for automated bootstrap...');
  const ctx = await launch({ profileDir: PROFILE_MAIN, headless: false });
  try {
    const page = await getPage(ctx);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (isBlocked(page.url())) throw new Error('blocked at home page');
    await sleep(800);

    const sb = page.locator('textarea[name="q"], input[name="q"]').first();
    await sb.click();
    await sleep(200);
    await page.keyboard.type('hello world', { delay: 60 });
    await sleep(300);
    await page.keyboard.press('Enter');

    await page.waitForURL(/\/search\?/, { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
    if (isBlocked(page.url())) throw new Error('blocked after search');

    await sleep(2000);
    console.error('bootstrap-auto: search succeeded, profile warmed');
  } finally {
    await ctx.close();
  }
}

bootstrapAuto()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('failed:', e.message);
    process.exit(1);
  });

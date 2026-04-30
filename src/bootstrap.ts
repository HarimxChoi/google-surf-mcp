import { launch, getPage, PROFILE_MAIN, profileExists } from './browser.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TIMEOUT_MIN = 10;

async function bootstrap() {
  console.error(`[bootstrap] profile: ${PROFILE_MAIN}`);

  if (profileExists()) {
    console.error('[bootstrap] profile exists, validating...');
    const ctx = await launch({ profileDir: PROFILE_MAIN, headless: true });
    try {
      const page = await getPage(ctx);
      await page.goto('https://www.google.com/search?q=test', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const blocked = page.url().includes('/sorry/');
      console.error(blocked ? '[bootstrap] CAPTCHA, need visible mode' : '[bootstrap] OK');
      if (!blocked) return;
    } finally {
      await ctx.close();
    }
  }

  console.error(`[bootstrap] opening visible Chrome. Run one search within ${TIMEOUT_MIN} min.`);
  const ctx = await launch({ profileDir: PROFILE_MAIN, headless: false });

  try {
    const page = await getPage(ctx);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MIN * 60_000) {
      if (page.url().includes('/search?')) {
        console.error('[bootstrap] search detected, persisting');
        await sleep(2000);
        return;
      }
      await sleep(1500);
    }
    throw new Error('timeout');
  } finally {
    await ctx.close();
  }
}

bootstrap()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('[bootstrap] failed:', e.message);
    process.exit(1);
  });

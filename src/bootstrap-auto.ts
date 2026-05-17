import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { launch, getPage, PROFILE_MAIN, profileExists, isBlocked } from './browser.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

let inFlight: Promise<void> | null = null;

export interface AutoBootstrapOptions {
  headless?: boolean;
  log?: (msg: string) => void;
}

export function autoBootstrap(opts: AutoBootstrapOptions = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (profileExists()) return Promise.resolve();
  inFlight = runOnce(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function runOnce(opts: AutoBootstrapOptions): Promise<void> {
  const headless = opts.headless ?? (process.env.SURF_HEADLESS !== 'false');
  const log = opts.log ?? ((m) => console.error(m));
  log(`[bootstrap] profile: ${PROFILE_MAIN}`);
  log(`[bootstrap] no profile found, auto-warming (headless=${headless}, ~30s)...`);

  const ctx = await launch({ profileDir: PROFILE_MAIN, headless });
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
    log('[bootstrap] profile warmed successfully');
  } finally {
    await ctx.close().catch(() => {});
  }
}

function isInvokedDirectly(): boolean {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  autoBootstrap({ headless: true })
    .then(() => process.exit(0))
    .catch((e: Error) => { console.error('[bootstrap] failed:', e.message); process.exit(1); });
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, getPage, PROFILE_MAIN, isBlocked } from './browser.js';
import { CaptchaError } from './search.js';
import type { CaptchaMode } from './captchaMode.js';
import { osNotify } from './notify.js';
import { HumanlikeBehavior, generateBehaviorParams } from './humanlike.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));

const NOTIFY_TITLE = 'google-surf-mcp: CAPTCHA';
const NOTIFY_BODY = 'Google CAPTCHA detected. A browser window will open — solve it to resume.';

function readDevToolsPort(profileDir: string): string | null {
  const p = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(p)) return null;
  try {
    const first = readFileSync(p, 'utf8').split('\n')[0]?.trim();
    return first || null;
  } catch { return null; }
}

function remoteDebugGuidance(): string {
  const port = readDevToolsPort(PROFILE_MAIN);
  const portHint = port
    ? `port ${port} (from ${PROFILE_MAIN}/DevToolsActivePort)`
    : `read <profileDir>/DevToolsActivePort for the port`;
  return `CAPTCHA on headless server. Forward ${portHint} (e.g. ssh -L 9222:localhost:<port> host) and open chrome://inspect in your local Chrome to solve, then retry.`;
}

export interface RecoverOptions {
  mode?: CaptchaMode;
  timeoutMs?: number;
  seedQuery?: string;
}

let recoveryInFlight: Promise<void> | null = null;

function parseMs(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function recoverFromCaptcha(opts: RecoverOptions | number = {}): Promise<void> {
  const o: RecoverOptions = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const mode: CaptchaMode = o.mode ?? 'notify_spawn';
  const timeoutMs = o.timeoutMs ?? parseMs(process.env.SURF_CAPTCHA_TIMEOUT_MS, 180_000);
  const seedQuery = (o.seedQuery ?? '').trim() || 'hello world';

  if (mode === 'cloud_fail_fast') {
    throw new CaptchaError('cloud-mode: tier-3 unavailable');
  }
  if (mode === 'remote_debug') {
    const guidance = remoteDebugGuidance();
    console.error(`[google-surf-mcp] ${guidance}`);
    throw new CaptchaError('remote-debug: human action required via DevTools', guidance);
  }

  if (recoveryInFlight) return recoveryInFlight;

  recoveryInFlight = (async () => {
    if (mode === 'notify_spawn') {
      await osNotify(NOTIFY_TITLE, NOTIFY_BODY).catch(() => {});
    }
    const ctx = await launch({ profileDir: PROFILE_MAIN, headless: false, blockResources: false });
    const behavior = new HumanlikeBehavior(generateBehaviorParams(), 'inline');
    try {
      const page = await getPage(ctx);
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      try { await (page as { bringToFront?: () => Promise<void> }).bringToFront?.(); } catch {}
      // headed often isn't served /sorry/ even when headless was; seed the real query to reach /search?
      if (!isBlocked(page.url())) {
        try {
          await sleep(rand(600, 1400));
          const sb = page.locator('textarea[name="q"], input[name="q"]').first();
          await sb.click();
          await sleep(rand(150, 450));
          await behavior.typeQuery(page, seedQuery);
          await behavior.submitQuery(page);
        } catch {}
      }
      const start = Date.now();
      let browsed = false;
      while (Date.now() - start < timeoutMs) {
        const u = page.url();
        if (isBlocked(u)) {
          browsed = false;
          await sleep(1500);
          continue;
        }
        if (u.includes('/search?')) {
          if (!browsed) {
            browsed = true;
            console.error('[google-surf-mcp] captcha cleared; running humanlike browse before close');
            await behavior.visitRandomResults(page, randInt(1, 3)).catch(() => {});
            continue;
          }
          return;
        }
        await sleep(1500);
      }
      throw new Error(`captcha not solved within ${Math.round(timeoutMs / 1000)}s`);
    } finally {
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
  mode: CaptchaMode = 'notify_spawn',
): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!(e instanceof CaptchaError)) throw e;
    console.error('[google-surf-mcp] captcha detected, recovering...');
    if (beforeRecover) await beforeRecover();
    await recoverFromCaptcha({ mode });
    console.error('[google-surf-mcp] captcha cleared, retrying...');
    return await op();
  }
}

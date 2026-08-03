import { readFile } from 'node:fs/promises';
import { launch, getPage, PROFILE_MAIN, profileExists } from './browser.js';

export interface CookieJson {
  domain?: string;
  hostOnly?: boolean;
  name?: string;
  value?: string;
  path?: string;
  expirationDate?: number;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  session?: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Cookie-Editor exports an array of cookies with `expirationDate` (Unix
// seconds). Normalize to Playwright's addCookies shape. Missing expirations
// become session cookies.
export function normalizeCookies(arr: CookieJson[]) {
  return arr
    .filter((c) => c && typeof c.name === 'string' && c.name && typeof c.value === 'string')
    .map((c) => {
      const exp = (c.expirationDate ?? c.expires ?? 0) as number;
      const sameSite = (['Strict', 'Lax', 'None'] as const).includes((c.sameSite ?? '') as never)
        ? (c.sameSite as 'Strict' | 'Lax' | 'None')
        : 'Lax';
      return {
        name: c.name!,
        value: c.value!,
        domain: c.domain || undefined,
        path: c.path || '/',
        ...(Number.isFinite(exp) && exp > 0 ? { expires: exp } : {}),
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite,
      };
    });
}

// Warm the main profile from a Cookie-Editor JSON export (SURF_COOKIES_FILE).
// Creates the profile headlessly, injects cookies, hits google.com once to
// commit them to disk. Returns false when the env var is unset or the file
// cannot be read. Throws on invalid JSON / injection failure.
export async function warmProfileFromCookiesFile(): Promise<boolean> {
  const file = process.env.SURF_COOKIES_FILE;
  if (!file) return false;
  if (profileExists()) return true;

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`SURF_COOKIES_FILE: cannot read ${file}: ${(e as Error).message}`);
  }
  let arr: CookieJson[];
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SURF_COOKIES_FILE: invalid JSON in ${file}: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`SURF_COOKIES_FILE: expected a non-empty array of cookies in ${file}`);
  }

  const cookies = normalizeCookies(arr);
  console.error(`[cookies] injecting ${cookies.length} cookies from ${file}`);
  const ctx = await launch({ profileDir: PROFILE_MAIN, headless: true, blockResources: false });
  try {
    await ctx.addCookies(cookies);
    const page = await getPage(ctx);
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    // Give Chromium a beat to flush cookies to the profile before closing.
    await sleep(2000);
  } finally {
    await ctx.close();
  }
  return profileExists();
}

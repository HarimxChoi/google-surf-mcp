import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export { detectChrome as detectChromePath } from './browser.js';

export interface Config {
  chromePath?: string;
  profileRoot: string;
  locale: string;
  timezone: string;
  headless: boolean;
  idleCloseMs: number;
  allowPrivate: boolean;
  humanlikeMode: 'off' | 'background' | 'inline';
  cacheRoot: string;
  cacheTtlSearchMs: number;
  cacheMaxEntries: number;
  rateLimitPerMin: number;

  // Composite cloud flag: enables insecureTls + noSandbox + pool disabled +
  // tier-3 fail-fast. Cascade itself runs unchanged in cloud mode.
  cloudMode: boolean;
  remoteDebug: boolean;
  useStealth: boolean;
  insecureTls: boolean;
  noSandbox: boolean;
  cascadeDisabled: boolean;
}

function parseBool(v: string | undefined, defaultVal: boolean): boolean {
  if (v === undefined) return defaultVal;
  return v.toLowerCase() === 'true';
}

function parseInt0(v: string | undefined, defaultVal: number, min: number, max: number): number {
  if (v === undefined) return defaultVal;
  const n = Number(v);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseTz(v: string | undefined): string {
  if (!v) {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }
  // Validate IANA tz at startup; fall back instead of throwing at launch time.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch {
    console.error(`[config] invalid SURF_TZ='${v}', falling back to system tz`);
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }
}

function parseHumanlike(v: string | undefined): 'off' | 'background' | 'inline' {
  if (v === 'background' || v === 'inline') return v;
  return 'off';
}

function parseChromePath(v: string | undefined): string | undefined {
  return v || undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const profileRoot = env.SURF_PROFILE_ROOT || join(homedir(), '.google-surf-mcp');
  const cloudMode = parseBool(env.SURF_CLOUD_MODE, false);

  return {
    chromePath: parseChromePath(env.CHROME_PATH),
    profileRoot: resolve(profileRoot),
    locale: env.SURF_LOCALE || 'en-US',
    timezone: parseTz(env.SURF_TZ),
    headless: parseBool(env.SURF_HEADLESS, true),
    idleCloseMs: parseInt0(env.SURF_IDLE_CLOSE_MS, 30_000, 0, 24 * 60 * 60_000),
    allowPrivate: parseBool(env.SURF_ALLOW_PRIVATE, false),

    humanlikeMode: parseHumanlike(env.SURF_HUMANLIKE_MODE),
    cacheRoot: env.SURF_CACHE_ROOT || join(profileRoot, 'cache'),
    cacheTtlSearchMs: parseInt0(env.SURF_CACHE_TTL_SEARCH_MS, 24 * 60 * 60_000, 0, 7 * 24 * 60 * 60_000),
    cacheMaxEntries: parseInt0(env.SURF_CACHE_MAX_ENTRIES, 1000, 10, 100_000),
    rateLimitPerMin: parseInt0(env.SURF_RATE_LIMIT_PER_MIN, 10, 1, 600),

    cloudMode,
    remoteDebug: parseBool(env.SURF_REMOTE_DEBUG, false),
    useStealth: parseBool(env.SURF_USE_STEALTH, true),
    insecureTls: parseBool(env.SURF_INSECURE_TLS, cloudMode),
    noSandbox: parseBool(env.SURF_NO_SANDBOX, cloudMode),
    cascadeDisabled: parseBool(env.SURF_CASCADE_DISABLED, false),
  };
}


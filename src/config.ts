import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cascadeStatePath } from './cascadeStore.js';
import { DEFAULT_RESEARCH_VECTOR_MODEL } from './research/dense.js';

export { detectChrome as detectChromePath } from './browser.js';

export type SearchProviderMode = 'browser' | 'searchapi' | 'fallback';
export type BrowserEngine = 'auto' | 'native' | 'playwright';
export type ResearchRetrievalMode = 'live' | 'hybrid';

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
  searchProvider: SearchProviderMode;
  scholarProvider: SearchProviderMode;
  browserEngine: BrowserEngine;
  searchApiKey?: string;
  extractMaxChars: number;
  extractOcr: boolean;
  researchEnabled: boolean;
  researchRetrievalMode: ResearchRetrievalMode;
  researchRoot: string;
  researchVectorModel?: string;
  researchVectorLowMemory: boolean;
  researchVectorThreads: number;
  researchRepoAuto: boolean;
  researchRepoAutoMaxMb: number;
  researchRepoAutoMaxFiles: number;
  researchBrokerIdleMs: number;
  researchReadConcurrency: number;
  researchQueryTimeoutMs: number;

  // Composite cloud flag: enables insecureTls + noSandbox + pool disabled +
  // tier-3 fail-fast. Cascade itself runs unchanged in cloud mode.
  cloudMode: boolean;
  remoteDebug: boolean;
  useStealth: boolean;
  insecureTls: boolean;
  noSandbox: boolean;
  cascadeDisabled: boolean;

  telemetryEnabled: boolean;
  telemetryRoot: string;

  selfHealingEnabled: boolean;
  selfHealingFile: string;
  cascadeStateFile: string;
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
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }
  // Validate IANA tz at startup; fall back instead of throwing at launch time.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch {
    console.error(`[config] invalid SURF_TZ='${v}', falling back to system tz`);
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }
}

function parseHumanlike(v: string | undefined): 'off' | 'background' | 'inline' {
  if (v === 'off' || v === 'inline') return v;
  return 'background';
}

function parseProvider(v: string | undefined): SearchProviderMode {
  return v === 'searchapi' || v === 'fallback' ? v : 'browser';
}

function parseBrowserEngine(v: string | undefined): BrowserEngine {
  return v === 'native' || v === 'playwright' ? v : 'auto';
}

function parseResearchRetrievalMode(v: string | undefined): ResearchRetrievalMode {
  return v === 'live' ? 'live' : 'hybrid';
}

function parseResearchVectorModel(v: string | undefined): string | undefined {
  const model = v?.trim();
  return model?.toLowerCase() === 'off' ? undefined : model || DEFAULT_RESEARCH_VECTOR_MODEL;
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
    searchProvider: parseProvider(env.SURF_SEARCH_PROVIDER),
    scholarProvider: parseProvider(env.SURF_SCHOLAR_PROVIDER),
    browserEngine: parseBrowserEngine(env.SURF_BROWSER_ENGINE),
    searchApiKey: env.SEARCH_API?.trim()
      || env.SEARCHAPI_API_KEY?.trim()
      || env.SURF_SEARCH_API_KEY?.trim()
      || undefined,
    extractMaxChars: parseInt0(env.SURF_EXTRACT_MAX_CHARS, 50_000, 200, 50_000),
    extractOcr: parseBool(env.SURF_EXTRACT_OCR, false),
    researchEnabled: parseBool(env.SURF_RESEARCH, true),
    researchRetrievalMode: parseResearchRetrievalMode(env.SURF_RETRIEVAL_MODE),
    researchRoot: resolve(env.SURF_RESEARCH_ROOT || join(profileRoot, 'research')),
    researchVectorModel: parseResearchVectorModel(
      env.SURF_RESEARCH_VECTOR_MODEL ?? env.SURF_RESEARCH_DENSE_MODEL,
    ),
    researchVectorLowMemory: parseBool(env.SURF_RESEARCH_VECTOR_LOW_MEMORY, true),
    researchVectorThreads: parseInt0(env.SURF_RESEARCH_VECTOR_THREADS, 4, 1, 16),
    researchRepoAuto: parseBool(env.SURF_RESEARCH_REPO_AUTO, true),
    researchRepoAutoMaxMb: parseInt0(env.SURF_RESEARCH_REPO_AUTO_MAX_MB, 20, 1, 500),
    researchRepoAutoMaxFiles: parseInt0(env.SURF_RESEARCH_REPO_AUTO_MAX_FILES, 2_000, 10, 20_000),
    researchBrokerIdleMs: parseInt0(env.SURF_RESEARCH_BROKER_IDLE_MS, 60_000, 100, 60 * 60_000),
    researchReadConcurrency: parseInt0(env.SURF_RESEARCH_READ_CONCURRENCY, 4, 1, 16),
    researchQueryTimeoutMs: parseInt0(env.SURF_RESEARCH_QUERY_TIMEOUT_MS, 30_000, 1_000, 10 * 60_000),

    cloudMode,
    remoteDebug: parseBool(env.SURF_REMOTE_DEBUG, false),
    useStealth: parseBool(env.SURF_USE_STEALTH, true),
    insecureTls: parseBool(env.SURF_INSECURE_TLS, cloudMode),
    noSandbox: parseBool(env.SURF_NO_SANDBOX, cloudMode),
    cascadeDisabled: parseBool(env.SURF_CASCADE_DISABLED, false),

    telemetryEnabled: parseBool(env.SURF_TELEMETRY, false),
    telemetryRoot: env.SURF_TELEMETRY_ROOT || join(profileRoot, 'telemetry'),

    selfHealingEnabled: parseBool(env.SURF_SELF_HEALING, true),
    selfHealingFile: env.SURF_SELF_HEALING_FILE || join(profileRoot, '.heal', 'strategy-order.json'),
    cascadeStateFile: env.SURF_CASCADE_STATE_FILE || cascadeStatePath(profileRoot),
  };
}

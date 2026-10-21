// OrcaRouter origin and path resolution.
//
// Authentication and inference use *different* public origins and there is no
// way to derive one from the other by swapping a hostname or appending `/v1`:
// the relay lives at https://api.orcarouter.ai/v1 while the auth API lives at
// https://www.orcarouter.ai/api/v1/auth. https://api.orcarouter.ai/v1/auth/keys
// is a 404, so every auth call must be built from `authBase`.

export const DEFAULT_AUTH_BASE = 'https://www.orcarouter.ai';
export const DEFAULT_API_BASE = 'https://api.orcarouter.ai';

/** Fixed paths on the auth origin. */
export const AUTH_PATHS = {
  authorize: '/auth',
  keys: '/api/v1/auth/keys',
  deviceCode: '/api/v1/auth/device/code',
  deviceToken: '/api/v1/auth/device/token',
  discovery: '/.well-known/openid-configuration',
} as const;

/** The relay path suffix, appended to the API origin only. */
export const API_V1_PATH = '/v1';

export interface OrcaEndpoints {
  authBase: string;
  apiBase: string;
  authorizeUrl: string;
  keysUrl: string;
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  chatCompletionsUrl: string;
  modelsUrl: string;
}

export type OrcaEnv = Record<string, string | undefined>;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Normalize a configured origin. Remote origins must be HTTPS; plain HTTP is
 * only tolerated for loopback development, matching the callback_url rules the
 * consent endpoint itself enforces.
 */
function normalizeOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw new Error(`${label} must use HTTPS for non-loopback origins`);
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain userinfo`);
  if (url.search || url.hash) throw new Error(`${label} must not contain a query or fragment`);

  // Preserve any self-hosted path prefix, drop the trailing slash.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Resolve both origins. `ORCA_BASE_URL` is the shared self-hosted fallback;
 * the explicit `ORCA_AUTH_BASE_URL` / `ORCA_API_BASE_URL` overrides win over it.
 */
export function resolveEndpoints(env: OrcaEnv = process.env): OrcaEndpoints {
  const shared = env.ORCA_BASE_URL?.trim() || undefined;
  const authBase = normalizeOrigin(
    env.ORCA_AUTH_BASE_URL?.trim() || shared || DEFAULT_AUTH_BASE,
    'ORCA_AUTH_BASE_URL',
  );
  const apiBase = normalizeOrigin(
    env.ORCA_API_BASE_URL?.trim() || shared || DEFAULT_API_BASE,
    'ORCA_API_BASE_URL',
  );
  return {
    authBase,
    apiBase,
    authorizeUrl: `${authBase}${AUTH_PATHS.authorize}`,
    keysUrl: `${authBase}${AUTH_PATHS.keys}`,
    deviceCodeUrl: `${authBase}${AUTH_PATHS.deviceCode}`,
    deviceTokenUrl: `${authBase}${AUTH_PATHS.deviceToken}`,
    chatCompletionsUrl: `${apiBase}${API_V1_PATH}/chat/completions`,
    modelsUrl: `${apiBase}${API_V1_PATH}/models`,
  };
}

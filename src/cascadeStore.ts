import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StealthMode } from './cascade.js';

interface PersistedCascade {
  schema: 1;
  mode: StealthMode;
  updatedAt: string;
}

// Long enough that a restart does not repay the captcha, short enough that the
// cheaper bare-playwright tier is retried once a day.
export const CASCADE_TTL_MS = 24 * 60 * 60_000;

export function cascadeStatePath(profileRoot: string): string {
  return join(profileRoot, '.heal', 'cascade.json');
}

export function loadCascadeMode(
  file: string,
  fallback: StealthMode,
  now: number = Date.now(),
): StealthMode {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedCascade>;
    if (parsed?.schema !== 1) return fallback;
    if (parsed.mode !== 'on' && parsed.mode !== 'off') return fallback;
    const at = Date.parse(parsed.updatedAt ?? '');
    if (!Number.isFinite(at) || now - at > CASCADE_TTL_MS) return fallback;
    return parsed.mode;
  } catch {
    return fallback;
  }
}

export function saveCascadeMode(file: string, mode: StealthMode, now: number = Date.now()): void {
  const payload: PersistedCascade = { schema: 1, mode, updatedAt: new Date(now).toISOString() };
  const tmp = `${file}.tmp`;
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {}
}

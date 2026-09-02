import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export const NATIVE_BROWSER_BROKER_PROTOCOL = 1;

export interface NativeBrowserBrokerConfig {
  executablePath: string;
  profileDir: string;
  idleMs: number;
  selfHealingEnabled: boolean;
  selfHealingFile: string;
}

export function normalizeNativeBrowserBrokerConfig(
  config: NativeBrowserBrokerConfig,
): NativeBrowserBrokerConfig {
  return {
    ...config,
    executablePath: resolve(config.executablePath),
    profileDir: resolve(config.profileDir),
    selfHealingFile: resolve(config.selfHealingFile),
    idleMs: Math.max(0, Math.floor(config.idleMs)),
  };
}

function profileHash(profileDir: string): string {
  const normalized = process.platform === 'win32'
    ? resolve(profileDir).toLowerCase()
    : resolve(profileDir);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 20);
}

export function nativeBrowserBrokerConfigHash(config: NativeBrowserBrokerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeNativeBrowserBrokerConfig(config)))
    .digest('hex');
}

export function nativeBrowserBrokerEndpoint(profileDir: string): string {
  const name = `google-surf-browser-${profileHash(profileDir)}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  return resolve(tmpdir(), `${name}.sock`);
}

export function nativeBrowserBrokerDirectory(profileDir: string): string {
  return resolve(`${profileDir}.broker`);
}

export function nativeBrowserBrokerTokenPath(profileDir: string): string {
  return resolve(nativeBrowserBrokerDirectory(profileDir), 'token');
}

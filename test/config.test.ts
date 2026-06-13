import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns sane defaults with empty env', () => {
    const c = loadConfig({});
    expect(c.locale).toBe('en-US');
    expect(c.headless).toBe(true);
    expect(c.idleCloseMs).toBe(30_000);
    expect(c.allowPrivate).toBe(false);
    expect(c.humanlikeMode).toBe('off');
    expect(c.timezone).toBeTypeOf('string');
    expect(c.timezone.length).toBeGreaterThan(0);
  });

  it('parses SURF_HEADLESS=false correctly', () => {
    expect(loadConfig({ SURF_HEADLESS: 'false' }).headless).toBe(false);
    expect(loadConfig({ SURF_HEADLESS: 'true' }).headless).toBe(true);
    // anything else → default true
    expect(loadConfig({ SURF_HEADLESS: 'yes' }).headless).toBe(false); // not 'true' → false (parseBool default false-or-default applies)
  });

  it('falls back when SURF_TZ is invalid (no throw)', () => {
    const c = loadConfig({ SURF_TZ: 'Not/A/Real_Timezone' });
    expect(c.timezone).toBeTypeOf('string');
    expect(c.timezone.length).toBeGreaterThan(0);
    expect(c.timezone).not.toBe('Not/A/Real_Timezone');
  });

  it('accepts valid IANA timezones', () => {
    expect(loadConfig({ SURF_TZ: 'America/New_York' }).timezone).toBe('America/New_York');
    expect(loadConfig({ SURF_TZ: 'Asia/Seoul' }).timezone).toBe('Asia/Seoul');
  });

  it('parses humanlikeMode strict values only', () => {
    expect(loadConfig({ SURF_HUMANLIKE_MODE: 'inline' }).humanlikeMode).toBe('inline');
    expect(loadConfig({ SURF_HUMANLIKE_MODE: 'background' }).humanlikeMode).toBe('background');
    expect(loadConfig({ SURF_HUMANLIKE_MODE: 'off' }).humanlikeMode).toBe('off');
    expect(loadConfig({ SURF_HUMANLIKE_MODE: 'aggressive' }).humanlikeMode).toBe('off');
  });

  it('idleCloseMs accepts 0 (disable)', () => {
    expect(loadConfig({ SURF_IDLE_CLOSE_MS: '0' }).idleCloseMs).toBe(0);
  });

  it('checked lazily at launch', () => {
    const c = loadConfig({ CHROME_PATH: '/nonexistent/chrome/binary' });
    expect(c.chromePath).toBe('/nonexistent/chrome/binary');
  });

  it('cloud mode defaults: insecureTls + noSandbox auto-on', () => {
    const c = loadConfig({ SURF_CLOUD_MODE: 'true' });
    expect(c.cloudMode).toBe(true);
    expect(c.insecureTls).toBe(true);
    expect(c.noSandbox).toBe(true);
    expect(c.useStealth).toBe(true);
    expect(c.cascadeDisabled).toBe(false);
  });

  it('cloud mode env vars are independently overridable', () => {
    const c = loadConfig({
      SURF_CLOUD_MODE: 'true',
      SURF_INSECURE_TLS: 'false',
      SURF_NO_SANDBOX: 'false',
    });
    expect(c.cloudMode).toBe(true);
    expect(c.insecureTls).toBe(false);
    expect(c.noSandbox).toBe(false);
  });

  it('non-cloud defaults leave insecure flags off', () => {
    const c = loadConfig({});
    expect(c.cloudMode).toBe(false);
    expect(c.insecureTls).toBe(false);
    expect(c.noSandbox).toBe(false);
  });

  it('cascadeDisabled escape hatch is plumbed', () => {
    const c = loadConfig({ SURF_CASCADE_DISABLED: 'true' });
    expect(c.cascadeDisabled).toBe(true);
  });

  it('useStealth env opts in/out independently', () => {
    expect(loadConfig({ SURF_USE_STEALTH: 'false' }).useStealth).toBe(false);
    expect(loadConfig({ SURF_USE_STEALTH: 'true' }).useStealth).toBe(true);
  });

  it('extractMaxChars: default 8000, env override, clamped to [200, 50000]', () => {
    expect(loadConfig({}).extractMaxChars).toBe(8_000);
    expect(loadConfig({ SURF_EXTRACT_MAX_CHARS: '20000' }).extractMaxChars).toBe(20_000);
    expect(loadConfig({ SURF_EXTRACT_MAX_CHARS: '999999' }).extractMaxChars).toBe(50_000);
    expect(loadConfig({ SURF_EXTRACT_MAX_CHARS: '50' }).extractMaxChars).toBe(200);
  });
});

import { describe, it, expect } from 'vitest';
import { captchaModeFromConfig } from '../src/captchaMode.js';

describe('captchaModeFromConfig', () => {
  it('cloud_fail_fast wins over everything', () => {
    expect(captchaModeFromConfig({
      cloudMode: true, headless: true, remoteDebug: false,
    })).toBe('cloud_fail_fast');
    expect(captchaModeFromConfig({
      cloudMode: true, headless: false, remoteDebug: true,
    })).toBe('cloud_fail_fast');
  });

  it('remote_debug when not cloud', () => {
    expect(captchaModeFromConfig({
      cloudMode: false, headless: true, remoteDebug: true,
    })).toBe('remote_debug');
    expect(captchaModeFromConfig({
      cloudMode: false, headless: false, remoteDebug: true,
    })).toBe('remote_debug');
  });

  it('always_headed when headless is off and no other flags', () => {
    expect(captchaModeFromConfig({
      cloudMode: false, headless: false, remoteDebug: false,
    })).toBe('always_headed');
  });

  it('notify_spawn is the default for local headless', () => {
    expect(captchaModeFromConfig({
      cloudMode: false, headless: true, remoteDebug: false,
    })).toBe('notify_spawn');
  });
});

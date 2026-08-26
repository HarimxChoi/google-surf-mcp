import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bareLaunch: vi.fn(),
  extraLaunch: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: {
    executablePath: () => process.execPath,
    launchPersistentContext: mocks.bareLaunch,
  },
}));

vi.mock('playwright-extra', () => ({
  chromium: {
    use: vi.fn(),
    launchPersistentContext: mocks.extraLaunch,
  },
}));

vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: () => ({}) }));

const context = { route: vi.fn() };

describe('launch sandbox', () => {
  beforeEach(() => {
    mocks.bareLaunch.mockReset().mockResolvedValue(context);
    mocks.extraLaunch.mockReset().mockResolvedValue(context);
    delete process.env.SURF_CLOUD_MODE;
    delete process.env.SURF_NO_SANDBOX;
  });

  afterEach(() => {
    delete process.env.SURF_CLOUD_MODE;
    delete process.env.SURF_NO_SANDBOX;
  });

  it('enables the Chromium sandbox by default', async () => {
    const { launch } = await import('../src/browser.js');
    await launch({ profileDir: 'profile', stealth: false });

    expect(mocks.bareLaunch).toHaveBeenCalledWith('profile', expect.objectContaining({
      chromiumSandbox: true,
    }));
    const args = mocks.bareLaunch.mock.calls[0][1].args;
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-blink-features=AutomationControlled');
    expect(args).not.toContain('--fingerprinting-canvas-image-data-noise');
    expect(args).not.toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  it('disables the Chromium sandbox only when requested', async () => {
    const { launch } = await import('../src/browser.js');
    await launch({ profileDir: 'profile', stealth: false, noSandbox: true });

    expect(mocks.bareLaunch).toHaveBeenCalledWith('profile', expect.objectContaining({
      chromiumSandbox: false,
    }));
  });
});

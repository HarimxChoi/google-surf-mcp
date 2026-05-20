import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const launchPersistentContext = vi.fn();
vi.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: (...args: unknown[]) => launchPersistentContext(...args),
    executablePath: () => '/fake/chrome',
  },
}));
vi.mock('playwright-extra', () => ({
  chromium: {
    use: () => {},
    launchPersistentContext: (...args: unknown[]) => launchPersistentContext(...args),
  },
}));

import { isBlocked, launch, waitForLockReleased } from '../src/browser.js';

describe('isBlocked', () => {
  it('flags /sorry/ URLs as blocked', () => {
    expect(isBlocked('https://www.google.com/sorry/index?continue=foo')).toBe(true);
    expect(isBlocked('https://www.google.com/sorry/?q=bar')).toBe(true);
  });

  it('does not flag normal search URLs', () => {
    expect(isBlocked('https://www.google.com/search?q=foo')).toBe(false);
    expect(isBlocked('https://www.google.com/')).toBe(false);
    expect(isBlocked('')).toBe(false);
  });
});

describe('waitForLockReleased', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'surf-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('waits until lock disappears', async () => {
    writeFileSync(join(dir, 'SingletonLock'), 'pid');
    setTimeout(() => rmSync(join(dir, 'SingletonLock')), 150);
    const t0 = Date.now();
    await waitForLockReleased(dir, 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns when bound elapses even if lock persists', async () => {
    writeFileSync(join(dir, 'SingletonLock'), 'pid');
    const t0 = Date.now();
    await waitForLockReleased(dir, 200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('launch() stale-lock retry', () => {
  let dir: string;
  const fakeCtx = { route: vi.fn(async () => {}) };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surf-launch-'));
    launchPersistentContext.mockReset();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('retries once on ProcessSingleton, clearing locks between attempts', async () => {
    writeFileSync(join(dir, 'SingletonLock'), 'pid');
    let attempt = 0;
    launchPersistentContext.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.');
      }
      return fakeCtx;
    });

    const ctx = await launch({ profileDir: dir });
    expect(ctx).toBe(fakeCtx);
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a different error', async () => {
    launchPersistentContext.mockImplementation(async () => {
      throw new Error('Executable not found at /fake/chrome');
    });

    await expect(launch({ profileDir: dir })).rejects.toThrow(/Executable not found/);
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it('propagates ProcessSingleton when retry also fails', async () => {
    writeFileSync(join(dir, 'SingletonLock'), 'pid');
    launchPersistentContext.mockImplementation(async () => {
      throw new Error('Failed to create a ProcessSingleton');
    });

    await expect(launch({ profileDir: dir })).rejects.toThrow(/ProcessSingleton/);
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
  });
});

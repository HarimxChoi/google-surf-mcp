import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
const original = process.env.SURF_PROFILE_ROOT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'surf-orphans-'));
  process.env.SURF_PROFILE_ROOT = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.SURF_PROFILE_ROOT;
  else process.env.SURF_PROFILE_ROOT = original;
});

const mkdir = (name: string) => {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'Preferences'), '{}');
  return p;
};

describe('cleanupOrphanProfiles', () => {
  it('removes worker dirs of dead pids, keeps this process and non-worker dirs', async () => {
    // PROFILE_ROOT is read at module load
    vi.resetModules();
    const { cleanupOrphanProfiles } = await import('../src/browser.js');

    const dead = mkdir('w999999_0');
    const deadTwo = mkdir('w999999_1');
    const mine = mkdir(`w${process.pid}_0`);
    const main = mkdir('main');
    const seed = mkdir('seed');
    const legacy = mkdir('w0');

    const removed = await cleanupOrphanProfiles();

    expect(removed).toBe(2);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(deadTwo)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(main)).toBe(true);
    expect(existsSync(seed)).toBe(true);
    expect(existsSync(legacy)).toBe(true);
  });

  it('returns 0 when the profile root does not exist', async () => {
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
    const { cleanupOrphanProfiles } = await import('../src/browser.js');
    expect(await cleanupOrphanProfiles()).toBe(0);
  });
});

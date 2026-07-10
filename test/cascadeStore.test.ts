import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCascadeMode, saveCascadeMode, CASCADE_TTL_MS } from '../src/cascadeStore.js';

let dir: string;
let file: string;
const NOW = Date.parse('2026-07-10T00:00:00.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surf-cascade-'));
  file = join(dir, '.heal', 'cascade.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cascadeStore', () => {
  it('round-trips a mode through a missing directory', () => {
    saveCascadeMode(file, 'on', NOW);
    expect(loadCascadeMode(file, 'off', NOW)).toBe('on');
  });

  it('falls back when no state exists', () => {
    expect(loadCascadeMode(file, 'off', NOW)).toBe('off');
  });

  it('retries the cheaper tier once the state goes stale', () => {
    saveCascadeMode(file, 'on', NOW);
    expect(loadCascadeMode(file, 'off', NOW + CASCADE_TTL_MS - 1)).toBe('on');
    expect(loadCascadeMode(file, 'off', NOW + CASCADE_TTL_MS + 1)).toBe('off');
  });

  it('falls back on corrupt, truncated, or foreign state', () => {
    saveCascadeMode(file, 'on', NOW);
    for (const bad of ['{', '{"schema":2,"mode":"on","updatedAt":"2026-07-10T00:00:00.000Z"}', '{"schema":1,"mode":"turbo"}', '{"schema":1,"mode":"on"}']) {
      writeFileSync(file, bad, 'utf8');
      expect(loadCascadeMode(file, 'off', NOW)).toBe('off');
    }
  });

  it('writes atomically and leaves valid json', () => {
    saveCascadeMode(file, 'on', NOW);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toMatchObject({ schema: 1, mode: 'on' });
    expect(Date.parse(parsed.updatedAt)).toBe(NOW);
  });

});

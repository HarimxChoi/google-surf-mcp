import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyHealing } from '../src/strategyHealing.js';

const IDS = ['a', 'b'] as const;
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'surf-baseline-'));
  file = join(dir, '.heal', 'strategy-order.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (enabled = true) => new StrategyHealing(file, enabled, IDS, 0);

describe('StrategyHealing baseline', () => {
  it('withholds a baseline until it has enough samples', async () => {
    const h = make();
    await h.load();
    for (const n of [8, 9, 8, 9]) h.recordResultCount(n);
    expect(h.baselineResults()).toBeUndefined();
    h.recordResultCount(8);
    expect(h.baselineResults()).toBe(8);
  });

  it('reports the median, not the mean, so one bad run cannot move it', async () => {
    const h = make();
    await h.load();
    for (const n of [8, 8, 9, 9, 0]) h.recordResultCount(n);
    expect(h.baselineResults()).toBe(8);
  });

  it('keeps only the most recent window', async () => {
    const h = make();
    await h.load();
    for (let i = 0; i < 25; i++) h.recordResultCount(1);
    for (let i = 0; i < 20; i++) h.recordResultCount(9);
    expect(h.baselineResults()).toBe(9);
  });

  it('survives a flush and reload', async () => {
    const h = make();
    await h.load();
    for (const n of [7, 8, 8, 9, 9]) h.recordResultCount(n);
    await h.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).recentResults).toEqual([7, 8, 8, 9, 9]);

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.baselineResults()).toBe(8);
  });

  it('records nothing when self-healing is disabled', async () => {
    const h = make(false);
    await h.load();
    for (const n of [8, 8, 8, 8, 8]) h.recordResultCount(n);
    expect(h.baselineResults()).toBeUndefined();
  });

  it('ignores garbage counts', async () => {
    const h = make();
    await h.load();
    for (const n of [Number.NaN, -1, Infinity]) h.recordResultCount(n);
    for (const n of [8, 8, 8, 8, 8]) h.recordResultCount(n);
    expect(h.baselineResults()).toBe(8);
  });
});

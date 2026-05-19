import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyHealing, _resetStrategyHealing, defaultHealingPath } from '../src/strategyHealing.js';

const IDS = ['alpha', 'beta', 'gamma'];

describe('StrategyHealing', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surf-heal-test-'));
    file = join(dir, '.heal', 'strategy-order.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetStrategyHealing();
  });

  describe('disabled mode', () => {
    it('record is a no-op and order matches input', async () => {
      const h = new StrategyHealing(file, false, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      h.recordOutcome('beta', 'zero');
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('load()', () => {
    it('first run with no file uses default order', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('loads persisted stats and applies them to ordering', async () => {
      const payload = {
        schema: 1,
        stats: {
          alpha: { wins: 0, zeros: 5, losses: 0, lastWinAt: null },
          beta: { wins: 12, zeros: 0, losses: 0, lastWinAt: '2026-05-18T00:00:00.000Z' },
          gamma: { wins: 0, zeros: 0, losses: 3, lastWinAt: null },
        },
      };
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(file, JSON.stringify(payload), 'utf8');
      await h.load();
      const order = h.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('beta');
      expect(order).toEqual(expect.arrayContaining(IDS));
    });

    it('ignores entries for IDs no longer in knownIds', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(
        file,
        JSON.stringify({
          schema: 1,
          stats: {
            alpha: { wins: 5, zeros: 0, losses: 0, lastWinAt: null },
            ghost: { wins: 100, zeros: 0, losses: 0, lastWinAt: null },
          },
        }),
        'utf8',
      );
      await h.load();
      expect(Object.keys(h.getStats())).toEqual(['alpha']);
    });

    it('corrupt file collapses to fresh state without throwing', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(file, 'not json {{{', 'utf8');
      await expect(h.load()).resolves.toBeUndefined();
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('rejects unknown schema versions and starts fresh', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(
        file,
        JSON.stringify({ schema: 99, stats: { alpha: { wins: 100, zeros: 0, losses: 0, lastWinAt: null } } }),
        'utf8',
      );
      await h.load();
      expect(h.getStats()).toEqual({});
    });

    it('survives partial corruption: missing fields per stat are ignored', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(
        file,
        JSON.stringify({
          schema: 1,
          stats: {
            alpha: { wins: 5, zeros: 0, losses: 0, lastWinAt: null },
            beta: { wins: 'oops' },
            gamma: null,
          },
        }),
        'utf8',
      );
      await h.load();
      const stats = h.getStats();
      expect(stats.alpha.wins).toBe(5);
      expect(stats.beta).toBeUndefined();
      expect(stats.gamma).toBeUndefined();
    });

    it('preserves recordOutcome() calls that race with the async load', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      writeFileSync(
        file,
        JSON.stringify({
          schema: 1,
          stats: {
            alpha: { wins: 10, zeros: 0, losses: 0, lastWinAt: '2026-05-18T00:00:00.000Z' },
          },
        }),
        'utf8',
      );
      const loadP = h.load();
      h.recordOutcome('alpha', 'win');
      h.recordOutcome('beta', 'zero');
      h.recordOutcome('beta', 'zero');
      await loadP;
      const stats = h.getStats();
      expect(stats.alpha.wins).toBe(11);
      expect(stats.alpha.lastWinAt).not.toBe('2026-05-18T00:00:00.000Z');
      expect(stats.beta.zeros).toBe(2);
      expect(stats.beta.wins).toBe(0);
    });
  });

  describe('recordOutcome + ordering', () => {
    it('returns default order until the win margin is met', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      h.recordOutcome('alpha', 'win');
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('does not promote a non-leading strategy on a single win (anti-flap)', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('beta', 'win');
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('does not promote on a 2-win lead either', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('gamma', 'win');
      h.recordOutcome('gamma', 'win');
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('promotes exactly at the margin (3 wins over runner-up)', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('gamma', 'win');
      h.recordOutcome('gamma', 'win');
      h.recordOutcome('gamma', 'win');
      const order = h.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('gamma');
    });

    it('promotes the consistent winner past the margin', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      for (let i = 0; i < 5; i++) h.recordOutcome('beta', 'win');
      const order = h.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('beta');
    });

    it('penalises zeros lightly but not enough to drown out wins on others', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      for (let i = 0; i < 4; i++) h.recordOutcome('alpha', 'win');
      for (let i = 0; i < 10; i++) h.recordOutcome('beta', 'zero');
      const order = h.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('alpha');
      expect(order[2]).toBe('beta');
    });

    it('losses are not penalised (losing to a better strategy is normal)', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      for (let i = 0; i < 100; i++) h.recordOutcome('alpha', 'loss');
      expect(h.getOrderedStrategyIds(IDS)).toEqual(IDS);
    });

    it('breaks score ties by recency of last win', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      writeFileSync(
        file,
        JSON.stringify({
          schema: 1,
          stats: {
            alpha: { wins: 5, zeros: 0, losses: 0, lastWinAt: '2024-01-01T00:00:00Z' },
            beta: { wins: 5, zeros: 0, losses: 0, lastWinAt: '2026-05-18T00:00:00Z' },
          },
        }),
        'utf8',
      );
      const h2 = new StrategyHealing(file, true, IDS, 0);
      await h2.load();
      h2.recordOutcome('beta', 'win');
      h2.recordOutcome('beta', 'win');
      h2.recordOutcome('beta', 'win');
      const order = h2.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('beta');
    });

    it('unseen strategies retain their default position', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      for (let i = 0; i < 5; i++) h.recordOutcome('gamma', 'win');
      const order = h.getOrderedStrategyIds(IDS);
      expect(order[0]).toBe('gamma');
      expect(order.slice(1)).toEqual(['alpha', 'beta']);
    });

    it('survives a strategy id added later (still trial-able)', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      for (let i = 0; i < 10; i++) h.recordOutcome('alpha', 'win');
      const order = h.getOrderedStrategyIds(['alpha', 'beta', 'gamma', 'delta']);
      expect(order[0]).toBe('alpha');
      expect(order).toContain('delta');
    });
  });

  describe('flush()', () => {
    it('writes JSON to disk via tmp+rename', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      await h.flush();
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.schema).toBe(1);
      expect(parsed.stats.alpha.wins).toBe(1);
    });

    it('is a no-op when nothing changed since last flush', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      await h.flush();
      const firstMtime = readFileSync(file, 'utf8');
      await h.flush();
      expect(readFileSync(file, 'utf8')).toBe(firstMtime);
    });

    it('does not throw when target dir is not writable', async () => {
      const bad = '/dev/null/strategy-order.json';
      const h = new StrategyHealing(bad, true, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      await expect(h.flush()).resolves.toBeUndefined();
    });
  });

  describe('defaultHealingPath', () => {
    it('joins profileRoot + .heal + strategy-order.json', () => {
      expect(defaultHealingPath('/tmp/p')).toBe(join('/tmp/p', '.heal', 'strategy-order.json'));
    });
  });

  describe('getStats()', () => {
    it('returns a copy so external mutation does not corrupt internal state', async () => {
      const h = new StrategyHealing(file, true, IDS, 0);
      await h.load();
      h.recordOutcome('alpha', 'win');
      const stats = h.getStats();
      stats.alpha.wins = 9999;
      expect(h.getStats().alpha.wins).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthTool, type Deps, type PoolHealthSnapshot } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { UnifiedCache } from '../src/cache.js';
import { RateLimiter } from '../src/limiter.js';
import { Telemetry } from '../src/telemetry.js';
import { StrategyHealing, _resetStrategyHealing } from '../src/strategyHealing.js';
import { STRATEGIES } from '../src/parse.js';
import { createCascadeState } from '../src/cascade.js';

function mkDeps(
  profileRoot: string,
  poolHealth: PoolHealthSnapshot = { warmFailures: 0, fallback: false },
): Deps {
  const config = loadConfig({ SURF_PROFILE_ROOT: profileRoot, SURF_SELF_HEALING: 'true' });
  const cache = new UnifiedCache(config.cacheRoot);
  const healing = new StrategyHealing(config.selfHealingFile, true, STRATEGIES.map((s) => s.id), 0);
  return {
    config,
    cache,
    cascade: createCascadeState(),
    limiter: new RateLimiter(config.rateLimitPerMin),
    tel: new Telemetry(config.telemetryRoot, false),
    healing,
    acquireSeqCtx: async () => { throw new Error('not used in healthTool'); },
    acquirePool: async () => { throw new Error('not used in healthTool'); },
    closeSeq: async () => {},
    resetPool: async () => {},
    recoverHuman: async () => {},
    getPoolHealth: () => poolHealth,
  };
}

describe('healthTool', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'surf-health-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetStrategyHealing();
  });

  it('includes pool snapshot from getPoolHealth()', async () => {
    const deps = mkDeps(dir, { warmFailures: 2, fallback: false });
    const out = await healthTool(deps);
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.pool).toEqual({ warmFailures: 2, fallback: false });
  });

  it('reflects fallback=true when pool has flipped to single-context mode', async () => {
    const deps = mkDeps(dir, { warmFailures: 5, fallback: true });
    const out = await healthTool(deps);
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.pool).toEqual({ warmFailures: 5, fallback: true });
  });

  it('includes selfHealing.enabled + order + stats fields', async () => {
    const deps = mkDeps(dir);
    await deps.healing.load();
    const out = await healthTool(deps);
    const data = out.structuredContent as Record<string, unknown>;
    const sh = data.selfHealing as { enabled: boolean; order: string[]; stats: Record<string, unknown> };
    expect(sh.enabled).toBe(true);
    expect(sh.order).toEqual(STRATEGIES.map((s) => s.id));
    expect(sh.stats).toEqual({});
  });

  it('reports updated selfHealing.order after enough wins to cross margin', async () => {
    const deps = mkDeps(dir);
    await deps.healing.load();
    const targetId = STRATEGIES[STRATEGIES.length - 1].id;
    for (let i = 0; i < 4; i++) deps.healing.recordOutcome(targetId, 'win');
    const out = await healthTool(deps);
    const data = out.structuredContent as Record<string, unknown>;
    const sh = data.selfHealing as { order: string[] };
    expect(sh.order[0]).toBe(targetId);
  });

  it('exposes version, cascade, rateLimiter, cache, telemetry, config siblings', async () => {
    const deps = mkDeps(dir);
    const out = await healthTool(deps);
    const data = out.structuredContent as Record<string, unknown>;
    for (const key of ['version', 'cascade', 'rateLimiter', 'cache', 'telemetry', 'config', 'pool', 'selfHealing']) {
      expect(data, `missing ${key}`).toHaveProperty(key);
    }
  });
});

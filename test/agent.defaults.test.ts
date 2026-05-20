import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDeps, healthTool } from '../src/agent.js';
import { _resetStrategyHealing } from '../src/strategyHealing.js';

describe('agent default-config path (no env)', () => {
  let profileRoot: string;

  beforeEach(() => {
    profileRoot = mkdtempSync(join(tmpdir(), 'surf-defaults-'));
    _resetStrategyHealing();
  });

  afterEach(() => {
    rmSync(profileRoot, { recursive: true, force: true });
    _resetStrategyHealing();
  });

  it('initDeps with bare env (only SURF_PROFILE_ROOT) returns usable Deps', () => {
    const deps = initDeps({ SURF_PROFILE_ROOT: profileRoot });
    expect(deps.config.selfHealingEnabled).toBe(true);
    expect(deps.config.telemetryEnabled).toBe(false);
    expect(deps.config.cloudMode).toBe(false);
    expect(deps.healing).toBeDefined();
    expect(deps.cache).toBeDefined();
    expect(deps.tel).toBeDefined();
  });

  it('healing.load() resolves cleanly when no persisted file exists', async () => {
    const deps = initDeps({ SURF_PROFILE_ROOT: profileRoot });
    await expect(deps.healing.load()).resolves.toBeUndefined();
    expect(deps.healing.getStats()).toEqual({});
  });

  it('healing.flush() is a no-op when nothing has been recorded', async () => {
    const deps = initDeps({ SURF_PROFILE_ROOT: profileRoot });
    await deps.healing.load();
    await expect(deps.healing.flush()).resolves.toBeUndefined();
    expect(existsSync(join(profileRoot, '.heal', 'strategy-order.json'))).toBe(false);
  });

  it('healing persists to default path after first recordOutcome', async () => {
    const deps = initDeps({ SURF_PROFILE_ROOT: profileRoot });
    await deps.healing.load();
    deps.healing.recordOutcome('data-ved-anchor-v1', 'win');
    await deps.healing.flush();
    const path = join(profileRoot, '.heal', 'strategy-order.json');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.schema).toBe(1);
    expect(parsed.stats['data-ved-anchor-v1'].wins).toBe(1);
  });

  it('SURF_SELF_HEALING=false makes healing a no-op (no file, no stats)', async () => {
    const deps = initDeps({
      SURF_PROFILE_ROOT: profileRoot,
      SURF_SELF_HEALING: 'false',
    });
    await deps.healing.load();
    deps.healing.recordOutcome('data-ved-anchor-v1', 'win');
    await deps.healing.flush();
    expect(existsSync(join(profileRoot, '.heal', 'strategy-order.json'))).toBe(false);
    expect(deps.healing.getStats()).toEqual({});
  });

  it('healthTool works against a real initDeps result (no env, no API key)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SURF_LLM_HEAL;
    const deps = initDeps({ SURF_PROFILE_ROOT: profileRoot });
    const out = await healthTool({
      ...deps,
      acquireSeqCtx: async () => { throw new Error('unused'); },
      acquirePool: async () => { throw new Error('unused'); },
      requestSeqRebuild: () => {},
      requestPoolRebuild: () => {},
      recoverHuman: async () => {},
      getPoolHealth: () => ({ warmFailures: 0, fallback: false }),
    });
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.version).toBeDefined();
    expect(data.pool).toEqual({ warmFailures: 0, fallback: false });
    expect((data.selfHealing as { enabled: boolean }).enabled).toBe(true);
    expect((data.telemetry as { enabled: boolean }).enabled).toBe(false);
  });
});

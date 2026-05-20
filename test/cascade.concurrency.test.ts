import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchExtractTool, type Deps, type PoolHandle, type PoolLease } from '../src/agent.js';
import { LeasedResource } from '../src/lifecycle.js';
import { createCascadeState, type StealthMode } from '../src/cascade.js';
import { CaptchaError } from '../src/search.js';
import { UnifiedCache } from '../src/cache.js';
import { RateLimiter } from '../src/limiter.js';
import { Telemetry } from '../src/telemetry.js';
import { StrategyHealing, _resetStrategyHealing } from '../src/strategyHealing.js';
import { STRATEGIES } from '../src/parse.js';
import { loadConfig } from '../src/config.js';

interface FakePool {
  gen: number;
  mode: StealthMode;
}

describe('cascade concurrency: neighbour survives requestRebuild mid-op', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'surf-concur-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetStrategyHealing();
  });

  it('cascade transition triggered by A does not kill B mid-op', async () => {
    const events: Array<{ caller: string; event: string; gen: number; ts: number }> = [];
    let nextGen = 0;
    const closeTimestamps: Array<{ gen: number; ts: number }> = [];

    const poolResource = new LeasedResource<FakePool, StealthMode>({
      build: vi.fn(async (mode: StealthMode) => {
        nextGen++;
        const gen = nextGen;
        events.push({ caller: '<build>', event: 'build', gen, ts: Date.now() });
        return { gen, mode };
      }),
      close: vi.fn(async (p: FakePool) => {
        closeTimestamps.push({ gen: p.gen, ts: Date.now() });
      }),
    });

    const makeHandle = (p: FakePool): PoolHandle => ({
      runMany: async () => [],
      searchOne: async (query: string) => {
        events.push({ caller: query, event: 'searchOne-start', gen: p.gen, ts: Date.now() });
        if (p.gen === 1 && query === 'A') {
          events.push({ caller: query, event: 'captcha', gen: p.gen, ts: Date.now() });
          throw new CaptchaError('home');
        }
        if (p.gen === 1 && query === 'B') {
          await new Promise((r) => setTimeout(r, 200));
        }
        events.push({ caller: query, event: 'searchOne-done', gen: p.gen, ts: Date.now() });
        return {
          query,
          results: [{ title: query, url: `https://example.com/${query}`, description: '' }],
        };
      },
      extractOne: async (url: string) => ({
        url,
        title: 'x',
        content: 'body',
        excerpt: 'b',
        length: 4,
        extraction_quality: 'full_text',
      }) as any,
    });

    const acquirePool = async (mode: StealthMode): Promise<PoolLease> => {
      const lease = await poolResource.acquire(mode);
      return {
        handle: makeHandle(lease.value),
        release: lease.release,
      };
    };

    const config = loadConfig({ SURF_PROFILE_ROOT: dir, SURF_TELEMETRY: 'false' });
    const deps: Deps = {
      config,
      cache: new UnifiedCache(config.cacheRoot),
      cascade: createCascadeState(),
      limiter: new RateLimiter(60),
      tel: new Telemetry(config.telemetryRoot, false),
      healing: new StrategyHealing(config.selfHealingFile, false, STRATEGIES.map((s) => s.id), 0),
      acquireSeqCtx: async () => { throw new Error('unused'); },
      acquirePool,
      requestSeqRebuild: () => {},
      requestPoolRebuild: () => poolResource.requestRebuild(),
      recoverHuman: async () => {},
      getPoolHealth: () => ({ warmFailures: 0, fallback: false }),
    };

    const [resA, resB] = await Promise.all([
      searchExtractTool({ query: 'A', limit: 1, mode: 'abstract' }, deps),
      searchExtractTool({ query: 'B', limit: 1, mode: 'abstract' }, deps),
    ]);

    expect(resA.isError).toBeFalsy();
    expect(resB.isError).toBeFalsy();
    expect(nextGen).toBe(2);

    expect(closeTimestamps).toHaveLength(1);
    expect(closeTimestamps[0].gen).toBe(1);

    const bDone = events.find((e) => e.caller === 'B' && e.event === 'searchOne-done');
    expect(bDone?.gen).toBe(1);

    const aDoneEvents = events.filter((e) => e.caller === 'A' && e.event === 'searchOne-done');
    expect(aDoneEvents).toHaveLength(1);
    expect(aDoneEvents[0].gen).toBe(2);

    // close happens after B's op completes — neighbour not torn down mid-op.
    expect(closeTimestamps[0].ts).toBeGreaterThanOrEqual(bDone!.ts);

    expect(deps.cascade.mode).toBe('on');
    expect(deps.cascade.totalCaptchas).toBe(1);
  });
});

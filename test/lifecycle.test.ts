import { describe, it, expect, vi } from 'vitest';
import { LeasedResource, type ResourceFactory } from '../src/lifecycle.js';

type Mode = 'a' | 'b';

interface MakeFactoryOpts {
  buildImpl?: (mode: Mode, count: number) => Promise<string>;
}

function makeFactory(opts: MakeFactoryOpts = {}) {
  let buildCount = 0;
  const build = vi.fn(async (mode: Mode) => {
    buildCount++;
    const n = buildCount;
    if (opts.buildImpl) return opts.buildImpl(mode, n);
    return `v${n}-${mode}`;
  });
  const close = vi.fn(async (_v: string) => {});
  const factory: ResourceFactory<string, Mode> = { build, close };
  return { factory, build, close, getBuildCount: () => buildCount };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('LeasedResource', () => {
  it('concurrent acquires share a single in-flight build', async () => {
    const { factory, build, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const [l1, l2, l3] = await Promise.all([
      res.acquire('a'),
      res.acquire('a'),
      res.acquire('a'),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(l1.value).toBe('v1-a');
    expect(l2.value).toBe('v1-a');
    expect(l3.value).toBe('v1-a');
    expect(res.activeCount).toBe(3);
    expect(close).not.toHaveBeenCalled();
  });

  it('acquire with different mode retires current and builds new gen', async () => {
    const { factory, build, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const la = await res.acquire('a');
    expect(la.value).toBe('v1-a');
    expect(build).toHaveBeenCalledTimes(1);

    const lb = await res.acquire('b');
    expect(lb.value).toBe('v2-b');
    expect(build).toHaveBeenCalledTimes(2);

    expect(close).not.toHaveBeenCalled();
    la.release();
    await tick();
    expect(close).toHaveBeenCalledWith('v1-a');

    lb.release();
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requestRebuild while leases active: existing leases stay valid; new acquire builds fresh', async () => {
    const { factory, build, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const l1 = await res.acquire('a');
    expect(l1.value).toBe('v1-a');

    res.requestRebuild();
    expect(close).not.toHaveBeenCalled();

    const l2 = await res.acquire('a');
    expect(l2.value).toBe('v2-a');
    expect(build).toHaveBeenCalledTimes(2);

    l1.release();
    await tick();
    expect(close).toHaveBeenCalledWith('v1-a');
    expect(close).toHaveBeenCalledTimes(1);

    l2.release();
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('last release on stale gen closes exactly once', async () => {
    const { factory, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const [l1, l2, l3] = await Promise.all([
      res.acquire('a'),
      res.acquire('a'),
      res.acquire('a'),
    ]);

    res.requestRebuild();
    l1.release();
    await tick();
    expect(close).not.toHaveBeenCalled();
    l2.release();
    await tick();
    expect(close).not.toHaveBeenCalled();
    l3.release();
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requestRebuild while gen has zero leases closes immediately', async () => {
    const { factory, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const l1 = await res.acquire('a');
    l1.release();
    await tick();
    expect(close).not.toHaveBeenCalled();

    res.requestRebuild();
    await tick();
    expect(close).toHaveBeenCalledWith('v1-a');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('build rejection: acquire rejects, current cleared, next acquire retries', async () => {
    let attempt = 0;
    const buildImpl = async (mode: Mode) => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return `v${attempt}-${mode}`;
    };
    const { factory, build, close } = makeFactory({ buildImpl });
    const res = new LeasedResource<string, Mode>(factory);

    await expect(res.acquire('a')).rejects.toThrow(/boom/);

    const l = await res.acquire('a');
    expect(l.value).toBe('v2-a');
    expect(build).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it('closeAll closes current gen regardless of leases; subsequent acquire throws', async () => {
    const { factory, close } = makeFactory();
    const res = new LeasedResource<string, Mode>(factory);

    const l1 = await res.acquire('a');
    const l2 = await res.acquire('a');
    expect(res.activeCount).toBe(2);

    await res.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('v1-a');

    l1.release();
    l2.release();
    await tick();
    expect(close).toHaveBeenCalledTimes(1);

    await expect(res.acquire('a')).rejects.toThrow(/closed/);
  });

  it('requestRebuild during in-flight build: lease still resolves; release closes stale gen', async () => {
    let resolveBuild: (v: string) => void;
    const buildPromise = new Promise<string>((r) => { resolveBuild = r; });
    const factory: ResourceFactory<string, Mode> = {
      build: vi.fn(() => buildPromise),
      close: vi.fn(async () => {}),
    };
    const res = new LeasedResource<string, Mode>(factory);

    const acquirePromise = res.acquire('a');

    res.requestRebuild();
    expect(factory.close).not.toHaveBeenCalled();

    resolveBuild!('v1-a');
    const lease = await acquirePromise;
    expect(lease.value).toBe('v1-a');
    expect(factory.close).not.toHaveBeenCalled();

    lease.release();
    await tick();
    expect(factory.close).toHaveBeenCalledWith('v1-a');
    expect(factory.close).toHaveBeenCalledTimes(1);
  });
});

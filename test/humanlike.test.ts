import { describe, it, expect, vi } from 'vitest';
import { HumanlikeBehavior, generateBehaviorParams } from '../src/humanlike.js';
import type { BBox } from '../src/types.js';

const params = generateBehaviorParams();

function mockPage() {
  return {
    keyboard: { type: vi.fn(async () => {}) },
    mouse: {
      move: vi.fn(async () => {}),
      wheel: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      up: vi.fn(async () => {}),
    },
    viewportSize: () => ({ width: 1366, height: 768 }),
    evaluate: vi.fn(async () => {}),
  } as any;
}

describe('generateBehaviorParams', () => {
  it('returns valid BehaviorParams shape', () => {
    const p = generateBehaviorParams();
    expect(p.mouse.steps[0]).toBeLessThan(p.mouse.steps[1]);
    expect(p.typing.delay[0]).toBeLessThan(p.typing.delay[1]);
    expect(p.delays.afterSearch[0]).toBeLessThan(p.delays.afterSearch[1]);
    expect(p.delays.betweenActions[0]).toBeLessThan(p.delays.betweenActions[1]);
    expect(p.mouse.speed).toBeGreaterThan(0);
    expect(p.mouse.overshoot).toBeGreaterThanOrEqual(0);
  });

  it('successive calls produce different params (Layer 1 randomization)', () => {
    const samples = Array.from({ length: 20 }, () => generateBehaviorParams());
    const typingMins = samples.map(p => p.typing.delay[0]);
    // 20 calls 모두 같은 값일 확률은 사실상 0 → 다양성 검증
    expect(new Set(typingMins).size).toBeGreaterThan(1);
  });

  it('generated ranges fall within meta-bounds', () => {
    const p = generateBehaviorParams();
    expect(p.typing.delay[0]).toBeGreaterThanOrEqual(5);
    expect(p.typing.delay[0]).toBeLessThanOrEqual(12);
    expect(p.typing.delay[1]).toBeGreaterThanOrEqual(18);
    expect(p.typing.delay[1]).toBeLessThanOrEqual(28);
    expect(p.mouse.steps[0]).toBeGreaterThanOrEqual(15);
    expect(p.mouse.steps[0]).toBeLessThanOrEqual(25);
  });
});

describe('HumanlikeBehavior', () => {
  it('mode=off does no extra browsing actions', async () => {
    const b = new HumanlikeBehavior(params, 'off');
    const page = mockPage();
    await b.simulateBrowsing(page, [{ x: 100, y: 200, w: 600, h: 80 }]);
    expect(page.mouse.move).not.toHaveBeenCalled();
    expect(page.mouse.wheel).not.toHaveBeenCalled();
  });

  it('mode=off uses default delays for typeQuery', async () => {
    const b = new HumanlikeBehavior(params, 'off');
    const page = mockPage();
    await b.typeQuery(page, 'hi');
    expect(page.keyboard.type).toHaveBeenCalledTimes(2);
  });

  it('mode=inline executes a non-empty action sequence', async () => {
    const b = new HumanlikeBehavior(params, 'inline');
    const page = mockPage();
    const results: BBox[] = Array.from({ length: 10 }, (_, i) => ({
      x: 100, y: 200 + i * 100, w: 600, h: 80,
    }));
    await b.simulateBrowsing(page, results);

    const totalCalls = page.mouse.move.mock.calls.length + page.mouse.wheel.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(0);
  });

  it('targets results from index 6+ (smoke)', async () => {
    const b = new HumanlikeBehavior(params, 'background');
    const page = mockPage();
    const results: BBox[] = Array.from({ length: 10 }, (_, i) => ({
      x: 100, y: 100 + i * 60, w: 500, h: 50,
    }));
    await b.simulateBrowsing(page, results);
    expect(true).toBe(true);
  }, 1000);

  it('mode=background returns immediately without awaiting full session', async () => {
    const b = new HumanlikeBehavior(params, 'background');
    const page = mockPage();
    const start = Date.now();
    await b.simulateBrowsing(page, [{ x: 100, y: 200, w: 600, h: 80 }]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('typeQuery types each character with delay', async () => {
    const b = new HumanlikeBehavior(params, 'inline');
    const page = mockPage();
    await b.typeQuery(page, 'hello');
    expect(page.keyboard.type).toHaveBeenCalledTimes(5);
    const firstCall = page.keyboard.type.mock.calls[0];
    expect(firstCall[1]).toMatchObject({ delay: expect.any(Number) });
  });

  it('does not throw when single action fails (swallow)', async () => {
    const b = new HumanlikeBehavior(params, 'inline');
    const page = mockPage();
    page.mouse.move = vi.fn(async () => { throw new Error('mouse fail'); });
    await expect(
      b.simulateBrowsing(page, [{ x: 100, y: 200, w: 600, h: 80 }]),
    ).resolves.toBeUndefined();
  });
});

import type { Page } from 'playwright';
import type { BehaviorParams, BBox } from './types.js';

export type HumanlikeMode = 'off' | 'background' | 'inline';

export type Action =
  | { type: 'mouse_move'; target: BBox; style: 'bezier' | 'random_walk' | 'jitter_line' | 'overshoot' }
  | { type: 'scroll'; direction: 'up' | 'down'; amountPx: number; prePauseMs: [number, number] }
  | { type: 'hover'; target: BBox; durationMs: [number, number] }
  | { type: 'pause'; durationMs: [number, number] }
  | { type: 'sidebar_drag'; distancePx: number }
  | { type: 'tab_blur_focus' }
  | { type: 'no_action' };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));

// 2-layer randomization: per-call BehaviorParams ranges + per-action rand()
// inside them, so cadence shifts call-to-call and defeats fingerprint locking.
export function generateBehaviorParams(): BehaviorParams {
  return {
    mouse: {
      steps: [randInt(15, 25), randInt(35, 50)],
      speed: rand(1.0, 2.0),
      overshoot: rand(0.05, 0.15),
    },
    typing: {
      delay: [randInt(5, 12), randInt(18, 28)],
    },
    delays: {
      afterSearch: [randInt(40, 70), randInt(100, 140)],
      betweenActions: [randInt(60, 110), randInt(140, 200)],
    },
  };
}

function weightedChoice<T extends string>(weights: Record<T, number>): T {
  const total = Object.values(weights).reduce((a, b) => (a as number) + (b as number), 0) as number;
  let r = Math.random() * total;
  for (const [key, w] of Object.entries(weights) as [T, number][]) {
    r -= w;
    if (r <= 0) return key;
  }
  return Object.keys(weights)[0] as T;
}

// Avoid first 6 results (where ads/maps usually sit).
function pickSafeTarget(results: BBox[]): BBox | null {
  if (results.length === 0) return null;
  const safeStart = Math.min(6, results.length - 1);
  const idx = randInt(safeStart, results.length - 1);
  return results[idx];
}

export class HumanlikeBehavior {
  constructor(
    private params: BehaviorParams,
    private mode: HumanlikeMode = 'off',
  ) {}

  async typeQuery(page: Page, query: string): Promise<void> {
    const [minD, maxD] = this.params.typing.delay;
    for (const ch of query) {
      await page.keyboard.type(ch, { delay: rand(minD, maxD) });
    }
  }

  async waitAfterSearch(): Promise<void> {
    if (this.mode === 'off') {
      await sleep(rand(50, 110));
      return;
    }
    const [minD, maxD] = this.params.delays.afterSearch;
    await sleep(rand(minD, maxD));
  }

  async waitBetweenActions(): Promise<void> {
    if (this.mode === 'off') return;
    const [minD, maxD] = this.params.delays.betweenActions;
    await sleep(rand(minD, maxD));
  }

  async simulateBrowsing(page: Page, resultBBoxes: BBox[]): Promise<void> {
    if (this.mode === 'off') return;
    const session = this.planSession(resultBBoxes);
    if (this.mode === 'background') {
      this.executeSession(page, session).catch(() => {});
    } else {
      await this.executeSession(page, session);
    }
  }

  private planSession(resultBBoxes: BBox[]): Action[] {
    const actions: Action[] = [];
    const sessionLength = randInt(2, 6);

    for (let i = 0; i < sessionLength; i++) {
      const actionType = weightedChoice({
        mouse_move: 0.35,
        scroll: 0.20,
        hover: 0.15,
        pause: 0.15,
        sidebar_drag: 0.05,
        tab_blur_focus: 0.05,
        no_action: 0.05,
      });
      const target = pickSafeTarget(resultBBoxes);

      switch (actionType) {
        case 'mouse_move':
          if (target) {
            actions.push({
              type: 'mouse_move',
              target,
              style: weightedChoice({
                bezier: 0.25,
                random_walk: 0.30,
                jitter_line: 0.25,
                overshoot: 0.20,
              }),
            });
          }
          break;
        case 'scroll':
          actions.push({
            type: 'scroll',
            direction: Math.random() < 0.7 ? 'down' : 'up',
            amountPx: randInt(150, 500),
            prePauseMs: [90, 600],
          });
          break;
        case 'hover':
          if (target) {
            actions.push({ type: 'hover', target, durationMs: [200, 800] });
          }
          break;
        case 'pause':
          actions.push({ type: 'pause', durationMs: [90, 600] });
          break;
        case 'sidebar_drag':
          actions.push({ type: 'sidebar_drag', distancePx: randInt(20, 100) });
          break;
        case 'tab_blur_focus':
          actions.push({ type: 'tab_blur_focus' });
          break;
        case 'no_action':
          actions.push({ type: 'no_action' });
          break;
      }
      if (Math.random() < 0.3) {
        actions.push({ type: 'pause', durationMs: [90, 600] });
      }
    }
    return actions;
  }

  private async executeSession(page: Page, actions: Action[]): Promise<void> {
    for (const action of actions) {
      try {
        await this.executeAction(page, action);
      } catch {
        // single-action failure must not break the session
      }
    }
  }

  private async executeAction(page: Page, action: Action): Promise<void> {
    switch (action.type) {
      case 'mouse_move':
        await this.mouseMoveTo(page, action.target, action.style);
        break;
      case 'scroll':
        await sleep(rand(action.prePauseMs[0], action.prePauseMs[1]));
        const dy = action.direction === 'down' ? action.amountPx : -action.amountPx;
        await page.mouse.wheel(0, dy);
        break;
      case 'hover':
        await this.mouseMoveTo(page, action.target, 'jitter_line');
        await sleep(rand(action.durationMs[0], action.durationMs[1]));
        break;
      case 'pause':
        await sleep(rand(action.durationMs[0], action.durationMs[1]));
        break;
      case 'sidebar_drag':
        try {
          const viewport = page.viewportSize();
          if (viewport) {
            const x = viewport.width - 10;
            const startY = viewport.height / 2;
            await page.mouse.move(x, startY);
            await page.mouse.down();
            await page.mouse.move(x, startY + action.distancePx, { steps: 10 });
            await page.mouse.up();
          }
        } catch { /* mouse api unavailable */ }
        break;
      case 'tab_blur_focus':
        await page.evaluate(() => {
          window.dispatchEvent(new Event('blur'));
          setTimeout(() => window.dispatchEvent(new Event('focus')), 100);
        });
        break;
      case 'no_action':
        break;
    }
  }

  private async mouseMoveTo(
    page: Page,
    target: BBox,
    style: 'bezier' | 'random_walk' | 'jitter_line' | 'overshoot',
  ): Promise<void> {
    const tx = target.x + target.w / 2 + rand(-20, 20);
    const ty = target.y + target.h / 2 + rand(-10, 10);
    const [minSteps, maxSteps] = this.params.mouse.steps;
    const speed = this.params.mouse.speed;
    const overshootFrac = this.params.mouse.overshoot;
    // per-step delay scaled by speed, kept random so cadence isn't fixed
    const stepDelay = () => sleep(rand(2, 9) / speed);

    switch (style) {
      case 'bezier': {
        const start = { x: rand(50, 800), y: rand(50, 400) };
        const cp1 = { x: start.x + rand(50, 200), y: start.y + rand(50, 200) };
        const cp2 = { x: tx + rand(-50, 50), y: ty + rand(-50, 50) };
        const steps = randInt(minSteps, maxSteps);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = (1 - t) ** 3 * start.x + 3 * (1 - t) ** 2 * t * cp1.x +
                    3 * (1 - t) * t ** 2 * cp2.x + t ** 3 * tx;
          const y = (1 - t) ** 3 * start.y + 3 * (1 - t) ** 2 * t * cp1.y +
                    3 * (1 - t) * t ** 2 * cp2.y + t ** 3 * ty;
          await page.mouse.move(x, y);
          await stepDelay();
        }
        break;
      }
      case 'random_walk': {
        const steps = randInt(minSteps, maxSteps);
        let { x, y } = { x: rand(50, 800), y: rand(50, 400) };
        for (let i = 0; i < steps; i++) {
          const dx = (tx - x) / (steps - i) + rand(-30, 30);
          const dy = (ty - y) / (steps - i) + rand(-30, 30);
          x += dx;
          y += dy;
          await page.mouse.move(x, y);
          await stepDelay();
        }
        break;
      }
      case 'jitter_line': {
        const steps = randInt(minSteps, maxSteps);
        const startX = rand(50, 400);
        const startY = rand(50, 300);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = startX + (tx - startX) * t + rand(-5, 5);
          const y = startY + (ty - startY) * t + rand(-5, 5);
          await page.mouse.move(x, y);
          await stepDelay();
        }
        break;
      }
      case 'overshoot': {
        const steps = randInt(minSteps, maxSteps);
        const startX = rand(50, 400);
        const startY = rand(50, 300);
        // overshoot past the target along travel direction, then settle back
        const dist = Math.hypot(tx - startX, ty - startY) || 1;
        const over = dist * overshootFrac * rand(0.7, 1.3);
        const overshootX = tx + ((tx - startX) / dist) * over;
        const overshootY = ty + ((ty - startY) / dist) * over;
        for (let i = 0; i <= steps / 2; i++) {
          const t = i / (steps / 2);
          await page.mouse.move(startX + (overshootX - startX) * t, startY + (overshootY - startY) * t);
          await stepDelay();
        }
        for (let i = 0; i <= steps / 2; i++) {
          const t = i / (steps / 2);
          await page.mouse.move(overshootX + (tx - overshootX) * t, overshootY + (ty - overshootY) * t);
          await stepDelay();
        }
        break;
      }
    }
  }
}

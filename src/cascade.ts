// 3-tier cascade: stealth off → stealth on → tier3 (human or fail-fast).
// Stealth plugin is the fallback, not the default: its patterns are detectable.

import type { CaptchaError } from './search.js';

export type StealthMode = 'on' | 'off';

export interface CascadeState {
  mode: StealthMode;
  captchaCountInMode: number;
  captchasByMode: { off: number; on: number };
  totalCaptchas: number;
  lastTransitionAt: number | null;
}

export interface CascadeConfig {
  tier1ToTier2Threshold: number;
  tier2ToTier3Threshold: number;
  maxIterations: number;
}

export interface CascadeDeps {
  runWithMode: (mode: StealthMode) => Promise<unknown>;
  resetContext: (mode: StealthMode) => Promise<void>;
  tier3Recovery: () => Promise<void>;
  isCaptchaError: (e: unknown) => boolean;
  onTransition?: (from: StealthMode | null, to: StealthMode | 'tier3', reason: string) => void;
}

export const DEFAULT_CASCADE_CONFIG: CascadeConfig = {
  tier1ToTier2Threshold: 1,
  tier2ToTier3Threshold: 2,
  maxIterations: 5,
};

export function createCascadeState(): CascadeState {
  return {
    mode: 'off',
    captchaCountInMode: 0,
    captchasByMode: { off: 0, on: 0 },
    totalCaptchas: 0,
    lastTransitionAt: null,
  };
}

export async function executeWithCascade<T>(
  state: CascadeState,
  deps: CascadeDeps,
  config: CascadeConfig = DEFAULT_CASCADE_CONFIG,
): Promise<T> {
  let iterations = 0;
  while (iterations++ < config.maxIterations) {
    try {
      return (await deps.runWithMode(state.mode)) as T;
    } catch (e) {
      if (!deps.isCaptchaError(e)) throw e;

      state.captchaCountInMode++;
      state.captchasByMode[state.mode]++;
      state.totalCaptchas++;

      if (state.mode === 'off' && state.captchaCountInMode >= config.tier1ToTier2Threshold) {
        deps.onTransition?.('off', 'on', `tier1 threshold (${state.captchaCountInMode})`);
        state.mode = 'on';
        state.captchaCountInMode = 0;
        state.lastTransitionAt = Date.now();
        await deps.resetContext('on');
        continue;
      }

      if (state.mode === 'on') {
        if (state.captchaCountInMode < config.tier2ToTier3Threshold) {
          deps.onTransition?.('on', 'on', `tier2 retry (${state.captchaCountInMode}/${config.tier2ToTier3Threshold})`);
          await deps.resetContext('on');
          continue;
        }
        deps.onTransition?.('on', 'tier3', `tier2 threshold (${state.captchaCountInMode})`);
        await deps.tier3Recovery();
        state.captchaCountInMode = 0;
        await deps.resetContext('on');
        continue;
      }

      throw e;
    }
  }
  throw new Error(`cascade: max iterations (${config.maxIterations}) exceeded`);
}

export function describeCascadeState(state: CascadeState): string {
  return `mode=${state.mode} count=${state.captchaCountInMode} total=${state.totalCaptchas}`;
}

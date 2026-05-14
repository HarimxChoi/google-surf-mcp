import { describe, it, expect, vi } from 'vitest';
import {
  createCascadeState,
  executeWithCascade,
  type CascadeDeps,
  type CascadeConfig,
} from '../src/cascade.js';

class FakeCaptchaError extends Error {
  constructor() { super('captcha'); this.name = 'CaptchaError'; }
}

const isCaptcha = (e: unknown) => e instanceof FakeCaptchaError;

const fastConfig: CascadeConfig = {
  tier1ToTier2Threshold: 1,
  tier2ToTier3Threshold: 2,
  maxIterations: 10,
};

describe('executeWithCascade', () => {
  it('returns result on first success in tier 1', async () => {
    const state = createCascadeState();
    const runWithMode = vi.fn(async () => 'ok');
    const resetContext = vi.fn(async () => {});
    const tier3 = vi.fn(async () => {});

    const result = await executeWithCascade(state, {
      runWithMode,
      resetContext,
      tier3Recovery: tier3,
      isCaptchaError: isCaptcha,
    }, fastConfig);

    expect(result).toBe('ok');
    expect(state.mode).toBe('off');
    expect(state.totalCaptchas).toBe(0);
    expect(runWithMode).toHaveBeenCalledTimes(1);
    expect(resetContext).not.toHaveBeenCalled();
    expect(tier3).not.toHaveBeenCalled();
  });

  it('transitions tier1 → tier2 on first captcha and succeeds', async () => {
    const state = createCascadeState();
    let calls = 0;
    const runWithMode = vi.fn(async (mode) => {
      calls++;
      if (calls === 1) throw new FakeCaptchaError();
      return `ok-${mode}`;
    });
    const resetContext = vi.fn(async () => {});
    const tier3 = vi.fn(async () => {});
    const transitions: any[] = [];

    const result = await executeWithCascade(state, {
      runWithMode,
      resetContext,
      tier3Recovery: tier3,
      isCaptchaError: isCaptcha,
      onTransition: (from, to, reason) => transitions.push({ from, to, reason }),
    }, fastConfig);

    expect(result).toBe('ok-on');
    expect(state.mode).toBe('on');
    expect(state.totalCaptchas).toBe(1);
    expect(state.captchaCountInMode).toBe(0);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: 'off', to: 'on' });
    expect(resetContext).toHaveBeenCalledWith('on');
    expect(tier3).not.toHaveBeenCalled();
  });

  it('retries in tier 2 when below tier3 threshold', async () => {
    const state = createCascadeState();
    let calls = 0;
    const runWithMode = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new FakeCaptchaError();
      return 'ok';
    });

    const result = await executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: async () => {},
      isCaptchaError: isCaptcha,
    }, fastConfig);

    expect(result).toBe('ok');
    expect(state.mode).toBe('on');
    expect(state.totalCaptchas).toBe(2);
    expect(runWithMode).toHaveBeenCalledTimes(3);
  });

  it('escalates to tier 3 after threshold captchas in tier 2', async () => {
    const state = createCascadeState();
    let calls = 0;
    const runWithMode = vi.fn(async () => {
      calls++;
      if (calls <= 3) throw new FakeCaptchaError();
      return 'ok';
    });
    const tier3 = vi.fn(async () => {});

    const result = await executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: tier3,
      isCaptchaError: isCaptcha,
    }, fastConfig);

    expect(result).toBe('ok');
    expect(tier3).toHaveBeenCalledOnce();
    expect(state.totalCaptchas).toBe(3);
  });

  it('propagates non-captcha errors immediately without retry', async () => {
    const state = createCascadeState();
    const customErr = new Error('something else');
    const runWithMode = vi.fn(async () => { throw customErr; });

    await expect(executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: async () => {},
      isCaptchaError: isCaptcha,
    }, fastConfig)).rejects.toBe(customErr);

    expect(state.totalCaptchas).toBe(0);
  });

  it('propagates tier3Recovery throws (cloud-mode fail-fast)', async () => {
    const state = createCascadeState();
    const runWithMode = vi.fn(async () => { throw new FakeCaptchaError(); });
    const tier3 = vi.fn(async () => { throw new Error('cloud-mode unrecoverable'); });

    await expect(executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: tier3,
      isCaptchaError: isCaptcha,
    }, fastConfig)).rejects.toThrow(/unrecoverable/);

    expect(tier3).toHaveBeenCalledOnce();
  });

  it('respects maxIterations bound to prevent infinite loop', async () => {
    const state = createCascadeState();
    const runWithMode = vi.fn(async () => { throw new FakeCaptchaError(); });
    const tier3 = vi.fn(async () => {});

    await expect(executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: tier3,
      isCaptchaError: isCaptcha,
    }, { ...fastConfig, maxIterations: 4 })).rejects.toThrow(/max iterations/);
  });

  it('preserves cascade state across multiple executeWithCascade calls', async () => {
    const state = createCascadeState();
    let calls = 0;
    const runWithMode = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new FakeCaptchaError();
      return 'ok';
    });

    await executeWithCascade(state, {
      runWithMode,
      resetContext: async () => {},
      tier3Recovery: async () => {},
      isCaptchaError: isCaptcha,
    }, fastConfig);

    expect(state.mode).toBe('on');

    const runWithMode2 = vi.fn(async (mode) => `result-${mode}`);
    const result = await executeWithCascade(state, {
      runWithMode: runWithMode2,
      resetContext: async () => {},
      tier3Recovery: async () => {},
      isCaptchaError: isCaptcha,
    }, fastConfig);

    expect(result).toBe('result-on');
    expect(runWithMode2).toHaveBeenCalledWith('on');
  });
});

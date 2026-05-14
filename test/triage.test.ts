import { describe, it, expect } from 'vitest';
import { classifyFault, recoveryFor, describeFault } from '../src/triage.js';

describe('classifyFault', () => {
  const okStatus = { responseStatus: 200, responseTimeMs: 1000, url: 'https://www.google.com/search?q=x' };

  it('classifies /sorry/ URL as blocked', () => {
    const r = classifyFault({ resultsLen: 0, h3Count: 0, responseStatus: 200, responseTimeMs: 500, url: 'https://www.google.com/sorry/index?continue=foo' });
    expect(r.type).toBe('blocked');
  });

  it('classifies HTTP 429 as rate_limited', () => {
    const r = classifyFault({ ...okStatus, responseStatus: 429, resultsLen: 0, h3Count: 0 });
    expect(r.type).toBe('rate_limited');
  });

  it('classifies HTTP 5xx as network_error', () => {
    const r = classifyFault({ ...okStatus, responseStatus: 503, resultsLen: 0, h3Count: 0 });
    expect(r.type).toBe('network_error');
  });

  it('classifies "h3 high + results 0" as selector_broken (single signal)', () => {
    const r = classifyFault({ ...okStatus, resultsLen: 0, h3Count: 8 });
    expect(r.type).toBe('selector_broken');
  });

  it('classifies multi-signal voting as selector_broken (h3 + low geom)', () => {
    const r = classifyFault({ ...okStatus, resultsLen: 0, h3Count: 8, geometricConfidence: 0.2 });
    expect(r.type).toBe('selector_broken');
  });

  it('classifies multi-signal voting as selector_broken (low geom + recent zeros)', () => {
    const r = classifyFault({ ...okStatus, resultsLen: 0, h3Count: 3, geometricConfidence: 0.1, recentZeroResults: 3 });
    expect(r.type).toBe('selector_broken');
  });

  it('detects soft rate_limit via slow response + low results', () => {
    const r = classifyFault({ ...okStatus, responseTimeMs: 18_000, resultsLen: 1, h3Count: 1 });
    expect(r.type).toBe('rate_limited');
  });

  it('returns unknown for benign cases', () => {
    const r = classifyFault({ ...okStatus, resultsLen: 10, h3Count: 10, geometricConfidence: 0.9 });
    expect(r.type).toBe('unknown');
  });

  it('does not false-positive selector_broken for low h3 + 0 results (truly empty SERP)', () => {
    const r = classifyFault({ ...okStatus, resultsLen: 0, h3Count: 0 });
    expect(r.type).not.toBe('selector_broken');
  });
});

describe('recoveryFor', () => {
  it('selector_broken → retry_with_strategy', () => {
    expect(recoveryFor('selector_broken').type).toBe('retry_with_strategy');
  });

  it('blocked → long single-attempt backoff (IP cooldown)', () => {
    const r = recoveryFor('blocked');
    expect(r.type).toBe('backoff');
    expect(r.params?.initialMs).toBe(30 * 60_000);
    expect(r.params?.factor).toBe(1);
    expect(r.params?.maxAttempts).toBe(1);
  });

  it('rate_limited → backoff with longer initial delay', () => {
    const r = recoveryFor('rate_limited');
    expect(r.type).toBe('backoff');
    expect(r.params?.initialMs).toBe(60_000);
  });

  it('network_error → backoff with quick retry', () => {
    const r = recoveryFor('network_error');
    expect(r.type).toBe('backoff');
    expect(r.params?.initialMs).toBe(1_000);
  });

  it('unknown → alert_only (no auto-action)', () => {
    expect(recoveryFor('unknown').type).toBe('alert_only');
  });
});

describe('describeFault', () => {
  it('formats classification as readable string', () => {
    const desc = describeFault({
      type: 'selector_broken',
      signals: { resultsLen: 0, h3Count: 8, responseStatus: 200, responseTimeMs: 1000, url: 'x', geometricConfidence: 0.2 },
    });
    expect(desc).toContain('type=selector_broken');
    expect(desc).toContain('results=0');
    expect(desc).toContain('h3=8');
    expect(desc).toContain('geom=0.20');
  });
});

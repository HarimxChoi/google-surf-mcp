import type { FaultType, FaultClassification, RecoveryAction } from './types.js';

export interface TriageInput {
  resultsLen: number;
  h3Count: number;
  responseStatus: number;
  responseTimeMs: number;
  url: string;
  geometricConfidence?: number;
  recentZeroResults?: number;
}

export function classifyFault(input: TriageInput): FaultClassification {
  const {
    resultsLen,
    h3Count,
    responseStatus,
    responseTimeMs,
    url,
    geometricConfidence,
    recentZeroResults = 0,
  } = input;

  if (url.includes('/sorry/')) {
    return { type: 'blocked', signals: input };
  }
  if (responseStatus === 429) {
    return { type: 'rate_limited', signals: input };
  }
  if (responseStatus >= 400 && responseStatus !== 429) {
    return { type: 'network_error', signals: input };
  }

  // Multi-signal voting: 2-of-3 must agree before declaring selector_broken.
  let stalenessVote = 0;
  if (h3Count > 5 && resultsLen === 0) stalenessVote++;
  if (geometricConfidence !== undefined && geometricConfidence < 0.4) stalenessVote++;
  if (recentZeroResults >= 2) stalenessVote++;

  if (stalenessVote >= 2 && responseStatus === 200) {
    return { type: 'selector_broken', signals: input };
  }

  if (responseTimeMs > 15_000 && resultsLen < 3 && resultsLen > 0) {
    return { type: 'rate_limited', signals: input };
  }

  if (h3Count > 5 && resultsLen === 0 && responseStatus === 200) {
    return { type: 'selector_broken', signals: input };
  }

  return { type: 'unknown', signals: input };
}

export function recoveryFor(fault: FaultType): RecoveryAction {
  switch (fault) {
    case 'selector_broken':
      return { type: 'retry_with_strategy' };
    case 'blocked':
      // IP-level block: profile rotation cannot escape it (verified empirically).
      // Single long retry simulates IP cooldown. factor=1 means no exponential growth.
      return { type: 'backoff', params: { initialMs: 30 * 60_000, factor: 1, maxAttempts: 1 } };
    case 'rate_limited':
      return { type: 'backoff', params: { initialMs: 60_000, factor: 2, maxAttempts: 3 } };
    case 'network_error':
      return { type: 'backoff', params: { initialMs: 1_000, factor: 2, maxAttempts: 3 } };
    case 'unknown':
      return { type: 'alert_only' };
  }
}

export function describeFault(c: FaultClassification): string {
  const parts: string[] = [`type=${c.type}`];
  parts.push(`results=${c.signals.resultsLen}`, `h3=${c.signals.h3Count}`);
  if (c.signals.responseStatus !== 200) parts.push(`status=${c.signals.responseStatus}`);
  if (c.signals.geometricConfidence !== undefined) {
    parts.push(`geom=${c.signals.geometricConfidence.toFixed(2)}`);
  }
  return parts.join(' ');
}

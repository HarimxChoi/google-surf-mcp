import type { FaultType, FaultClassification, RecoveryAction } from './types.js';

export interface DegradationInput {
  resultsLen: number;
  h3Count: number;
  geometricConfidence?: number;
  recentZeroResults?: number;
  peerResults?: number;
  baselineResults?: number;
}

export interface TriageInput extends DegradationInput {
  responseStatus: number;
  responseTimeMs: number;
  url: string;
}

// There is no results-per-h3 vote: a healthy SERP ranges from 0.55 to 1.11,
// because knowledge panels emit h3s that are not results and nested blocks
// share one. Live leader confidence sits in 0.73-0.75, so 0.55 is a floor.
const MIN_LEADER_CONFIDENCE = 0.55;
const MIN_PEER_RESULTS = 3;
const PEER_COLLAPSE_RATIO = 0.6;
const MIN_BASELINE_RESULTS = 5;

// Every signal is about the leading strategy, the one we would ship results from.
export function degradationVotes(input: DegradationInput): string[] {
  const {
    resultsLen,
    h3Count,
    geometricConfidence,
    recentZeroResults = 0,
    peerResults,
    baselineResults,
  } = input;
  const votes: string[] = [];

  if (h3Count > 5 && resultsLen === 0) votes.push('no_results_despite_h3');
  if (geometricConfidence !== undefined && geometricConfidence < MIN_LEADER_CONFIDENCE) {
    votes.push('low_geometric_confidence');
  }
  if (recentZeroResults >= 2) votes.push('repeated_zero_results');
  if (
    peerResults !== undefined &&
    peerResults >= MIN_PEER_RESULTS &&
    resultsLen <= peerResults * PEER_COLLAPSE_RATIO
  ) {
    votes.push('peer_strategy_outperforms');
  }
  if (
    baselineResults !== undefined &&
    baselineResults >= MIN_BASELINE_RESULTS &&
    resultsLen <= baselineResults / 2
  ) {
    votes.push('below_half_of_baseline');
  }

  return votes;
}

export function classifyFault(input: TriageInput): FaultClassification {
  const { resultsLen, h3Count, responseStatus, responseTimeMs, url } = input;

  if (url.includes('/sorry/')) {
    return { type: 'blocked', signals: input };
  }
  if (responseStatus === 429) {
    return { type: 'rate_limited', signals: input };
  }
  if (responseStatus >= 400 && responseStatus !== 429) {
    return { type: 'network_error', signals: input };
  }

  if (responseStatus === 200) {
    // Headings but no results needs no corroboration; partial loss does.
    if (h3Count > 5 && resultsLen === 0) return { type: 'selector_broken', signals: input };
    if (degradationVotes(input).length >= 2) return { type: 'selector_broken', signals: input };
  }

  if (responseTimeMs > 15_000 && resultsLen < 3 && resultsLen > 0) {
    return { type: 'rate_limited', signals: input };
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
  const votes = degradationVotes(c.signals);
  if (votes.length) parts.push(`votes=[${votes.join(',')}]`);
  return parts.join(' ');
}

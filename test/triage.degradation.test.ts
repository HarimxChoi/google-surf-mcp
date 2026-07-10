import { describe, it, expect } from 'vitest';
import { classifyFault, degradationVotes } from '../src/triage.js';

const healthy = {
  responseStatus: 200,
  responseTimeMs: 900,
  url: 'https://www.google.com/search?q=x',
};

describe('degradationVotes', () => {
  // Measured on live SERPs: leader confidence 0.73-0.75, results/h3 0.545-1.11.
  const liveHealthy = [
    { q: 'weather', resultsLen: 9, h3Count: 9, geometricConfidence: 0.75, peerResults: 10 },
    { q: 'openai', resultsLen: 6, h3Count: 11, geometricConfidence: 0.75, peerResults: 6 },
    { q: 'github actions', resultsLen: 9, h3Count: 14, geometricConfidence: 0.73, peerResults: 9 },
    { q: 'vpn', resultsLen: 8, h3Count: 8, geometricConfidence: 0.74, peerResults: 8 },
    { q: 'ts generics', resultsLen: 8, h3Count: 8, geometricConfidence: 0.74, peerResults: 8 },
  ];

  it('stays silent on every measured healthy SERP', () => {
    for (const { q, ...signals } of liveHealthy) {
      const votes = degradationVotes({ ...signals, baselineResults: 8 });
      expect(votes, `${q} voted ${votes.join(',')}`).toEqual([]);
    }
  });

  it('votes when a peer strategy finds far more results', () => {
    const votes = degradationVotes({ resultsLen: 3, h3Count: 12, geometricConfidence: 0.74, peerResults: 9 });
    expect(votes).toContain('peer_strategy_outperforms');
  });

  it('votes when results collapse below half the stored baseline', () => {
    const votes = degradationVotes({ resultsLen: 3, h3Count: 12, geometricConfidence: 0.74, baselineResults: 8 });
    expect(votes).toContain('below_half_of_baseline');
  });

  it('ignores a baseline built from too few or too small samples', () => {
    const votes = degradationVotes({ resultsLen: 1, h3Count: 12, geometricConfidence: 0.74, baselineResults: 4 });
    expect(votes).not.toContain('below_half_of_baseline');
  });

  it('ignores a peer that also found almost nothing', () => {
    const votes = degradationVotes({ resultsLen: 1, h3Count: 12, geometricConfidence: 0.74, peerResults: 2 });
    expect(votes).not.toContain('peer_strategy_outperforms');
  });

  it('votes on low leader confidence', () => {
    expect(degradationVotes({ resultsLen: 9, h3Count: 9, geometricConfidence: 0.4 }))
      .toContain('low_geometric_confidence');
    expect(degradationVotes({ resultsLen: 9, h3Count: 9, geometricConfidence: 0.73 }))
      .not.toContain('low_geometric_confidence');
  });
});

describe('classifyFault with partial degradation', () => {
  it('detects a partial collapse that never reaches zero results', () => {
    const fault = classifyFault({
      ...healthy,
      resultsLen: 3,
      h3Count: 12,
      geometricConfidence: 0.3,
      peerResults: 9,
      baselineResults: 8,
    });
    expect(fault.type).toBe('selector_broken');
  });

  it('needs two votes, not one', () => {
    const fault = classifyFault({
      ...healthy,
      resultsLen: 3,
      h3Count: 12,
      geometricConfidence: 0.74,
      peerResults: 9,
    });
    expect(fault.type).toBe('unknown');
  });

  it('still calls a total failure selector_broken', () => {
    const fault = classifyFault({ ...healthy, resultsLen: 0, h3Count: 12, geometricConfidence: 0 });
    expect(fault.type).toBe('selector_broken');
  });

  it('blocked and rate limited still win over degradation votes', () => {
    expect(classifyFault({ ...healthy, url: 'https://www.google.com/sorry/index', resultsLen: 0, h3Count: 0 }).type).toBe('blocked');
    expect(classifyFault({ ...healthy, responseStatus: 429, resultsLen: 0, h3Count: 12 }).type).toBe('rate_limited');
  });
});

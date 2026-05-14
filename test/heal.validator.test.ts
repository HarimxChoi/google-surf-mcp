import { describe, it, expect } from 'vitest';
import {
  runGateA, runGateB, runGateC, runTripleGate,
  evaluateQuery, evaluateEmpirical, decideFix,
} from '../src/heal/validator.js';
import type { GeometricVerification } from '../src/types.js';
import type { SynthesizedCandidate } from '../src/heal/synthesis.js';
import type { LLMRepairOutput } from '../src/heal/llm.js';

const goodVerification = (n = 8): GeometricVerification[] =>
  Array.from({ length: n }, (_, i) => ({
    index: i,
    rect: { x: 100, y: 200 + i * 100, w: 600, h: 80 },
    signals: {
      inOrganicRegion: true,
      overlapsAdRegion: false,
      overlapsRightSidebar: false,
      matchesElementFromPoint: true,
      hasH3: true,
      hasExternalLink: true,
    },
    confidence: 0.85,
  }));

const goodCandidate: SynthesizedCandidate = {
  blockSelector: '[data-ved] h3',
  blockXPath: '//*[@data-ved]/h3',
  source: 'data-ved',
  rationale: 'data-ved found',
};

const goodLLM: LLMRepairOutput = {
  decision: 'approve_candidate',
  selector: '[data-ved] h3',
  rationale: 'stable attribute',
  confidence: 'high',
  expected_min_blocks: 5,
};

describe('Gate A (geometric)', () => {
  it('passes with 8 results, all organic, high confidence', () => {
    const r = runGateA(8, goodVerification(8));
    expect(r.passed).toBe(true);
    expect(r.organicRatio).toBe(1);
  });

  it('fails when block count < 5', () => {
    const r = runGateA(3, goodVerification(3));
    expect(r.passed).toBe(false);
  });

  it('fails when organic ratio < 0.6', () => {
    const verifications = goodVerification(10);
    // 7 results overlap ad → only 3 organic out of 10 = 0.3 ratio
    for (let i = 0; i < 7; i++) {
      verifications[i].signals.inOrganicRegion = false;
    }
    const r = runGateA(10, verifications);
    expect(r.passed).toBe(false);
    expect(r.organicRatio).toBeLessThan(0.6);
  });
});

describe('Gate B (XPath stability)', () => {
  it('passes for data-ved candidate', () => {
    const r = runGateB(goodCandidate);
    expect(r.passed).toBe(true);
  });

  it('fails for class-fallback', () => {
    const r = runGateB({
      ...goodCandidate,
      blockSelector: 'div.MjjYud',
      source: 'class-fallback',
    });
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/class-only/);
  });

  it('fails for ad selector pattern', () => {
    const r = runGateB({
      ...goodCandidate,
      blockSelector: '#tads .result',
    });
    expect(r.passed).toBe(false);
  });

  it('fails for empty selector', () => {
    const r = runGateB({ ...goodCandidate, blockSelector: '' });
    expect(r.passed).toBe(false);
  });
});

describe('Gate C (LLM confirmation)', () => {
  it('passes for high confidence approve', () => {
    expect(runGateC(goodLLM).passed).toBe(true);
  });

  it('fails for low confidence', () => {
    expect(runGateC({ ...goodLLM, confidence: 'low' }).passed).toBe(false);
  });

  it('passes for medium confidence + propose_new', () => {
    expect(runGateC({ ...goodLLM, confidence: 'medium', decision: 'propose_new' }).passed).toBe(true);
  });
});

describe('Triple Gate (AND of A + B + C)', () => {
  it('passes when all 3 gates pass', () => {
    const r = runTripleGate(8, goodVerification(8), goodCandidate, goodLLM);
    expect(r.passed).toBe(true);
  });

  it('fails if any single gate fails', () => {
    expect(runTripleGate(3, goodVerification(3), goodCandidate, goodLLM).passed).toBe(false); // A fails
    expect(runTripleGate(8, goodVerification(8), { ...goodCandidate, blockSelector: '' }, goodLLM).passed).toBe(false); // B fails
    expect(runTripleGate(8, goodVerification(8), goodCandidate, { ...goodLLM, confidence: 'low' }).passed).toBe(false); // C fails
  });
});

describe('Empirical 3-query test', () => {
  it('passes a single query with enough results + good geom', () => {
    const r = evaluateQuery('weather', 5, goodVerification(5));
    expect(r.passed).toBe(true);
  });

  it('fails when results count too low', () => {
    const r = evaluateQuery('weather', 2, goodVerification(2));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/results count/);
  });

  it('fails when geometric mean too low', () => {
    const lowConf = goodVerification(5).map(v => ({ ...v, confidence: 0.3 }));
    const r = evaluateQuery('weather', 5, lowConf);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/geometric mean/);
  });

  it('verdict apply when 3/3 pass', () => {
    const results = [
      evaluateQuery('q1', 5, goodVerification(5)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 5, goodVerification(5)),
    ];
    const report = evaluateEmpirical(results);
    expect(report.verdict).toBe('apply');
    expect(report.passedCount).toBe(3);
  });

  it('verdict caution_flag when 2/3 pass', () => {
    const results = [
      evaluateQuery('q1', 5, goodVerification(5)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 1, goodVerification(1)),  // fails
    ];
    const report = evaluateEmpirical(results);
    expect(report.verdict).toBe('caution_flag');
  });

  it('verdict escalate when <2 pass', () => {
    const results = [
      evaluateQuery('q1', 1, goodVerification(1)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 1, goodVerification(1)),
    ];
    const report = evaluateEmpirical(results);
    expect(report.verdict).toBe('escalate');
  });
});

describe('decideFix (Triple Gate + Empirical combined)', () => {
  const triple = runTripleGate(8, goodVerification(8), goodCandidate, goodLLM);

  it('opens PR when triple gate + 3/3 empirical', () => {
    const empirical = evaluateEmpirical([
      evaluateQuery('q1', 5, goodVerification(5)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 5, goodVerification(5)),
    ]);
    const decision = decideFix(goodCandidate, triple, empirical);
    expect(decision.shouldOpenPR).toBe(true);
    expect(decision.caution).toBe(false);
  });

  it('opens PR with caution flag for 2/3', () => {
    const empirical = evaluateEmpirical([
      evaluateQuery('q1', 5, goodVerification(5)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 1, goodVerification(1)),
    ]);
    const decision = decideFix(goodCandidate, triple, empirical);
    expect(decision.shouldOpenPR).toBe(true);
    expect(decision.caution).toBe(true);
  });

  it('does NOT open PR when triple gate fails', () => {
    const failedTriple = runTripleGate(2, goodVerification(2), goodCandidate, goodLLM);
    const empirical = evaluateEmpirical([
      evaluateQuery('q1', 5, goodVerification(5)),
      evaluateQuery('q2', 5, goodVerification(5)),
      evaluateQuery('q3', 5, goodVerification(5)),
    ]);
    const decision = decideFix(goodCandidate, failedTriple, empirical);
    expect(decision.shouldOpenPR).toBe(false);
  });

  it('does NOT open PR when empirical escalates', () => {
    const empirical = evaluateEmpirical([
      evaluateQuery('q1', 1, goodVerification(1)),
      evaluateQuery('q2', 1, goodVerification(1)),
      evaluateQuery('q3', 5, goodVerification(5)),
    ]);
    const decision = decideFix(goodCandidate, triple, empirical);
    expect(decision.shouldOpenPR).toBe(false);
  });
});

import type { GeometricVerification } from '../types.js';
import type { SynthesizedCandidate } from './synthesis.js';
import type { LLMRepairOutput } from './llm.js';

export interface GateAReport {
  passed: boolean;
  blockCount: number;
  organicRatio: number;
  meanConfidence: number;
}

export interface GateBReport {
  passed: boolean;
  selector: string;
  reason: string;
}

export interface GateCReport {
  passed: boolean;
  llmConfidence: 'low' | 'medium' | 'high';
  decision: string;
}

export interface TripleGateReport {
  gateA: GateAReport;
  gateB: GateBReport;
  gateC: GateCReport;
  passed: boolean;
}

export function runGateA(
  blockCount: number,
  verifications: GeometricVerification[],
): GateAReport {
  if (blockCount < 5) {
    return { passed: false, blockCount, organicRatio: 0, meanConfidence: 0 };
  }
  const organic = verifications.filter((v) => v.signals.inOrganicRegion).length;
  const organicRatio = verifications.length > 0 ? organic / verifications.length : 0;
  const meanConfidence = verifications.length > 0
    ? verifications.reduce((s, v) => s + v.confidence, 0) / verifications.length
    : 0;
  return {
    passed: blockCount >= 5 && organicRatio >= 0.6 && meanConfidence >= 0.5,
    blockCount,
    organicRatio,
    meanConfidence,
  };
}

export function runGateB(candidate: SynthesizedCandidate): GateBReport {
  const sel = candidate.blockSelector;
  if (!sel || sel.length < 3) {
    return { passed: false, selector: sel, reason: 'selector too short or empty' };
  }
  if (/\#tads|\#tadsb|\[data-text-ad\]/i.test(sel)) {
    return { passed: false, selector: sel, reason: 'matches ad selectors' };
  }
  // Reject pure class-name fallbacks; class names rotate frequently.
  const hasStableAttr = /\[(data-ved|jscontroller|data-hveid)\]/.test(sel);
  if (!hasStableAttr && candidate.source === 'class-fallback') {
    return { passed: false, selector: sel, reason: 'class-only fallback (less stable)' };
  }
  return { passed: true, selector: sel, reason: 'stable attribute or acceptable fallback' };
}

export function runGateC(llm: LLMRepairOutput): GateCReport {
  return {
    passed: llm.confidence !== 'low' && (llm.decision === 'approve_candidate' || llm.decision === 'propose_new'),
    llmConfidence: llm.confidence,
    decision: llm.decision,
  };
}

export function runTripleGate(
  blockCount: number,
  verifications: GeometricVerification[],
  candidate: SynthesizedCandidate,
  llm: LLMRepairOutput,
): TripleGateReport {
  const gateA = runGateA(blockCount, verifications);
  const gateB = runGateB(candidate);
  const gateC = runGateC(llm);
  return {
    gateA,
    gateB,
    gateC,
    passed: gateA.passed && gateB.passed && gateC.passed,
  };
}

export interface EmpiricalQueryResult {
  query: string;
  passed: boolean;
  resultsCount: number;
  geometricMean: number;
  reason?: string;
}

export interface EmpiricalReport {
  queries: EmpiricalQueryResult[];
  passedCount: number;
  totalCount: number;
  verdict: 'apply' | 'caution_flag' | 'escalate';
}

export function evaluateEmpirical(results: EmpiricalQueryResult[]): EmpiricalReport {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  let verdict: EmpiricalReport['verdict'];
  if (passed === total && total >= 3) verdict = 'apply';
  else if (passed >= 2) verdict = 'caution_flag';
  else verdict = 'escalate';
  return { queries: results, passedCount: passed, totalCount: total, verdict };
}

export function evaluateQuery(
  query: string,
  resultsCount: number,
  verifications: GeometricVerification[],
  minResults = 3,
): EmpiricalQueryResult {
  const geometricMean = verifications.length > 0
    ? verifications.reduce((s, v) => s + v.confidence, 0) / verifications.length
    : 0;
  if (resultsCount < minResults) {
    return {
      query, passed: false, resultsCount, geometricMean,
      reason: `results count ${resultsCount} < min ${minResults}`,
    };
  }
  if (geometricMean < 0.5) {
    return {
      query, passed: false, resultsCount, geometricMean,
      reason: `geometric mean ${geometricMean.toFixed(2)} < 0.5`,
    };
  }
  return { query, passed: true, resultsCount, geometricMean };
}

export interface FixDecision {
  shouldOpenPR: boolean;
  caution: boolean;
  selector: string;
  evidence: {
    tripleGate: TripleGateReport;
    empirical: EmpiricalReport;
  };
}

export function decideFix(
  candidate: SynthesizedCandidate,
  tripleGate: TripleGateReport,
  empirical: EmpiricalReport,
): FixDecision {
  if (!tripleGate.passed) {
    return {
      shouldOpenPR: false,
      caution: false,
      selector: candidate.blockSelector,
      evidence: { tripleGate, empirical },
    };
  }
  if (empirical.verdict === 'escalate') {
    return {
      shouldOpenPR: false,
      caution: false,
      selector: candidate.blockSelector,
      evidence: { tripleGate, empirical },
    };
  }
  return {
    shouldOpenPR: true,
    caution: empirical.verdict === 'caution_flag',
    selector: candidate.blockSelector,
    evidence: { tripleGate, empirical },
  };
}

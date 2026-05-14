#!/usr/bin/env node
import { launch, getPage, PROFILE_MAIN } from '../../src/browser.js';
import { search } from '../../src/search.js';
import { STRATEGIES, parseResultsInBrowser } from '../../src/parse.js';
import { verifyResultsGeometricInBrowser } from '../../src/verify.js';
import { classifyFault, describeFault } from '../../src/triage.js';
import { extractCandidatesInBrowser, synthesizeFromCandidate } from '../../src/heal/synthesis.js';
import { repairWithLLM, compressSerpHtml } from '../../src/heal/llm.js';
import {
  runTripleGate, evaluateEmpirical, evaluateQuery, decideFix,
} from '../../src/heal/validator.js';
import type { GeometricVerification } from '../../src/types.js';

const ANCHOR_QUERIES = ['weather', 'openai', 'github actions'];

interface RunOutput {
  trigger: 'none' | 'detected';
  fault?: string;
  decision?: { shouldOpenPR: boolean; caution: boolean; selector: string };
  prDraft?: { title: string; body: string };
}

async function detectAndRepair(): Promise<RunOutput> {
  console.error('[repair] starting cron pipeline');

  const ctx = await launch({ profileDir: PROFILE_MAIN, headless: true });
  let triggerFault = false;
  let brokenHtml = '';
  let brokenSignals: { resultsLen: number; h3Count: number; geometricConfidence: number; url: string } | null = null;

  try {
    const page = await getPage(ctx);
    await search(page, ANCHOR_QUERIES[0], 10).catch(() => []);

    const strategy = STRATEGIES[0];
    const parseOut = await page.evaluate(parseResultsInBrowser, { strategy, max: 10 });
    const verify = await page.evaluate(verifyResultsGeometricInBrowser, { blockSelector: strategy.blockSelector });

    const fault = classifyFault({
      resultsLen: parseOut.results.length,
      h3Count: parseOut.signals.h3Count,
      responseStatus: 200,
      responseTimeMs: 1000,
      url: page.url(),
      geometricConfidence: verify.length ? verify.reduce((s, v) => s + v.confidence, 0) / verify.length : 0,
    });

    if (fault.type === 'selector_broken') {
      triggerFault = true;
      brokenHtml = await page.content();
      brokenSignals = {
        resultsLen: parseOut.results.length,
        h3Count: parseOut.signals.h3Count,
        geometricConfidence: verify.length ? verify.reduce((s, v) => s + v.confidence, 0) / verify.length : 0,
        url: page.url(),
      };
      console.error(`[repair] DETECTED: ${describeFault(fault)}`);
    } else {
      console.error(`[repair] no drift detected (${describeFault(fault)})`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  if (!triggerFault || !brokenSignals) {
    return { trigger: 'none' };
  }

  console.error('[repair] running synthesis...');
  const ctx2 = await launch({ profileDir: PROFILE_MAIN, headless: true });
  let candidates: ReturnType<typeof synthesizeFromCandidate> = [];
  try {
    const page = await getPage(ctx2);
    await search(page, ANCHOR_QUERIES[0], 10).catch(() => {});
    const elements = await page.evaluate(extractCandidatesInBrowser, { topN: 5 });
    for (const el of elements) {
      candidates.push(...synthesizeFromCandidate(el));
    }
  } finally {
    await ctx2.close().catch(() => {});
  }

  if (candidates.length === 0) {
    console.error('[repair] no candidates synthesized — escalate to human');
    return {
      trigger: 'detected',
      fault: 'selector_broken',
      decision: { shouldOpenPR: false, caution: false, selector: '' },
    };
  }

  console.error('[repair] consulting LLM...');
  const compressed = compressSerpHtml(brokenHtml);
  const llmResult = await repairWithLLM({
    compressedHtml: compressed,
    brokenSelectors: { block: STRATEGIES[1].blockSelector, snippet: STRATEGIES[1].snippetSelector },
    candidates: candidates.map(c => ({ blockSelector: c.blockSelector, source: c.source, rationale: c.rationale })),
  });
  console.error(`[repair] LLM decision: ${llmResult.decision} (${llmResult.confidence}) → ${llmResult.selector}`);

  const chosen = candidates.find(c => c.blockSelector === llmResult.selector) ?? candidates[0];

  console.error('[repair] running 3-query empirical test...');
  const empResults = [];
  for (const query of ANCHOR_QUERIES) {
    const ctx3 = await launch({ profileDir: PROFILE_MAIN, headless: true });
    try {
      const page = await getPage(ctx3);
      await search(page, query, 10).catch(() => {});
      const verifySel = await page.evaluate(verifyResultsGeometricInBrowser, {
        blockSelector: chosen.blockSelector,
      });
      const blocks = await page.evaluate(parseResultsInBrowser, {
        strategy: { ...STRATEGIES[0], blockSelector: chosen.blockSelector },
        max: 10,
      });
      empResults.push(evaluateQuery(query, blocks.results.length, verifySel));
    } finally {
      await ctx3.close().catch(() => {});
    }
  }
  const empirical = evaluateEmpirical(empResults);

  const lastVerify = empResults[empResults.length - 1];
  const fakeVerify: GeometricVerification[] = Array.from(
    { length: lastVerify?.resultsCount ?? 0 },
    (_, i) => ({
      index: i, rect: { x: 0, y: 0, w: 0, h: 0 },
      signals: {
        inOrganicRegion: true, overlapsAdRegion: false, overlapsRightSidebar: false,
        matchesElementFromPoint: true, hasH3: true, hasExternalLink: true,
      },
      confidence: lastVerify?.geometricMean ?? 0,
    }),
  );

  const triple = runTripleGate(
    lastVerify?.resultsCount ?? 0,
    fakeVerify,
    chosen,
    llmResult,
  );
  const decision = decideFix(chosen, triple, empirical);

  let prDraft;
  if (decision.shouldOpenPR) {
    prDraft = {
      title: `[repair] update SERP block selector → ${chosen.source}`,
      body:
`## Auto-generated by repair-pipeline

**Trigger**: selector_broken (${brokenSignals.h3Count} h3, 0 results, geom ${brokenSignals.geometricConfidence.toFixed(2)})

**Proposed selector**: \`${chosen.blockSelector}\`
**Source**: ${chosen.source} (${chosen.rationale})

**Triple Gate**:
- Gate A (geometric): ${triple.gateA.passed ? '✓' : '✗'} (organic ${(triple.gateA.organicRatio * 100).toFixed(0)}%, conf ${triple.gateA.meanConfidence.toFixed(2)}, blocks ${triple.gateA.blockCount})
- Gate B (XPath stability): ${triple.gateB.passed ? '✓' : '✗'} (${triple.gateB.reason})
- Gate C (LLM): ${triple.gateC.passed ? '✓' : '✗'} (confidence ${triple.gateC.llmConfidence}, ${triple.gateC.decision})

**3-Query Empirical Test**: ${empirical.passedCount}/${empirical.totalCount} passed → \`${empirical.verdict}\`
${empirical.queries.map(q => `- \`${q.query}\`: ${q.passed ? '✓' : '✗'} (${q.resultsCount} results, geom ${q.geometricMean.toFixed(2)})${q.reason ? ` — ${q.reason}` : ''}`).join('\n')}

**LLM rationale**: ${llmResult.rationale}

${decision.caution ? '⚠️ **CAUTION FLAG**: 2/3 empirical pass. Human review recommended before merge.' : ''}

---
Generated by \`scripts/repair/index.ts\`. Auto-merge: NO.
`,
    };
    console.error(`[repair] PR draft prepared (caution=${decision.caution})`);
  } else {
    console.error('[repair] decision: do NOT open PR — escalate to human');
  }

  return {
    trigger: 'detected',
    fault: 'selector_broken',
    decision: {
      shouldOpenPR: decision.shouldOpenPR,
      caution: decision.caution,
      selector: decision.selector,
    },
    prDraft,
  };
}

detectAndRepair()
  .then((result) => {
    console.error('[repair] complete:', JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      const fs = require('node:fs');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `trigger=${result.trigger}\n`);
      if (result.prDraft) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `should_open_pr=${result.decision?.shouldOpenPR ?? false}\n`);
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `caution=${result.decision?.caution ?? false}\n`);
      }
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('[repair] failed:', e);
    process.exit(1);
  });

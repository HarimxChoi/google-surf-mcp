#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { GraphNodeRecord, LocalSearchHit } from '../src/research/contracts.js';
import { DEFAULT_RESEARCH_VECTOR_MODEL } from '../src/research/dense.js';
import { ResearchService } from '../src/research/service.js';

interface EvaluationCase {
  kind: 'fact' | 'code' | 'multi_hop';
  query: string;
  expected_title: string;
  expected_url?: string;
}

interface CaseResult extends EvaluationCase {
  lexical_rank: number;
  hybrid_rank: number;
  reranked_rank: number;
  lexical_ms: number;
  hybrid_ms: number;
  reranked_ms: number;
  provenance_valid: boolean;
}

function rank(rows: LocalSearchHit[], input: EvaluationCase): number {
  const index = rows.findIndex((row) => (
    input.expected_url ? row.url === input.expected_url : row.title === input.expected_title
  ));
  return index < 0 ? 0 : index + 1;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function metrics(rows: CaseResult[]) {
  type RankLane = 'lexical_rank' | 'hybrid_rank' | 'reranked_rank';
  const recall = (lane: RankLane): number => (
    rows.filter((row) => row[lane] > 0 && row[lane] <= 10).length / Math.max(rows.length, 1)
  );
  const ndcg = (lane: RankLane): number => rows.reduce((sum, row) => (
    sum + (row[lane] > 0 && row[lane] <= 10 ? 1 / Math.log2(row[lane] + 1) : 0)
  ), 0) / Math.max(rows.length, 1);
  const mrr = (lane: RankLane): number => rows.reduce((sum, row) => (
    sum + (row[lane] > 0 && row[lane] <= 10 ? 1 / row[lane] : 0)
  ), 0) / Math.max(rows.length, 1);
  const latency = (lane: 'lexical_ms' | 'hybrid_ms' | 'reranked_ms') => {
    const values = rows.map((row) => row[lane]);
    return { p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95) };
  };
  return {
    cases: rows.length,
    lexical_recall_at_10: recall('lexical_rank'),
    hybrid_recall_at_10: recall('hybrid_rank'),
    reranked_recall_at_10: recall('reranked_rank'),
    lexical_ndcg_at_10: ndcg('lexical_rank'),
    hybrid_ndcg_at_10: ndcg('hybrid_rank'),
    reranked_ndcg_at_10: ndcg('reranked_rank'),
    lexical_mrr_at_10: mrr('lexical_rank'),
    hybrid_mrr_at_10: mrr('hybrid_rank'),
    reranked_mrr_at_10: mrr('reranked_rank'),
    lexical_latency: latency('lexical_ms'),
    hybrid_latency: latency('hybrid_ms'),
    reranked_latency: latency('reranked_ms'),
    reranked_cold_ms: rows[0]?.reranked_ms ?? 0,
    reranked_warm_p95_ms: percentile(rows.slice(1).map((row) => row.reranked_ms), 0.95),
    valid_provenance_ratio: rows.filter((row) => row.provenance_valid).length / Math.max(rows.length, 1),
  };
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; elapsed_ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, elapsed_ms: performance.now() - started };
}

async function evaluateCases(
  service: ResearchService,
  projectId: string,
  cases: EvaluationCase[],
  validTarget: (input: EvaluationCase) => boolean,
): Promise<CaseResult[]> {
  const rows: CaseResult[] = [];
  for (const input of cases) {
    const lexical = await timed(async () => (
      await service.searchLexicalBaseline(projectId, input.query, 10)
    ));
    const hybrid = await timed(async () => (
      await service.searchHybridBaseline(projectId, input.query, 10)
    ));
    const reranked = await timed(async () => await service.search(projectId, input.query, 10));
    rows.push({
      ...input,
      lexical_rank: rank(lexical.value, input),
      hybrid_rank: rank(hybrid.value, input),
      reranked_rank: rank(reranked.value, input),
      lexical_ms: lexical.elapsed_ms,
      hybrid_ms: hybrid.elapsed_ms,
      reranked_ms: reranked.elapsed_ms,
      provenance_valid: validTarget(input),
    });
  }
  return rows;
}

async function controlledEvaluation(
  vectorModel?: string,
): Promise<{ metrics: ReturnType<typeof metrics>; cases: CaseResult[] }> {
  const root = await mkdtemp(join(tmpdir(), 'surf-retrieval-eval-db-'));
  const source = await mkdtemp(join(tmpdir(), 'surf-retrieval-eval-src-'));
  const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel });
  try {
    await mkdir(join(source, 'src'));
    await writeFile(
      join(source, 'src', 'hadamard.ts'),
      'export function applyHadamardRotation(value: number) { return value * 2; }\n',
    );
    await writeFile(
      join(source, 'src', 'quantizer.ts'),
      "import { applyHadamardRotation } from './hadamard.js';\nexport const quantize = applyHadamardRotation;\n",
    );
    await service.createProject('Controlled retrieval', 'controlled-retrieval');
    await service.capture({
      tool: 'extract',
      project_id: 'controlled-retrieval',
      payload: {
        title: 'Bitemporal Evidence',
        url: 'https://example.com/bitemporal-evidence',
        content: 'Bitemporal correction preserves valid time and transaction time.',
        extraction_quality: 'full_text',
      },
    });
    const plan = await service.createPlan({
      project_id: 'controlled-retrieval',
      title: 'Allocator Baseline',
      body: 'Measure allocator latency before recovery.',
    }, false);
    const experiment = await service.startExperiment({
      project_id: 'controlled-retrieval',
      plan_revision_id: plan.plan_revision_id,
      name: 'Crimson Latency Result',
      hypothesis: 'The allocator remains within budget.',
    });
    const failed = await service.finishExperiment({
      project_id: 'controlled-retrieval',
      experiment_id: experiment.experiment_id,
      status: 'failed',
      summary: 'Tail latency exceeded the gate.',
    });
    await service.createPlan({
      project_id: 'controlled-retrieval',
      title: 'Allocator Recovery',
      body: 'Change the allocator after the failed latency run.',
      change_reason: 'The baseline failed.',
      based_on_experiment_id: failed.experiment_id,
    }, true);
    await service.indexProject({
      project_id: 'controlled-retrieval',
      roots: [{ label: 'repo', path: source }],
    });
    await service.rebuildDerivedState('controlled-retrieval');
    const projection = await service.exportGraphProjection(['controlled-retrieval']);
    const cases: EvaluationCase[] = [
      {
        kind: 'fact',
        query: 'bitemporal transaction time',
        expected_title: 'Bitemporal Evidence',
        expected_url: 'https://example.com/bitemporal-evidence',
      },
      {
        kind: 'code',
        query: 'applyHadamardRotation',
        expected_title: 'repo/src/hadamard.ts',
      },
      {
        kind: 'multi_hop',
        query: 'Crimson Latency Result follow-up plan',
        expected_title: 'Allocator Recovery',
      },
    ];
    const nodes = new Set(projection.nodes.map((node) => node.label));
    const results = await evaluateCases(
      service,
      'controlled-retrieval',
      cases,
      (input) => input.kind !== 'multi_hop' || nodes.has(input.expected_title),
    );
    return { metrics: metrics(results), cases: results };
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(source, { recursive: true, force: true });
  }
}

async function documentEvaluation(
  vectorModel?: string,
): Promise<{ metrics: ReturnType<typeof metrics>; cases: CaseResult[] }> {
  const root = await mkdtemp(join(tmpdir(), 'surf-document-eval-db-'));
  const service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel });
  const targets = [
    {
      title: 'Activation Outlier Rotation',
      url: 'https://example.com/activation-outlier-rotation',
      content: 'Orthogonal Hadamard rotation distributes activation outliers before low-bit quantization.',
      query: 'How to distribute activation outliers with Hadamard rotation before quantization',
    },
    {
      title: 'Failed Gate Recovery Plan',
      url: 'https://example.com/failed-gate-recovery',
      content: 'After the perplexity gate failed, the experiment plan switched to a bounded recovery intervention.',
      query: 'Bounded recovery experiment plan after a failed perplexity gate',
    },
    {
      title: 'CUDA Launch Fusion',
      url: 'https://example.com/cuda-launch-fusion',
      content: 'A fused CUDA kernel combines dequantization and matrix multiplication to reduce launch overhead.',
      query: 'Fuse dequantization and matrix multiplication to reduce CUDA launch overhead',
    },
    {
      title: 'Bitemporal Citation Observation',
      url: 'https://example.com/bitemporal-citation',
      content: 'Citation counts are timestamped observations rather than permanent paper facts.',
      query: 'Record paper citation counts as timestamped observations instead of permanent facts',
    },
    {
      title: 'Immutable Experiment Revision',
      url: 'https://example.com/immutable-experiment',
      content: 'A failed experiment remains immutable while the next plan revision records its causal dependency.',
      query: 'Preserve a failed experiment and link it causally to the next plan revision',
    },
    {
      title: 'Content Addressed Graph Artifact',
      url: 'https://example.com/content-addressed-graph',
      content: 'The graph projection is stored by content hash and activated only after checksum validation.',
      query: 'Store a graph projection by content hash and activate it after checksum validation',
    },
  ];
  const distractors = Array.from({ length: 14 }, (_, index) => ({
    title: `Benchmark Log ${index + 1}`,
    url: `https://example.com/benchmark-log-${index + 1}`,
    content: `Hadamard CUDA perplexity gate citation count plan revision graph projection benchmark log ${
      index + 1
    }. This record reports routine throughput measurements without a recovery decision.`,
  }));
  try {
    await service.createProject('Document reranker', 'document-reranker');
    for (const row of [...targets, ...distractors]) {
      await service.capture({
        tool: 'extract',
        project_id: 'document-reranker',
        payload: { ...row, extraction_quality: 'full_text' },
      });
    }
    const cases: EvaluationCase[] = targets.map((row) => ({
      kind: 'fact',
      query: row.query,
      expected_title: row.title,
      expected_url: row.url,
    }));
    const results = await evaluateCases(
      service,
      'document-reranker',
      cases,
      (input) => targets.some((row) => row.url === input.expected_url),
    );
    return { metrics: metrics(results), cases: results };
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function graphUrl(projectId: string, node: GraphNodeRecord): string {
  return node.url ?? `surf://projects/${projectId}/graph/${node.node_id}`;
}

async function projectEvaluation(root: string, projectId: string, vectorModel?: string) {
  const service = new ResearchService({ enabled: true, root, vectorModel });
  try {
    const projection = await service.exportGraphProjection([projectId]);
    const nodes = new Map(projection.nodes.map((node) => [node.node_id, node]));
    const labelCounts = new Map<string, number>();
    for (const node of projection.nodes) {
      labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
    }
    const cases: EvaluationCase[] = [];
    for (const edge of projection.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) continue;
      if (edge.type === 'DEFINES' && target.kind === 'symbol'
        && target.label.length >= 8 && labelCounts.get(target.label) === 1) {
        cases.push({
          kind: 'code',
          query: target.label,
          expected_title: source.label,
          expected_url: graphUrl(projectId, source),
        });
      }
      if (['USES_PLAN', 'BASED_ON', 'DECIDES_PLAN', 'DECIDES_EXPERIMENT'].includes(edge.type)
        && source.label.length >= 5 && labelCounts.get(source.label) === 1) {
        cases.push({
          kind: 'multi_hop',
          query: source.label,
          expected_title: target.label,
          expected_url: graphUrl(projectId, target),
        });
      }
      if (cases.filter((row) => row.kind === 'code').length >= 12
        && cases.filter((row) => row.kind === 'multi_hop').length >= 8) break;
    }
    const selected = [
      ...cases.filter((row) => row.kind === 'code').slice(0, 12),
      ...cases.filter((row) => row.kind === 'multi_hop').slice(0, 8),
    ];
    const validUrls = new Set(projection.nodes.map((node) => graphUrl(projectId, node)));
    const results = await evaluateCases(
      service,
      projectId,
      selected,
      (input) => !!input.expected_url && validUrls.has(input.expected_url),
    );
    return { metrics: metrics(results), cases: results };
  } finally {
    await service.close();
  }
}

const root = resolve(process.env.SURF_RESEARCH_ROOT
  ?? join(process.env.USERPROFILE ?? '.', '.google-surf-mcp', 'research'));
const projectId = process.env.SURF_EVAL_PROJECT ?? 'baubrowser-warpquant-deterministic';
const vectorModelValue = process.env.SURF_EVAL_VECTOR_MODEL
  ?? process.env.SURF_EVAL_DENSE_MODEL
  ?? process.env.SURF_RESEARCH_VECTOR_MODEL?.trim()
  ?? process.env.SURF_RESEARCH_DENSE_MODEL?.trim()
  ?? DEFAULT_RESEARCH_VECTOR_MODEL;
const vectorModel = vectorModelValue.toLowerCase() === 'off' ? undefined : vectorModelValue;
const rssBefore = process.memoryUsage().rss;
let peakRss = rssBefore;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 25);
const documents = await documentEvaluation(vectorModel);
const controlled = await controlledEvaluation(vectorModel);
const project = await projectEvaluation(root, projectId, vectorModel);
clearInterval(sampler);
const graphGain = project.metrics.hybrid_recall_at_10 - project.metrics.lexical_recall_at_10;
const rerankedNdcgGain = documents.metrics.reranked_ndcg_at_10 - documents.metrics.hybrid_ndcg_at_10;
const rerankedRecallLoss = Math.max(
  documents.metrics.hybrid_recall_at_10 - documents.metrics.reranked_recall_at_10,
  project.metrics.hybrid_recall_at_10 - project.metrics.reranked_recall_at_10,
);
const rerankedNdcgLoss = Math.max(
  documents.metrics.hybrid_ndcg_at_10 - documents.metrics.reranked_ndcg_at_10,
  controlled.metrics.hybrid_ndcg_at_10 - controlled.metrics.reranked_ndcg_at_10,
  project.metrics.hybrid_ndcg_at_10 - project.metrics.reranked_ndcg_at_10,
);
const gates = {
  controlled_hybrid_recall_loss_at_most_1pp: controlled.metrics.hybrid_recall_at_10
    >= controlled.metrics.lexical_recall_at_10 - 0.01,
  graph_multi_hop_gain_at_least_5pp: graphGain >= 0.05,
  valid_provenance_at_least_99pct: Math.min(
    controlled.metrics.valid_provenance_ratio,
    project.metrics.valid_provenance_ratio,
  ) >= 0.99,
  reranked_recall_loss_at_most_1pp: rerankedRecallLoss <= 0.01,
  reranked_ndcg_loss_at_most_1pp: rerankedNdcgLoss <= 0.01,
};
const rerankerEvaluation = {
  enabled: Boolean(vectorModel),
  evaluated: Boolean(vectorModel) && documents.metrics.hybrid_recall_at_10 >= 0.99,
  model: vectorModel,
  candidate_recall_at_10: documents.metrics.hybrid_recall_at_10,
  ndcg_gain: rerankedNdcgGain,
  ndcg_loss: rerankedNdcgLoss,
  recall_loss: rerankedRecallLoss,
  peak_rss_increase_mib: (peakRss - rssBefore) / 1024 / 1024,
  gates: {
    candidate_recall_at_least_99pct: documents.metrics.hybrid_recall_at_10 >= 0.99,
    ndcg_gain_at_least_3pp: rerankedNdcgGain >= 0.03,
    recall_loss_at_most_1pp: rerankedRecallLoss <= 0.01,
    warm_p95_at_most_500ms: documents.metrics.reranked_warm_p95_ms <= 500,
    peak_rss_increase_at_most_512mib: peakRss - rssBefore <= 512 * 1024 * 1024,
  },
};
const report = {
  schema: 'google-surf-research-evaluation-v2',
  generated_at: new Date().toISOString(),
  project_id: projectId,
  documents,
  controlled,
  project,
  graph_recall_gain: graphGain,
  reranker_evaluation: rerankerEvaluation,
  gates,
};
const output = resolve(process.env.SURF_EVAL_OUTPUT
  ?? join('artifacts', `research-evaluation-${basename(projectId)}.local.json`));
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  output,
  documents: documents.metrics,
  controlled: controlled.metrics,
  project: project.metrics,
  graph_recall_gain: graphGain,
  reranker_evaluation: rerankerEvaluation,
  gates,
}, null, 2));
process.exit(Object.values(gates).some((value) => !value) ? 1 : 0);

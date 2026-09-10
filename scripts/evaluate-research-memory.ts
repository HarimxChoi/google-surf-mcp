#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { GraphNodeRecord, LocalSearchHit } from '../src/research/contracts.js';
import { DEFAULT_RESEARCH_VECTOR_MODEL } from '../src/research/dense.js';
import { ResearchService } from '../src/research/service.js';

interface EvaluationCase {
  kind: 'fact' | 'code' | 'multi_hop';
  stratum?: 'document' | 'code' | 'typed_graph';
  query: string;
  expected_title: string;
  expected_url?: string;
  expected_record_id?: string;
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
  const provenanceRows = rows.filter((row) => row.reranked_rank > 0 && row.reranked_rank <= 10);
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
    valid_provenance_ratio: provenanceRows.filter((row) => row.provenance_valid).length
      / Math.max(provenanceRows.length, 1),
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
  validTarget: (input: EvaluationCase, rows: LocalSearchHit[]) => boolean | Promise<boolean>,
): Promise<CaseResult[]> {
  const rows: CaseResult[] = [];
  for (const input of cases) {
    const lexical = await timed(async () => (
      await service.searchLexicalBaseline(projectId, input.query, 10)
    ));
    const searched = await timed(async () => await service.searchBatch(
      projectId,
      input.query,
      [],
      10,
      [],
      undefined,
      undefined,
      true,
      true,
    ));
    const hybrid = searched.value.pre_rerank_results ?? [];
    const reranked = searched.value.results;
    rows.push({
      ...input,
      lexical_rank: rank(lexical.value, input),
      hybrid_rank: rank(hybrid, input),
      reranked_rank: rank(reranked, input),
      lexical_ms: lexical.elapsed_ms,
      hybrid_ms: searched.value.timings.embedding_ms + searched.value.timings.retrieval_ms,
      reranked_ms: searched.elapsed_ms,
      provenance_valid: await validTarget(input, reranked),
    });
  }
  return rows;
}

const ACCEPTANCE_DOCUMENTS = [
  ['Activation Outlier Rotation', 'Orthogonal rotation distributes activation outliers before low-bit quantization.', 'How can activation outliers be spread before low-bit quantization?'],
  ['Bitemporal Assertion Correction', 'A correction preserves both effective time and recorded transaction time.', 'How should corrected facts retain valid and transaction time?'],
  ['Content Addressed Artifact', 'An artifact manifest is keyed by canonical bytes and verified with a checksum.', 'How is an artifact manifest tied to canonical bytes and checksum verification?'],
  ['Atomic Retrieval Generation', 'Readers observe either the old complete retrieval generation or the new complete generation.', 'How do readers avoid a partially published search index?'],
  ['Personalized Graph Walk', 'Query-time Personalized PageRank starts from evidence seeds and follows typed relations.', 'Which graph walk starts from query evidence seeds?'],
  ['Reciprocal Rank Fusion', 'Reciprocal Rank Fusion combines exact, lexical, semantic, graph, and live result lanes.', 'How are exact lexical semantic graph and live lanes combined?'],
  ['Schema Identity Bridge', 'A stable identifier creates a cross-project identity bridge without moving source records.', 'How can projects share an entity without merging their source records?'],
  ['Immutable Failed Attempt', 'A failed attempt remains immutable while a later plan records the causal response.', 'How is a failed run preserved when the next plan changes?'],
  ['Delta Root Registry', 'Adding one registered root does not remove unrelated roots from the project inventory.', 'What prevents a new source root from replacing previous roots?'],
  ['UTF8 Byte Paging', 'Body pages align offsets to UTF-8 code point boundaries for byte-exact reconstruction.', 'How can paged multilingual text avoid broken Unicode characters?'],
  ['Broker Read Coalescing', 'Concurrent identical reads share one broker operation while subscribers remain isolated.', 'How are duplicate local reads shared across MCP clients?'],
  ['Idle Worker Drain', 'The database worker drains after completed work and reconnects on the next request.', 'How is resident database memory released between research requests?'],
  ['Artifact Restore Closure', 'Archive verification distinguishes upload completion from dependency-complete restoration.', 'Why is a successful upload insufficient proof of recoverability?'],
  ['Typed Parallel Edge', 'Parallel graph edges remain distinct when qualifiers evidence or temporal validity differ.', 'When must two edges between the same nodes remain separate?'],
  ['Section Tail Coverage', 'Long records are chunked with source spans so semantic search can retrieve evidence near the tail.', 'How does semantic retrieval find details at the end of a long record?'],
  ['Secret Content Exclusion', 'Sensitive paths and detected credential patterns are excluded before indexing.', 'At what stage should secrets be removed from project indexing?'],
  ['Current Plan Pointer', 'The project stores a direct current-plan pointer while preserving every prior revision.', 'How can current work be read without deleting old plans?'],
  ['Remote Payload State', 'A remote artifact may be declared unavailable while its manifest and provenance remain searchable.', 'How is an unavailable remote artifact represented without pretending it is restored?'],
  ['Graph Cache Weight', 'Graph cache eviction is based on estimated bytes rather than entry count alone.', 'Why should graph cache eviction use byte weight?'],
  ['Embedding Identity Reuse', 'Embedding identity includes content hash model dimensions normalization and passage role.', 'Which fields make a cached embedding safe to reuse?'],
] as const;

const ACCEPTANCE_CODE = [
  ['applyHadamardRotation', 'distribute activation magnitudes before quantization'],
  ['publishRetrievalGeneration', 'atomically publish an indexed generation'],
  ['verifyArtifactChecksum', 'validate a content addressed artifact'],
  ['alignUtf8PageBoundary', 'page a body without splitting a code point'],
  ['coalesceBrokerRead', 'share an identical concurrent read'],
  ['drainIdleResearchWorker', 'release an idle embedded database worker'],
  ['resolveSchemaIdentity', 'link stable identifiers across projects'],
  ['appendCatalogRevision', 'preserve immutable record history'],
  ['materializeCurrentPlan', 'write a compact current project view'],
  ['streamArtifactManifest', 'page a large reference manifest'],
  ['classifySensitiveSource', 'exclude credential bearing input'],
  ['compactGraphAdjacency', 'build typed array CSR adjacency'],
  ['rankPersonalizedNeighbors', 'run a seeded graph walk'],
  ['fuseReciprocalRanks', 'combine independent retrieval lanes'],
  ['reuseCanonicalEmbedding', 'reuse vectors by semantic content identity'],
  ['registerProjectRoot', 'merge a source root without replacement'],
  ['recordTemporalCorrection', 'retain effective and recorded times'],
  ['restoreCatalogSnapshot', 'append a rollback revision'],
  ['cancelBackgroundIndexJob', 'cancel one asynchronous indexing job'],
  ['measureProcessTreeRss', 'attribute resident memory to worker roles'],
] as const;

const ACCEPTANCE_METHODS = [
  ['Typed Evidence Projection', 'Build a typed evidence graph from durable catalog revisions.'],
  ['Stable Identifier Linking', 'Link cross-project entities only through verified identifiers or explicit aliases.'],
  ['Revision Preserving Correction', 'Correct a record by appending a revision instead of overwriting history.'],
  ['Generation Aware Eviction', 'Evict derived graph and vector cache entries by generation and byte weight.'],
  ['Bounded Neighborhood Expansion', 'Page graph neighborhoods while preserving continuation and edge qualifiers.'],
  ['Manifest First Archive Lookup', 'Resolve cold artifacts through a searchable local manifest before remote restore.'],
  ['Evidence Backed Assertion', 'Require source evidence paths for durable assertions.'],
  ['Item Delta Indexing', 'Update only changed retrieval items and affected code relations.'],
  ['Content Hash Deduplication', 'Deduplicate identical bytes without collapsing distinct experiments.'],
  ['Source Span Retrieval', 'Return exact source spans and a readback handle with ranked evidence.'],
  ['Role Aware Ingestion', 'Use explicit document roles independently of filenames.'],
  ['Broker Authority Hash', 'Reject clients whose storage authority differs from the broker owner.'],
  ['Read Subscriber Isolation', 'Cancel one coalesced read subscriber without cancelling retained subscribers.'],
  ['Protected Parent Preservation', 'Keep protected experimental parents reachable through snapshot rollback.'],
  ['Remote Artifact Declaration', 'Represent missing remote payload state separately from manifest durability.'],
  ['Temporal As Of Reconstruction', 'Reconstruct catalog state at an effective or recorded time.'],
  ['Exact Record Readback', 'Fetch one durable record by stable ID without returning the full project.'],
  ['Incremental Root Removal', 'Remove one named root while preserving every unrelated registered root.'],
  ['Graph Provenance Round Trip', 'Export edge evidence qualifiers and temporal fields without dropping semantics.'],
  ['Passive Runtime Diagnosis', 'Report worker roles and RSS without opening the embedded database.'],
] as const;

async function acceptanceEvaluation(
  vectorModel?: string,
  vectorBackend: 'hnsw' | 'compact' | 'exhaustive' = 'hnsw',
): Promise<{ metrics: ReturnType<typeof metrics>; cases: CaseResult[]; corpus: Record<string, number> }> {
  const root = await mkdtemp(join(tmpdir(), 'surf-acceptance-eval-db-'));
  const source = await mkdtemp(join(tmpdir(), 'surf-acceptance-eval-src-'));
  const projectId = 'controlled-acceptance';
  const service = new ResearchService({
    enabled: true, root, endpoint: 'mem://', vectorModel, vectorBackend, vectorThreads: 1,
  });
  try {
    await mkdir(join(source, 'src'));
    await service.createProject('Controlled acceptance', projectId);
    for (const [index, [title, content]] of ACCEPTANCE_DOCUMENTS.entries()) {
      await service.capture({
        tool: 'extract',
        project_id: projectId,
        payload: {
          title,
          url: `https://example.com/acceptance/document-${index + 1}`,
          content,
          extraction_quality: 'full_text',
        },
      });
    }
    for (const [index, [symbol, purpose]] of ACCEPTANCE_CODE.entries()) {
      await writeFile(
        join(source, 'src', `acceptance-${String(index + 1).padStart(2, '0')}.ts`),
        `/** ${purpose}. */\nexport function ${symbol}(): string { return '${symbol}'; }\n`,
      );
    }
    for (const [index, [title, body]] of ACCEPTANCE_METHODS.entries()) {
      await service.writeCatalogRecord({
        project_id: projectId,
        kind: 'method',
        operation: 'create',
        asset_id: `acceptance-method-${index + 1}`,
        expected_revision: 0,
        idempotency_key: `acceptance-method-${index + 1}`,
        body,
        fields: { title, summary: body },
        source_reference: 'controlled-acceptance-fixture',
      });
    }
    await service.indexProject({
      project_id: projectId,
      roots: [{ label: 'repo', path: source, role: 'source' }],
    });
    await service.waitForIdle();
    await service.rebuildDerivedState(projectId);
    const projection = await service.exportGraphProjection([projectId]);
    const graphNodes = new Map(projection.nodes.map((node) => [node.label, node]));
    const documentCases: EvaluationCase[] = ACCEPTANCE_DOCUMENTS.map(([title, , query], index) => ({
      kind: 'fact',
      stratum: 'document',
      query,
      expected_title: title,
      expected_url: `https://example.com/acceptance/document-${index + 1}`,
    }));
    const codeCases: EvaluationCase[] = ACCEPTANCE_CODE.map(([symbol], index) => ({
      kind: 'code',
      stratum: 'code',
      query: symbol,
      expected_title: `repo/src/acceptance-${String(index + 1).padStart(2, '0')}.ts`,
    }));
    const graphCases: EvaluationCase[] = ACCEPTANCE_METHODS.map(([title], index) => {
      const node = graphNodes.get(title);
      if (!node) throw new Error(`controlled graph target missing: ${title}`);
      return {
        kind: 'multi_hop',
        stratum: 'typed_graph',
        query: title,
        expected_title: title,
        expected_url: graphUrl(projectId, node),
        expected_record_id: `acceptance-method-${index + 1}`,
      };
    });
    const cases = [...documentCases, ...codeCases, ...graphCases];
    const results = await evaluateCases(service, projectId, cases, async (input, rows) => {
      const hit = rows.find((row) => (
        input.expected_url ? row.url === input.expected_url : row.title === input.expected_title
      ));
      if (!hit) return false;
      const handle = input.expected_record_id ?? hit.body_handle ?? hit.record_id;
      if (!handle) return false;
      try {
        await service.getCatalogRecord(projectId, handle, undefined, 0, 256);
        return true;
      } catch {
        return false;
      }
    });
    return {
      metrics: metrics(results),
      cases: results,
      corpus: { documents: documentCases.length, code: codeCases.length, typed_graph: graphCases.length },
    };
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(source, { recursive: true, force: true }).catch(() => {});
  }
}

async function controlledEvaluation(
  vectorModel?: string,
  vectorBackend: 'hnsw' | 'compact' | 'exhaustive' = 'hnsw',
): Promise<{ metrics: ReturnType<typeof metrics>; cases: CaseResult[] }> {
  const root = await mkdtemp(join(tmpdir(), 'surf-retrieval-eval-db-'));
  const source = await mkdtemp(join(tmpdir(), 'surf-retrieval-eval-src-'));
  const service = new ResearchService({
    enabled: true, root, endpoint: 'mem://', vectorModel, vectorBackend, vectorThreads: 1,
  });
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
  vectorBackend: 'hnsw' | 'compact' | 'exhaustive' = 'hnsw',
): Promise<{ metrics: ReturnType<typeof metrics>; cases: CaseResult[] }> {
  const root = await mkdtemp(join(tmpdir(), 'surf-document-eval-db-'));
  const service = new ResearchService({
    enabled: true, root, endpoint: 'mem://', vectorModel, vectorBackend, vectorThreads: 1,
  });
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

async function projectEvaluation(
  root: string,
  projectId: string,
  vectorModel?: string,
  vectorBackend: 'hnsw' | 'compact' | 'exhaustive' = 'hnsw',
) {
  const service = new ResearchService({
    enabled: true, root, vectorModel, vectorBackend, vectorThreads: 1,
  });
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
const projectId = process.env.SURF_EVAL_PROJECT?.trim() || undefined;
const vectorModelValue = process.env.SURF_EVAL_VECTOR_MODEL
  ?? process.env.SURF_EVAL_DENSE_MODEL
  ?? process.env.SURF_RESEARCH_VECTOR_MODEL?.trim()
  ?? process.env.SURF_RESEARCH_DENSE_MODEL?.trim()
  ?? DEFAULT_RESEARCH_VECTOR_MODEL;
const vectorModel = vectorModelValue.toLowerCase() === 'off' ? undefined : vectorModelValue;
const vectorBackendValue = process.env.SURF_EVAL_VECTOR_BACKEND?.trim().toLowerCase() ?? 'exhaustive';
if (!['hnsw', 'compact', 'exhaustive'].includes(vectorBackendValue)) {
  throw new Error('SURF_EVAL_VECTOR_BACKEND must be hnsw, compact, or exhaustive');
}
const vectorBackend = vectorBackendValue as 'hnsw' | 'compact' | 'exhaustive';
const rssBefore = process.memoryUsage().rss;
let peakRss = rssBefore;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 25);
const acceptance = await acceptanceEvaluation(vectorModel, vectorBackend);
const documents = await documentEvaluation(vectorModel, vectorBackend);
const controlled = await controlledEvaluation(vectorModel, vectorBackend);
const project = projectId ? await projectEvaluation(root, projectId, vectorModel, vectorBackend) : undefined;
clearInterval(sampler);
const graphGain = project
  ? project.metrics.hybrid_recall_at_10 - project.metrics.lexical_recall_at_10
  : acceptance.metrics.hybrid_recall_at_10 - acceptance.metrics.lexical_recall_at_10;
const rerankedNdcgGain = documents.metrics.reranked_ndcg_at_10 - documents.metrics.hybrid_ndcg_at_10;
const rerankedRecallLoss = Math.max(
  documents.metrics.hybrid_recall_at_10 - documents.metrics.reranked_recall_at_10,
  acceptance.metrics.hybrid_recall_at_10 - acceptance.metrics.reranked_recall_at_10,
  ...(project ? [project.metrics.hybrid_recall_at_10 - project.metrics.reranked_recall_at_10] : []),
);
const rerankedNdcgLoss = Math.max(
  documents.metrics.hybrid_ndcg_at_10 - documents.metrics.reranked_ndcg_at_10,
  controlled.metrics.hybrid_ndcg_at_10 - controlled.metrics.reranked_ndcg_at_10,
  acceptance.metrics.hybrid_ndcg_at_10 - acceptance.metrics.reranked_ndcg_at_10,
  ...(project ? [project.metrics.hybrid_ndcg_at_10 - project.metrics.reranked_ndcg_at_10] : []),
);
const qualityObservations = {
  controlled_hybrid_recall_loss_at_most_1pp: controlled.metrics.hybrid_recall_at_10
    >= controlled.metrics.lexical_recall_at_10 - 0.01,
  graph_multi_hop_gain_at_least_5pp: graphGain >= 0.05,
  valid_provenance_at_least_99pct: Math.min(
    acceptance.metrics.valid_provenance_ratio,
    controlled.metrics.valid_provenance_ratio,
    ...(project ? [project.metrics.valid_provenance_ratio] : []),
  ) >= 0.99,
  reranked_recall_loss_at_most_1pp: rerankedRecallLoss <= 0.01,
  reranked_ndcg_loss_at_most_1pp: rerankedNdcgLoss <= 0.01,
};
const rerankerEvaluation = {
  enabled: Boolean(vectorModel),
  evaluated: Boolean(vectorModel) && documents.metrics.hybrid_recall_at_10 >= 0.99,
  model: vectorModel,
  backend: vectorBackend,
  candidate_recall_at_10: documents.metrics.hybrid_recall_at_10,
  ndcg_gain: rerankedNdcgGain,
  ndcg_loss: rerankedNdcgLoss,
  recall_loss: rerankedRecallLoss,
  peak_rss_increase_mib: (peakRss - rssBefore) / 1024 / 1024,
  observations: {
    candidate_recall_at_least_99pct: documents.metrics.hybrid_recall_at_10 >= 0.99,
    ndcg_gain_at_least_3pp: rerankedNdcgGain >= 0.03,
    recall_loss_at_most_1pp: rerankedRecallLoss <= 0.01,
    warm_p95_at_most_500ms: documents.metrics.reranked_warm_p95_ms <= 500,
    peak_rss_increase_at_most_2gib: peakRss - rssBefore <= 2 * 1024 * 1024 * 1024,
  },
};
const report = {
  schema: 'google-surf-research-evaluation-v3',
  generated_at: new Date().toISOString(),
  evaluation_scope: projectId ? 'controlled_and_project' : 'controlled_only',
  project_id: projectId ?? null,
  vector_backend: vectorBackend,
  methodology: 'Controlled synthetic relevance judgments; optional project cases are graph-derived and must be reviewed before public quality claims.',
  acceptance,
  documents,
  controlled,
  project,
  graph_recall_gain: graphGain,
  reranker_evaluation: rerankerEvaluation,
  quality_observations: qualityObservations,
};
const output = resolve(process.env.SURF_EVAL_OUTPUT
  ?? join('artifacts', `research-evaluation-${basename(projectId ?? 'controlled')}.local.json`));
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  output,
  acceptance: { corpus: acceptance.corpus, metrics: acceptance.metrics },
  documents: documents.metrics,
  controlled: controlled.metrics,
  project: project?.metrics ?? null,
  graph_recall_gain: graphGain,
  reranker_evaluation: rerankerEvaluation,
  quality_observations: qualityObservations,
}, null, 2));
process.exit(0);

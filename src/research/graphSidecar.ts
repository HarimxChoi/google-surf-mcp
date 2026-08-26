import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { MultiDirectedGraph, UndirectedGraph } from 'graphology';
import { connectedComponents, stronglyConnectedComponents } from 'graphology-components';
import { bidirectional } from 'graphology-shortest-path';
import type { GraphAnalysis, GraphEdgeRecord, GraphNodeRecord, GraphProjection } from './contracts.js';

type Louvain = typeof import('graphology-communities-louvain').default;
type PageRank = typeof import('graphology-metrics/centrality/pagerank.js').default;

const require = createRequire(import.meta.url);
const louvain = require('graphology-communities-louvain') as Louvain;
const pagerank = require('graphology-metrics/centrality/pagerank') as PageRank;

export interface GraphRankedNode {
  node: GraphNodeRecord;
  score: number;
}

interface PageRankIndex {
  node_ids: string[];
  positions: Map<string, number>;
  offsets: Uint32Array;
  targets: Uint32Array;
  weights: Float64Array;
  total_weights: Float64Array;
}

const pageRankIndexes = new WeakMap<GraphProjection, Map<boolean, PageRankIndex>>();
const graphTexts = new WeakMap<GraphProjection, string[]>();

const NON_RETRIEVAL_EDGES = new Set([
  'ALIGNS_TO_SCHEMA', 'USES_ONTOLOGY', 'INSTANCE_OF', 'USES_RELATION',
  'HAS_DOCUMENT', 'HAS_PLAN', 'HAS_EXPERIMENT', 'HAS_DECISION', 'HAS_SESSION',
  'HAS_ENTITY', 'HAS_ASSERTION', 'HAS_SOURCE_SNAPSHOT',
]);

export function isRetrievalGraphEdge(edge: GraphEdgeRecord): boolean {
  return !NON_RETRIEVAL_EDGES.has(edge.type);
}

function pageRankIndex(projection: GraphProjection, bidirectional: boolean): PageRankIndex {
  const cached = pageRankIndexes.get(projection)?.get(bidirectional);
  if (cached) return cached;
  const nodeIds = projection.nodes.map((node) => node.node_id);
  const positions = new Map(nodeIds.map((node, index) => [node, index]));
  const degrees = new Uint32Array(nodeIds.length);
  for (const edge of projection.edges) {
    if (!isRetrievalGraphEdge(edge)) continue;
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source === undefined || target === undefined) continue;
    degrees[source]++;
    if (bidirectional) degrees[target]++;
  }
  const offsets = new Uint32Array(nodeIds.length + 1);
  for (let index = 0; index < nodeIds.length; index++) {
    offsets[index + 1] = offsets[index] + degrees[index];
  }
  const targets = new Uint32Array(offsets[nodeIds.length]);
  const weights = new Float64Array(offsets[nodeIds.length]);
  const totalWeights = new Float64Array(nodeIds.length);
  const cursors = offsets.slice(0, nodeIds.length);
  const add = (source: number, target: number, weight: number): void => {
    const offset = cursors[source]++;
    targets[offset] = target;
    weights[offset] = weight;
    totalWeights[source] += weight;
  };
  for (const edge of projection.edges) {
    if (!isRetrievalGraphEdge(edge)) continue;
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source === undefined || target === undefined) continue;
    add(source, target, edge.weight);
    if (bidirectional) add(target, source, edge.weight);
  }
  const index = {
    node_ids: nodeIds,
    positions,
    offsets,
    targets,
    weights,
    total_weights: totalWeights,
  };
  const modes = pageRankIndexes.get(projection) ?? new Map<boolean, PageRankIndex>();
  modes.set(bidirectional, index);
  pageRankIndexes.set(projection, modes);
  return index;
}

function directedGraph(projection: GraphProjection): MultiDirectedGraph {
  const graph = new MultiDirectedGraph();
  for (const node of projection.nodes) graph.addNode(node.node_id, node);
  for (const edge of projection.edges) {
    if (!isRetrievalGraphEdge(edge)) continue;
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.addDirectedEdgeWithKey(edge.edge_id, edge.source, edge.target, {
        type: edge.type,
        weight: edge.weight,
      });
    }
  }
  return graph;
}

function communityGraph(projection: GraphProjection): UndirectedGraph {
  const graph = new UndirectedGraph();
  for (const node of projection.nodes) graph.addNode(node.node_id, node);
  const weights = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of projection.edges) {
    if (!isRetrievalGraphEdge(edge)) continue;
    const [source, target] = [edge.source, edge.target].sort();
    if (source === target) continue;
    const key = `${source}\0${target}`;
    const prior = weights.get(key);
    weights.set(key, { source, target, weight: (prior?.weight ?? 0) + edge.weight });
  }
  for (const [key, edge] of weights) {
    graph.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight });
  }
  return graph;
}

export function personalizedPageRank(
  projection: GraphProjection,
  seeds: string[],
  alpha = 0.85,
  iterations = 30,
  bidirectional = false,
): Record<string, number> {
  if (!projection.nodes.length || !seeds.length) return {};
  const index = pageRankIndex(projection, bidirectional);
  const validSeeds = [...new Set(seeds.flatMap((seed) => {
    const position = index.positions.get(seed);
    return position === undefined ? [] : [position];
  }))];
  if (!validSeeds.length) return {};
  const teleport = 1 / validSeeds.length;
  let ranks = new Float64Array(index.node_ids.length);
  for (const seed of validSeeds) ranks[seed] = teleport;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Float64Array(index.node_ids.length);
    for (const seed of validSeeds) next[seed] = (1 - alpha) * teleport;
    let dangling = 0;
    for (let source = 0; source < index.node_ids.length; source++) {
      const totalWeight = index.total_weights[source];
      if (index.offsets[source] === index.offsets[source + 1] || totalWeight <= 0) {
        dangling += ranks[source];
        continue;
      }
      const contribution = alpha * ranks[source] / totalWeight;
      for (let edge = index.offsets[source]; edge < index.offsets[source + 1]; edge++) {
        next[index.targets[edge]] += contribution * index.weights[edge];
      }
    }
    for (const seed of validSeeds) {
      next[seed] += alpha * dangling * teleport;
    }
    ranks = next;
  }
  const output: Array<[string, number]> = index.node_ids
    .map((node, position) => [node, ranks[position]]);
  return Object.fromEntries(output.sort(([a], [b]) => a.localeCompare(b)));
}

export function graphQuerySeeds(projection: GraphProjection, query: string, limit = 8): string[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1);
  if (!terms.length) return [];
  const texts = graphTexts.get(projection) ?? projection.nodes.map((node) => (
    `${node.label} ${node.text ?? ''} ${node.source_id ?? ''}`.toLowerCase()
  ));
  graphTexts.set(projection, texts);
  return projection.nodes.map((node, index) => {
    const text = texts[index];
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { node: node.node_id, score };
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.node.localeCompare(b.node))
    .slice(0, limit)
    .map((row) => row.node);
}

export function rankGraphProjection(
  projection: GraphProjection,
  query: string,
  limit = 20,
): GraphRankedNode[] {
  const seeds = graphQuerySeeds(projection, query);
  const scores = personalizedPageRank(projection, seeds, 0.85, 30, true);
  const nodes = new Map(projection.nodes.map((node) => [node.node_id, node]));
  return Object.entries(scores)
    .filter(([, score]) => score > 0)
    .map(([nodeId, score]) => ({ node: nodes.get(nodeId)!, score }))
    .filter((row) => row.node && [
      'source', 'symbol', 'document', 'plan', 'experiment', 'decision', 'assertion',
    ]
      .includes(row.node.kind))
    .sort((a, b) => b.score - a.score || a.node.node_id.localeCompare(b.node.node_id))
    .slice(0, limit);
}

export function analyzeGraphProjection(
  projection: GraphProjection,
  options: { seeds?: string[]; source?: string; target?: string } = {},
): GraphAnalysis {
  const started = performance.now();
  const directed = directedGraph(projection);
  const undirected = communityGraph(projection);
  const rank = pagerank(directed, {
    getEdgeWeight: 'weight',
    alpha: 0.85,
    maxIterations: 200,
    tolerance: 1e-7,
  });
  const communities = louvain(undirected, {
    getEdgeWeight: 'weight',
    randomWalk: false,
  });
  const componentCount = connectedComponents(undirected).length;
  const stronglyConnectedComponentCount = stronglyConnectedComponents(directed).length;
  const communityCount = new Set(Object.values(communities)).size;
  const ppr = options.seeds?.length
    ? personalizedPageRank(projection, options.seeds)
    : undefined;
  const path = options.source && options.target
    ? bidirectional(directed, options.source, options.target) ?? undefined
    : undefined;
  return {
    engine: 'graphology',
    node_count: projection.nodes.length,
    edge_count: projection.edges.length,
    component_count: componentCount,
    strongly_connected_component_count: stronglyConnectedComponentCount,
    community_count: communityCount,
    pagerank: rank,
    community: communities,
    ...(ppr ? { personalized_pagerank: ppr } : {}),
    ...(path ? { path } : {}),
    elapsed_ms: performance.now() - started,
  };
}

export async function runGraphSidecar(
  projection: GraphProjection,
  options: { seeds?: string[]; source?: string; target?: string } = {},
): Promise<GraphAnalysis> {
  if (process.env.VITEST || import.meta.url.endsWith('/src/research/graphSidecar.js')) {
    return analyzeGraphProjection(projection, options);
  }
  return await new Promise<GraphAnalysis>((resolve, reject) => {
    const worker = new Worker(new URL('./graphWorker.js', import.meta.url), {
      workerData: { projection, options },
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`graph sidecar exited with code ${code}`));
    });
  });
}

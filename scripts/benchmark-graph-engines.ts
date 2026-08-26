import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import type { GraphAnalysis, GraphProjection } from '../src/research/contracts.js';
import {
  analyzeGraphProjection, graphQuerySeeds, personalizedPageRank, rankGraphProjection,
} from '../src/research/graphSidecar.js';
import { ResearchService } from '../src/research/service.js';
import { ResearchStore } from '../src/research/store.js';

const ROOT = process.env.SURF_RESEARCH_ROOT
  ?? resolve(process.env.USERPROFILE ?? '.', '.google-surf-mcp', 'research');
const PROJECTS = (process.env.SURF_BENCH_PROJECTS
  ?? 'baubrowser-warpquant-deterministic,baubrowser-warpquant')
  .split(',').map((value) => value.trim()).filter(Boolean);
const NEO4J_URI = process.env.SURF_NEO4J_URI ?? 'bolt://127.0.0.1:17687';
const QUERIES = ['activation quantization', 'kv cache', 'warp quant'];

interface Timed<T> {
  value: T;
  elapsed_ms: number;
  rss_delta_mb: number;
}

async function timed<T>(operation: () => Promise<T> | T): Promise<Timed<T>> {
  const rss = process.memoryUsage().rss;
  const started = performance.now();
  const value = await operation();
  return {
    value,
    elapsed_ms: performance.now() - started,
    rss_delta_mb: (process.memoryUsage().rss - rss) / 1024 / 1024,
  };
}

function top(scores: Record<string, number> | undefined, limit = 20): string[] {
  return Object.entries(scores ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([node]) => node);
}

function overlap(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 1;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

function correlation(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): number {
  if (!left || !right) return 0;
  const keys = Object.keys(left).filter((key) => right[key] !== undefined);
  if (!keys.length) return 0;
  const leftMean = keys.reduce((sum, key) => sum + left[key], 0) / keys.length;
  const rightMean = keys.reduce((sum, key) => sum + right[key], 0) / keys.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const key of keys) {
    const a = left[key] - leftMean;
    const b = right[key] - rightMean;
    numerator += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  }
  return numerator / Math.sqrt(leftVariance * rightVariance);
}

function communityAgreement(
  projection: GraphProjection,
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): number {
  if (!left || !right || !projection.edges.length) return 0;
  let matches = 0;
  let compared = 0;
  for (const edge of projection.edges) {
    if (left[edge.source] === undefined || left[edge.target] === undefined
      || right[edge.source] === undefined || right[edge.target] === undefined) continue;
    if ((left[edge.source] === left[edge.target]) === (right[edge.source] === right[edge.target])) {
      matches++;
    }
    compared++;
  }
  return compared ? matches / compared : 0;
}

async function batch<T>(rows: T[], size: number, operation: (values: T[]) => Promise<void>) {
  for (let index = 0; index < rows.length; index += size) {
    await operation(rows.slice(index, index + size));
  }
}

async function loadNeo4j(session: Session, projection: GraphProjection): Promise<void> {
  await session.run(
    'CREATE CONSTRAINT bench_node_id IF NOT EXISTS FOR (n:BenchNode) REQUIRE n.nodeId IS UNIQUE',
  );
  await session.run('MATCH (n:BenchNode) DETACH DELETE n');
  await batch(projection.nodes, 1_000, async (rows) => {
    await session.run(
      `UNWIND $rows AS row
       CREATE (n:BenchNode {
         nodeId: row.node_id, projectId: row.project_id, kind: row.kind, label: row.label
       })`,
      { rows },
    );
  });
  await batch(projection.edges, 1_000, async (rows) => {
    await session.run(
      `UNWIND $rows AS row
       MATCH (source:BenchNode {nodeId: row.source})
       MATCH (target:BenchNode {nodeId: row.target})
       CREATE (source)-[:BENCH_LINK {
         edgeId: row.edge_id, type: row.type, weight: row.weight
       }]->(target)`,
      { rows },
    );
  });
}

async function neo4jAnalysis(
  driver: Driver,
  projection: GraphProjection,
  seeds: string[],
): Promise<{ analysis: GraphAnalysis; load_ms: number; algorithm_ms: number }> {
  const session = driver.session();
  const graphName = `warpquant_directed_${Date.now()}`;
  const communityGraphName = `warpquant_undirected_${Date.now()}`;
  try {
    const loaded = await timed(async () => await loadNeo4j(session, projection));
    await session.run(
      `CALL gds.graph.project(
         $name,
         'BenchNode',
         {BENCH_LINK: {properties: 'weight'}}
       )`,
      { name: graphName },
    );
    await session.run(
      `CALL gds.graph.project(
         $name,
         'BenchNode',
         {BENCH_LINK: {properties: 'weight', orientation: 'UNDIRECTED'}}
       )`,
      { name: communityGraphName },
    );
    const algorithms = await timed(async () => {
      const pageRankResult = await session.run(
        `CALL gds.pageRank.stream($name, {
           relationshipWeightProperty: 'weight', maxIterations: 200,
           tolerance: 0.0000001, dampingFactor: 0.85
         })
         YIELD nodeId, score
         RETURN gds.util.asNode(nodeId).nodeId AS nodeId, score`,
        { name: graphName },
      );
      let communityResult;
      try {
        communityResult = await session.run(
          `CALL gds.leiden.stream($name, {relationshipWeightProperty: 'weight', randomSeed: 42})
           YIELD nodeId, communityId
           RETURN gds.util.asNode(nodeId).nodeId AS nodeId, communityId`,
          { name: communityGraphName },
        );
      } catch {
        communityResult = await session.run(
          `CALL gds.louvain.stream($name, {relationshipWeightProperty: 'weight'})
           YIELD nodeId, communityId
           RETURN gds.util.asNode(nodeId).nodeId AS nodeId, communityId`,
          { name: communityGraphName },
        );
      }
      const seedResult = await session.run(
        `MATCH (n:BenchNode) WHERE n.nodeId IN $seeds RETURN collect(id(n)) AS ids`,
        { seeds },
      );
      const sourceNodes = seedResult.records[0]?.get('ids') ?? [];
      const pprResult = await session.run(
        `CALL gds.pageRank.stream($name, {
           relationshipWeightProperty: 'weight', sourceNodes: $sourceNodes
         })
         YIELD nodeId, score
         RETURN gds.util.asNode(nodeId).nodeId AS nodeId, score`,
        { name: graphName, sourceNodes },
      );
      return {
        pagerank: Object.fromEntries(pageRankResult.records.map((record) => [
          record.get('nodeId'), Number(record.get('score')),
        ])),
        community: Object.fromEntries(communityResult.records.map((record) => [
          record.get('nodeId'), Number(record.get('communityId')),
        ])),
        ppr: Object.fromEntries(pprResult.records.map((record) => [
          record.get('nodeId'), Number(record.get('score')),
        ])),
      };
    });
    return {
      load_ms: loaded.elapsed_ms,
      algorithm_ms: algorithms.elapsed_ms,
      analysis: {
        engine: 'neo4j-gds',
        node_count: projection.nodes.length,
        edge_count: projection.edges.length,
        community_count: new Set(Object.values(algorithms.value.community)).size,
        pagerank: algorithms.value.pagerank,
        community: algorithms.value.community,
        personalized_pagerank: algorithms.value.ppr,
        elapsed_ms: loaded.elapsed_ms + algorithms.elapsed_ms,
      },
    };
  } finally {
    try {
      await session.run('CALL gds.graph.drop($name, false)', { name: graphName });
    } catch {}
    try {
      await session.run('CALL gds.graph.drop($name, false)', { name: communityGraphName });
    } catch {}
    await session.run('MATCH (n:BenchNode) DETACH DELETE n');
    await session.close();
  }
}

async function main(): Promise<void> {
  const service = new ResearchService({ enabled: true, root: ROOT });
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'surf-graph-benchmark-'));
  const temporaryStore = new ResearchStore(temporaryRoot, 'mem://');
  const driver = neo4j.driver(NEO4J_URI, undefined, {
    maxConnectionPoolSize: 4,
    connectionAcquisitionTimeout: 10_000,
  });
  const report: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    projects: PROJECTS,
    research_root: ROOT,
    neo4j_uri: NEO4J_URI,
  };
  try {
    await driver.verifyConnectivity();
    const exported = await timed(async () => await service.exportGraphProjection(PROJECTS));
    const projection = exported.value;
    const seeds = graphQuerySeeds(projection, QUERIES[0]);
    const graphology = await timed(() => analyzeGraphProjection(projection, { seeds }));
    const temporaryCreatedAt = new Date().toISOString();
    for (const projectId of projection.project_ids) {
      await temporaryStore.putProject({
        project_id: projectId,
        name: projectId,
        status: 'active',
        created_at: temporaryCreatedAt,
        updated_at: temporaryCreatedAt,
        graph_dirty_at: projection.source_versions[projectId],
      });
    }
    const surreal = await timed(async () => (
      await temporaryStore.publishGraphProjection(projection, graphology.value)
    ));
    const surrealLoad = await timed(async () => (
      await temporaryStore.loadGraphArtifact(projection.projection_id)
    ));
    const surrealQueries = await timed(() => QUERIES.map((query) => ({
      query,
      results: rankGraphProjection(surrealLoad.value!.projection, query, 20).length,
    })));
    const persisted = await timed(async () => await service.materializeGraph(PROJECTS));
    const traversal = await timed(async () => await Promise.all(QUERIES.map(async (query) => {
      const querySeeds = graphQuerySeeds(projection, query);
      return {
        query,
        seeds: querySeeds,
        reached: await service.traverseMaterializedGraph(
          projection.projection_id,
          querySeeds,
          3,
        ),
      };
    })));
    const neo = await neo4jAnalysis(driver, projection, seeds);
    const localPpr = personalizedPageRank(projection, seeds);
    report.projection = {
      projection_id: projection.projection_id,
      source_hash: projection.source_hash,
      nodes: projection.nodes.length,
      edges: projection.edges.length,
      export_ms: exported.elapsed_ms,
      export_rss_delta_mb: exported.rss_delta_mb,
    };
    report.graphology = {
      elapsed_ms: graphology.elapsed_ms,
      rss_delta_mb: graphology.rss_delta_mb,
      component_count: graphology.value.component_count,
      community_count: graphology.value.community_count,
    };
    report.surrealdb = {
      storage: 'surrealdb-metadata-content-addressed-file',
      fresh_artifact_publish_ms: surreal.elapsed_ms,
      fresh_artifact_load_ms: surrealLoad.elapsed_ms,
      query_ms: surrealQueries.elapsed_ms,
      query_results: surrealQueries.value,
      payload_bytes: gzipSync(Buffer.from(JSON.stringify({
        projection,
        analysis: graphology.value,
      })), { level: 1 }).byteLength,
      persisted_publish_or_reuse_ms: persisted.elapsed_ms,
      persisted_timings: persisted.value.timings,
      reused: persisted.value.analysis === undefined,
      traversal_ms: traversal.elapsed_ms,
      traversal: traversal.value.map((row) => ({
        query: row.query,
        seeds: row.seeds.length,
        reached: row.reached.length,
      })),
    };
    report.neo4j = {
      load_ms: neo.load_ms,
      algorithm_ms: neo.algorithm_ms,
      community_count: neo.analysis.community_count,
    };
    report.parity = {
      pagerank_top20_jaccard: overlap(top(graphology.value.pagerank), top(neo.analysis.pagerank)),
      pagerank_top100_jaccard: overlap(
        top(graphology.value.pagerank, 100),
        top(neo.analysis.pagerank, 100),
      ),
      pagerank_score_correlation: correlation(
        graphology.value.pagerank,
        neo.analysis.pagerank,
      ),
      ppr_top20_jaccard: overlap(top(localPpr), top(neo.analysis.personalized_pagerank)),
      edge_community_agreement: communityAgreement(
        projection,
        graphology.value.community,
        neo.analysis.community,
      ),
    };
    const output = resolve('artifacts', 'warpquant-graph-engine-benchmark.json');
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await temporaryStore.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    await driver.close();
    await Promise.race([
      service.close(),
      new Promise<void>((resolveClose) => setTimeout(resolveClose, 5_000)),
    ]);
  }
}

main().then(
  () => setTimeout(() => process.exit(0), 50),
  (error) => {
    console.error(error);
    setTimeout(() => process.exit(1), 50);
  },
);

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchService } from '../build/research/service.js';

const mode = process.argv[2];
const root = process.argv[3];

async function waitForTerminalJob(service, projectId, jobId) {
  let afterRevision = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await service.waitForJob(projectId, jobId, afterRevision, 30_000);
    if (['done', 'failed', 'cancelled'].includes(result.job.status)) return result;
    if (result.timed_out) return result;
    afterRevision = result.job.revision ?? afterRevision;
  }
  throw new Error('pending source rebuild exceeded the progress event budget');
}

if (mode === 'write') {
  const service = new ResearchService({ enabled: true, root });
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'probe.ts'), 'export const restart_rebuild_token = true;\n');
  await service.createProject('Reopen probe', 'reopen-probe');
  const catalogBody = `  exact catalog body\n${'evidence line\n'.repeat(2_000)}конец  `;
  const artifacts = Array.from({ length: 225 }, (_, index) => ({
    artifact_id: `artifact-${index}`,
    path: `results/member-${index}.json`,
    verification: 'declared',
  }));
  await service.writeCatalogRecord({
    project_id: 'reopen-probe',
    kind: 'experiment',
    operation: 'create',
    asset_id: 'durable-record',
    expected_revision: 0,
    idempotency_key: 'durable-record-create',
    body: catalogBody,
    fields: { title: 'Durable record' },
    aliases: ['legacy-durable-record'],
    artifact_references: artifacts,
  });
  await service.createPlan({
    project_id: 'reopen-probe',
    title: 'Plan v1',
    body: 'Persist across processes.',
  }, false);
  const receipt = await service.capture({
    tool: 'search',
    project_id: 'reopen-probe',
    session_id: 'host-task-reopen',
    session_intent: 'Verify automatic memory across processes.',
    query: 'first process',
    payload: { results: [] },
  });
  const graph = await service.materializeGraph(['reopen-probe']);
  await service.capture({
    tool: 'extract',
    project_id: 'reopen-probe',
    memory_handle: receipt.memory_handle,
    payload: {
      title: 'Dirty graph evidence',
      url: 'https://example.com/dirty-graph',
      content: 'The next process must rebuild this graph.',
      extraction_quality: 'full_text',
    },
  });
  const indexed = await service.indexProject({
    project_id: 'reopen-probe',
    roots: [{ label: 'repo', path: sourceRoot }],
  });
  await service.waitForIdle();
  const queuedRebuild = await service.queueKnowledgeJob({
    project_id: 'reopen-probe',
    kind: 'rebuild',
    source_hash: indexed.snapshot_id,
    schema_version: 'source-index-reopen-probe-v1',
    algorithm_version: 'source-index-reopen-probe-v1',
    affected_source_ids: [],
  });
  writeFileSync(join(root, 'expected.json'), JSON.stringify({
    memory_handle: receipt.memory_handle,
    prior_projection_id: graph.projection.projection_id,
    catalog_body: catalogBody,
    queued_rebuild_job_id: queuedRebuild.job_id,
  }));
  await service.close();
  process.exit(0);
} else if (mode === 'read') {
  const service = new ResearchService({ enabled: true, root });
  const receipt = await service.capture({
    tool: 'search',
    project_id: 'reopen-probe',
    session_id: 'host-task-reopen',
    session_intent: 'Verify automatic memory across processes.',
    query: 'second process',
    payload: { results: [] },
  });
  const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
  const resumed = await waitForTerminalJob(service, 'reopen-probe', expected.queued_rebuild_job_id);
  if (resumed.timed_out || resumed.job.status !== 'done') {
    throw new Error(`pending source rebuild did not resume after restart: ${resumed.job.status}`);
  }
  let bodyOffset = 0;
  let catalogBody = '';
  for (;;) {
    const page = await service.getCatalogRecord('reopen-probe', 'legacy-durable-record', undefined, bodyOffset, 4_001);
    if (!page || 'legacy' in page) throw new Error('catalog alias did not resolve after restart');
    catalogBody += page.body ?? '';
    if (page.next_body_offset === undefined) break;
    bodyOffset = page.next_body_offset;
  }
  let artifactOffset = 0;
  let catalogArtifacts = 0;
  for (;;) {
    const page = await service.getCatalogRecord(
      'reopen-probe', 'legacy-durable-record', undefined, 0, 1, artifactOffset, 200,
    );
    if (!page || 'legacy' in page) throw new Error('catalog artifact manifest did not resolve after restart');
    catalogArtifacts += page.revision.artifact_references.length;
    if (page.next_artifact_offset === undefined) break;
    artifactOffset = page.next_artifact_offset;
  }
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  const detail = await service.getProject('reopen-probe');
  if (detail.plans.length !== 1 || detail.plans[0].body !== 'Persist across processes.') {
    throw new Error('reopen data mismatch');
  }
  if (receipt.memory_handle !== expected.memory_handle
    || receipt.session_intent !== 'Verify automatic memory across processes.'
    || detail.session_count !== 1
    || detail.project.active_graph_projection_id === expected.prior_projection_id) {
    throw new Error('host session reopen mismatch');
  }
  if (catalogBody !== expected.catalog_body || catalogArtifacts !== 225) {
    throw new Error(`catalog body or manifest did not round-trip after restart: ${JSON.stringify({
      expected_body_bytes: Buffer.byteLength(expected.catalog_body),
      actual_body_bytes: Buffer.byteLength(catalogBody),
      body_equal: catalogBody === expected.catalog_body,
      expected_artifacts: 225,
      actual_artifacts: catalogArtifacts,
    })}`);
  }
  if ((await service.search('reopen-probe', 'restart_rebuild_token', 10)).length !== 1) {
    throw new Error('resumed source rebuild did not publish searchable code');
  }
  await service.close();
  process.exit(0);
} else {
  const probeRoot = mkdtempSync(join(tmpdir(), 'surf-reopen-'));
  const script = fileURLToPath(import.meta.url);
  try {
    for (const phase of ['write', 'read']) {
      const result = spawnSync(process.execPath, [script, phase, probeRoot], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error(result.stderr || `${phase} failed`);
    }
    console.log('research reopen probe passed');
  } finally {
    rmSync(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

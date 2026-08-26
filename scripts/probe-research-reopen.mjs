#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchService } from '../build/research/service.js';

const mode = process.argv[2];
const root = process.argv[3];

if (mode === 'write') {
  const service = new ResearchService({ enabled: true, root });
  await service.createProject('Reopen probe', 'reopen-probe');
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
  writeFileSync(join(root, 'expected.json'), JSON.stringify({
    memory_handle: receipt.memory_handle,
    prior_projection_id: graph.projection.projection_id,
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

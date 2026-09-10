#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const queries = Math.max(1, Number.parseInt(process.argv[2] ?? '100', 10));
const workspace = mkdtempSync(join(tmpdir(), 'surf-memory-soak-'));
const researchRoot = join(workspace, 'research');
const profileRoot = join(workspace, 'profile');
const ownerPath = join(researchRoot, 'broker', 'owner', 'owner.json');
const browserOwnerPath = join(profileRoot, 'native.broker', 'owner', 'owner.json');
const sourceRoot = join(workspace, 'source');
const env = {
  ...process.env,
  SURF_RESEARCH: 'true',
  SURF_RESEARCH_ROOT: researchRoot,
  SURF_PROFILE_ROOT: profileRoot,
  SURF_RESEARCH_VECTOR_MODEL: process.env.SURF_SOAK_VECTOR_MODEL ?? 'off',
  SURF_RESEARCH_BROKER_IDLE_MS: '200',
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (alive(pid)) throw new Error(`research broker ${pid} did not drain`);
}

async function removeWorkspace(path) {
  let failure;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw failure;
}

function ownerPid() {
  return JSON.parse(readFileSync(ownerPath, 'utf8')).pid;
}

async function connect(name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/cli.js'],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport };
}

async function doctor(client) {
  const result = await client.callTool({
    name: 'project_memory',
    arguments: { action: 'doctor' },
  });
  if (result.isError) throw new Error('project memory doctor failed');
  return result.structuredContent.doctor;
}

function memorySample(phase, status) {
  return {
    phase,
    ...status.process,
    adapter_rss_bytes: status.adapter_process?.rss_bytes ?? 0,
    observed_worker_rss_bytes: status.observed_worker_rss_bytes ?? status.process.rss_bytes,
  };
}

async function memorySearch(client) {
  const result = await client.callTool({
    name: 'project_memory_search',
    arguments: { project_id: 'memory-soak', query: 'durable_soak_token', limit: 5 },
  });
  if (result.isError || result.structuredContent?.meta?.browser_used !== false) {
    throw new Error('memory-only search route failed');
  }
  return result;
}

async function syncSource(client, changed = false) {
  const result = await client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'sync',
      project_id: 'memory-soak',
      roots: [{ label: 'repo', path: sourceRoot }],
      ...(changed ? { changed_paths: [{ root: 'repo', path: 'soak.ts' }] } : {}),
    },
  });
  if (result.isError) throw new Error('memory soak source sync failed');
  return result.structuredContent.index;
}

async function waitForIndex(client, index) {
  if (!index.job_id || index.job_status === 'done') return;
  let afterRevision = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await client.callTool({
      name: 'project_memory',
      arguments: {
        action: 'job_wait', project_id: 'memory-soak', job_id: index.job_id,
        after_revision: afterRevision, wait_timeout_ms: 30_000,
      },
    });
    const job = result.structuredContent?.job?.job;
    if (result.isError || !job) throw new Error('memory soak index wait failed');
    if (job.status === 'done') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`memory soak index job ended as ${job.status}: ${job.error ?? ''}`);
    }
    if (result.structuredContent?.job?.timed_out) {
      throw new Error('memory soak index job timed out');
    }
    afterRevision = job.revision ?? afterRevision;
  }
  throw new Error('memory soak index job exceeded the progress event budget');
}

const samples = [];
let first;
let second;
try {
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, 'soak.ts'), 'export const soak = "initial";\n', 'utf8');
  first = await connect('google-surf-memory-soak');
  const created = await first.client.callTool({
    name: 'project_memory',
    arguments: { action: 'create', project_id: 'memory-soak', name: 'Memory soak' },
  });
  if (created.isError) throw new Error('memory soak project create failed');
  const initialBrokerPid = ownerPid();
  const recorded = await first.client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'record',
      project_id: 'memory-soak',
      asset_kind: 'document',
      operation: 'create',
      asset_id: 'soak-document',
      idempotency_key: 'soak-document-v1',
      fields: { title: 'Durable memory soak evidence' },
      body: `${'bounded local evidence '.repeat(2_000)}durable_soak_token`,
    },
  });
  if (recorded.isError) throw new Error('memory soak record failed');
  const jobId = recorded.structuredContent?.receipt?.index_job_id;
  if (jobId) {
    const waited = await first.client.callTool({
      name: 'project_memory',
      arguments: {
        action: 'job_wait', project_id: 'memory-soak', job_id: jobId, wait_timeout_ms: 30_000,
      },
    });
    if (waited.isError) throw new Error('memory soak index wait failed');
  }
  const initialSync = await syncSource(first.client);
  await waitForIndex(first.client, initialSync);
  const noOpSync = await syncSource(first.client);
  await waitForIndex(first.client, noOpSync);
  if (!noOpSync.reused || noOpSync.added_count !== 0
    || noOpSync.modified_count !== 0 || noOpSync.removed_count !== 0) {
    throw new Error('no-op sync rewrote indexed sources');
  }
  samples.push(memorySample('no-op-sync', await doctor(first.client)));
  writeFileSync(join(sourceRoot, 'soak.ts'), 'export const soak = "changed";\n', 'utf8');
  const changedSync = await syncSource(first.client, true);
  await waitForIndex(first.client, changedSync);
  if (changedSync.reused || changedSync.added_count !== 0
    || changedSync.modified_count !== 1 || changedSync.removed_count !== 0) {
    throw new Error('one-file sync did not remain a one-item delta');
  }
  samples.push(memorySample('changed-sync', await doctor(first.client)));
  await memorySearch(first.client);
  samples.push(memorySample('warm', await doctor(first.client)));
  for (let index = 0; index < queries; index++) {
    await memorySearch(first.client);
    if ((index + 1) % Math.max(1, Math.floor(queries / 4)) === 0) {
      samples.push(memorySample(`query-${index + 1}`, await doctor(first.client)));
    }
  }
  const beforeDrain = await doctor(first.client);
  if (ownerPid() !== initialBrokerPid) {
    throw new Error('memory-only query sequence restarted the research broker');
  }
  if (existsSync(browserOwnerPath)) throw new Error('memory-only queries started the browser broker');
  const firstPid = ownerPid();
  await first.transport.close();
  first = undefined;
  await waitForExit(firstPid);

  second = await connect('google-surf-memory-soak-reopen');
  await memorySearch(second.client);
  const afterReopen = await doctor(second.client);
  const secondPid = ownerPid();
  if (secondPid === firstPid) throw new Error('research broker did not reopen in a fresh process');
  if (existsSync(browserOwnerPath)) throw new Error('reopened memory query started the browser broker');
  samples.push(memorySample('reopen', afterReopen));
  const querySamples = samples.filter((sample) => sample.phase.startsWith('query-'));
  const queryRss = querySamples.map((sample) => sample.observed_worker_rss_bytes);
  console.log(JSON.stringify({
    fixture: researchRoot,
    queries,
    vector_model: env.SURF_RESEARCH_VECTOR_MODEL,
    browser_broker_started: false,
    first_broker_pid: firstPid,
    reopened_broker_pid: secondPid,
    broker_requests: beforeDrain.broker,
    sync: {
      initial: initialSync,
      no_op: noOpSync,
      changed: changedSync,
    },
    memory_trend: {
      query_sample_count: querySamples.length,
      first_query_rss_bytes: queryRss[0] ?? null,
      last_query_rss_bytes: queryRss.at(-1) ?? null,
      query_rss_delta_bytes: queryRss.length > 1 ? queryRss.at(-1) - queryRss[0] : 0,
      peak_observed_worker_rss_bytes: Math.max(...samples.map((sample) => sample.observed_worker_rss_bytes)),
    },
    samples,
  }, null, 2));
} finally {
  if (first) await first.transport.close().catch(() => {});
  if (second) {
    let pid;
    try { pid = ownerPid(); } catch {}
    await second.transport.close().catch(() => {});
    if (pid) await waitForExit(pid).catch(() => {});
  }
  await removeWorkspace(workspace);
}

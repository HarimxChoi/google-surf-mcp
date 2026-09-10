import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  RESEARCH_BROKER_CONTROL_METHODS,
  RESEARCH_BROKER_METHODS,
  RESEARCH_BROKER_PROTOCOL,
  RESEARCH_BROKER_READ_METHODS,
  decodeResearchBrokerArgs,
  researchBrokerConfigHash,
  researchBrokerDirectory,
  researchBrokerEndpoint,
  researchBrokerTokenPath,
  type ResearchBrokerConfig,
} from './broker.js';
import { ResearchService } from './service.js';
import { ResearchQueryInterrupted } from './queryControl.js';
import {
  MAX_RESEARCH_QUERY_TIMEOUT_MS,
  MIN_RESEARCH_QUERY_TIMEOUT_MS,
} from './limits.js';

interface BrokerRequest {
  protocol: number;
  configHash: string;
  token: string;
  id: string;
  method: string;
  args: unknown[];
}

interface OwnerRecord {
  owner_id: string;
  pid: number;
  started_at: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireOwner(root: string): Promise<{ owner: OwnerRecord; directory: string } | undefined> {
  const brokerDirectory = researchBrokerDirectory(root);
  const directory = resolve(brokerDirectory, 'owner');
  await mkdir(brokerDirectory, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const owner: OwnerRecord = { owner_id: randomUUID(), pid: process.pid, started_at: new Date().toISOString() };
    const candidate = `${directory}.candidate-${owner.owner_id}`;
    try {
      await mkdir(candidate);
      await writeFile(resolve(candidate, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
      try {
        await rename(candidate, directory);
        return { owner, directory };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await rm(candidate, { recursive: true, force: true }).catch(() => {});
    }
    try {
      const current = JSON.parse(await readFile(resolve(directory, 'owner.json'), 'utf8')) as OwnerRecord;
      if (Number.isInteger(current.pid) && processAlive(current.pid)) return undefined;
    } catch {}
    const stale = `${directory}.stale-${randomUUID()}`;
    try {
      await rename(directory, stale);
      await rm(stale, { recursive: true, force: true });
    } catch {}
  }
  return undefined;
}

async function releaseOwner(directory: string, owner: OwnerRecord): Promise<void> {
  try {
    const current = JSON.parse(await readFile(resolve(directory, 'owner.json'), 'utf8')) as OwnerRecord;
    if (current.owner_id === owner.owner_id) await rm(directory, { recursive: true, force: true });
  } catch {}
}

function parseConfig(): ResearchBrokerConfig {
  const encoded = process.env.SURF_RESEARCH_BROKER_CONFIG;
  delete process.env.SURF_RESEARCH_BROKER_CONFIG;
  if (!encoded) throw new Error('SURF_RESEARCH_BROKER_CONFIG required');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ResearchBrokerConfig;
  if (!value.enabled || !value.root || !Number.isFinite(value.idleMs)
    || !Number.isFinite(value.readConcurrency)
    || !Number.isFinite(value.queryTimeoutMs)) throw new Error('invalid research broker config');
  return {
    ...value,
    root: resolve(value.root),
    idleMs: Math.max(100, value.idleMs),
    readConcurrency: Math.min(16, Math.max(1, Math.floor(value.readConcurrency))),
    queryTimeoutMs: Math.min(
      MAX_RESEARCH_QUERY_TIMEOUT_MS,
      Math.max(MIN_RESEARCH_QUERY_TIMEOUT_MS, Math.floor(value.queryTimeoutMs)),
    ),
  };
}

const config = parseConfig();
process.title = 'google-surf-research-broker';
const acquiredOwnership = await acquireOwner(config.root);
if (!acquiredOwnership) process.exit(0);
const ownership = acquiredOwnership!;

const token = (await readFile(researchBrokerTokenPath(config.root), 'utf8')).trim();
const configHash = researchBrokerConfigHash(config);
const service = new ResearchService(config);
const endpoint = researchBrokerEndpoint(config.root);
const clients = new Set<Socket>();
const coalescedReads = new Set([
  'getAssertion', 'getCatalogRecord', 'getCatalogRecords', 'getEntity', 'getProject',
  'getProjectSummary', 'jobStatus', 'linkEntity', 'listProjects', 'projectContext',
  'passiveStatus', 'probe', 'search', 'searchBatch', 'searchGrouped', 'searchFamilies',
]);
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let writeTail: Promise<unknown> = Promise.resolve();
let activeReads = 0;
const readWaiters: Array<() => void> = [];
const readInflight = new Map<string, {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: Set<string>;
}>();
const requestControllers = new Map<string, {
  controller: AbortController;
  socket: Socket;
  read: boolean;
  coalesced: boolean;
  coalescedKey?: string;
}>();
let stopping = false;
let activeRequests = 0;
let acceptedRequests = 0;
let completedRequests = 0;
let coalescedReadHits = 0;
let activeWrites = 0;
let queuedWrites = 0;
let lastCompletedWorkAt: string | undefined;

if (process.platform !== 'win32' && process.platform !== 'linux') {
  await rm(endpoint, { force: true });
}

function response(socket: Socket, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function invocationArgs(request: BrokerRequest, signal: AbortSignal): unknown[] {
  const args = [...request.args];
  const setSignal = (index: number): unknown[] => {
    while (args.length <= index) args.push(undefined);
    args[index] = signal;
    return args;
  };
  if (request.method === 'search') {
    return setSignal(4);
  }
  if (request.method === 'searchBatch') {
    return setSignal(5);
  }
  if (request.method === 'searchGrouped') {
    return setSignal(3);
  }
  if (request.method === 'searchFamilies') {
    while (args.length < 6) args.push(undefined);
    if (args[5] === undefined) args[5] = true;
    return setSignal(6);
  }
  if (request.method === 'rerankCandidates') {
    return setSignal(4);
  }
  return args;
}

async function invoke(request: BrokerRequest, signal: AbortSignal): Promise<unknown> {
  if (request.method === 'passiveStatus') {
    const status = service.status();
    const foreground = {
      active_requests: Math.max(0, activeRequests - 1),
      active_reads: activeReads,
      active_writes: activeWrites,
      queued_reads: readWaiters.length,
      queued_writes: queuedWrites,
    };
    const background = {
      background_jobs: status.background_jobs,
      repository_jobs: status.repository_jobs,
      scheduled_graph_jobs: status.scheduled_graph_jobs,
    };
    const recycleBlockers = [
      ...Object.entries(foreground).filter(([, count]) => count > 0).map(([name]) => name),
      ...Object.entries(background).filter(([, count]) => count > 0).map(([name]) => name),
    ];
    const resourcePressure = Boolean(
      config.workerSoftMemoryBytes && process.memoryUsage().rss >= config.workerSoftMemoryBytes
    );
    return {
      ...service.passiveStatus('research_broker'),
      broker: {
        lifecycle: stopping ? 'draining' : 'ready',
        connected_clients: clients.size,
        accepted_requests: acceptedRequests,
        completed_requests: completedRequests,
        coalesced_read_hits: coalescedReadHits,
        ...foreground,
        last_completed_work_at: lastCompletedWorkAt ?? null,
        idle_ms: config.idleMs,
        read_concurrency: config.readConcurrency,
        query_timeout_ms: config.queryTimeoutMs,
        worker_soft_memory_bytes: config.workerSoftMemoryBytes ?? null,
        resource_pressure: resourcePressure,
        recycle_eligible: recycleBlockers.length === 0,
        recycle_blockers: recycleBlockers,
        recycle_trigger: resourcePressure ? 'memory_pressure' : 'idle_timeout',
        background_ownership: {
          ...background,
          checkpoint_drain_requested: status.drain_requested,
        },
      },
    };
  }
  const method = (service as unknown as Record<string, (...args: unknown[]) => unknown>)[request.method];
  if (typeof method !== 'function') throw new Error(`unsupported research broker method: ${request.method}`);
  const operation = async (operationSignal = signal) => (
    await method.apply(service, invocationArgs(request, operationSignal))
  );
  if (RESEARCH_BROKER_CONTROL_METHODS.has(request.method)) return await operation();
  if (RESEARCH_BROKER_READ_METHODS.has(request.method)) {
    const key = coalescedReads.has(request.method)
      ? `${request.method}\0${JSON.stringify(request.args)}`
      : request.id;
    const existing = readInflight.get(key);
    if (existing) {
      coalescedReadHits++;
      existing.subscribers.add(request.id);
      const pending = requestControllers.get(request.id);
      if (pending) pending.coalescedKey = key;
      return await existing.promise;
    }
    const sharedController = new AbortController();
    const current = (async () => {
      if (activeReads >= config.readConcurrency) {
        await new Promise<void>((resolveSlot) => readWaiters.push(resolveSlot));
      }
      activeReads++;
      return await service.withSearchReadLease(
        () => operation(coalescedReads.has(request.method) ? sharedController.signal : signal),
        () => {
          activeReads--;
          readWaiters.shift()?.();
          scheduleIdle();
        },
      );
    })();
    const shared = {
      promise: current,
      controller: sharedController,
      subscribers: new Set([request.id]),
    };
    readInflight.set(key, shared);
    const pending = requestControllers.get(request.id);
    if (pending && coalescedReads.has(request.method)) pending.coalescedKey = key;
    try {
      return await current;
    } finally {
      if (readInflight.get(key) === shared) readInflight.delete(key);
    }
  }
  queuedWrites++;
  const writeOperation = async () => {
    queuedWrites--;
    activeWrites++;
    try {
      return await operation();
    } finally {
      activeWrites--;
    }
  };
  const current = writeTail.then(writeOperation, writeOperation);
  writeTail = current.then(() => undefined, () => undefined);
  return await current;
}

async function handle(socket: Socket, line: string): Promise<void> {
  let request: BrokerRequest | undefined;
  let controller: AbortController | undefined;
  let accepted = false;
  activeRequests++;
  try {
    request = JSON.parse(line) as BrokerRequest;
    if (request.protocol !== RESEARCH_BROKER_PROTOCOL) throw new Error('research broker protocol mismatch');
    if (request.configHash !== configHash) throw new Error('research broker configuration mismatch');
    if (request.token !== token) throw new Error('research broker authentication failed');
    if (!request.id || !Array.isArray(request.args)) {
      throw new Error('invalid research broker request');
    }
    request.args = decodeResearchBrokerArgs(request.args);
    if (request.method === '$cancel') {
      const target = typeof request.args[0] === 'string' ? request.args[0] : '';
      const pending = requestControllers.get(target);
      if (pending?.read && pending.coalescedKey) {
        const shared = readInflight.get(pending.coalescedKey);
        shared?.subscribers.delete(target);
        if (shared && shared.subscribers.size === 0) shared.controller.abort();
      } else if (pending?.read) pending.controller.abort();
      response(socket, { id: request.id, ok: true });
      return;
    }
    if (!RESEARCH_BROKER_METHODS.has(request.method)) throw new Error('invalid research broker request');
    acceptedRequests++;
    accepted = true;
    controller = new AbortController();
    requestControllers.set(request.id, {
      controller,
      socket,
      read: RESEARCH_BROKER_READ_METHODS.has(request.method),
      coalesced: coalescedReads.has(request.method),
    });
    const result = await invoke(request, controller.signal);
    response(socket, { id: request.id, ok: true, result, status: service.status() });
    if (request.method === 'requestDrain') setTimeout(() => void stop(), 25).unref();
  } catch (error) {
    response(socket, {
      id: request?.id ?? '',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof ResearchQueryInterrupted ? {
        query_error: { reason: error.reason, request_id: error.request_id, phase: error.phase },
      } : {}),
      status: service.status(),
    });
  } finally {
    if (request?.id) {
      const pending = requestControllers.get(request.id);
      if (pending?.coalescedKey) readInflight.get(pending.coalescedKey)?.subscribers.delete(request.id);
    }
    if (request?.id && controller) requestControllers.delete(request.id);
    if (accepted) completedRequests++;
    if (accepted && request?.method !== 'passiveStatus') {
      lastCompletedWorkAt = new Date().toISOString();
    }
    activeRequests--;
    scheduleIdle();
  }
}

function scheduleIdle(): void {
  if (activeRequests || activeReads || activeWrites || queuedWrites || readWaiters.length || stopping) return;
  clearTimeout(idleTimer);
  const underPressure = Boolean(
    config.workerSoftMemoryBytes && process.memoryUsage().rss >= config.workerSoftMemoryBytes
  );
  const status = service.status();
  if (underPressure && !status.drain_requested
    && (status.background_jobs || status.scheduled_graph_jobs)) {
    void service.requestDrain();
  }
  idleTimer = setTimeout(() => {
    const status = service.status();
    if (activeRequests || activeReads || activeWrites || queuedWrites || readWaiters.length
      || status.background_jobs || status.repository_jobs || status.scheduled_graph_jobs) {
      scheduleIdle();
      return;
    }
    void stop();
  }, underPressure ? 100 : config.idleMs);
  idleTimer.unref();
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  for (const client of clients) client.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await service.close().catch(() => {});
  if (process.platform !== 'win32' && process.platform !== 'linux') await rm(endpoint, { force: true }).catch(() => {});
  process.exit(0);
}

const server = createServer((socket) => {
  clients.add(socket);
  scheduleIdle();
  let buffer = '';
  socket.setNoDelay(true);
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 64 * 1024 * 1024) {
      socket.destroy(new Error('research broker request exceeded 64 MiB'));
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) void handle(socket, line);
    }
  });
  socket.on('close', () => {
    for (const [requestId, pending] of requestControllers) {
      if (pending.socket !== socket || !pending.read) continue;
      if (pending.coalescedKey) {
        const shared = readInflight.get(pending.coalescedKey);
        shared?.subscribers.delete(requestId);
        if (shared && shared.subscribers.size === 0) shared.controller.abort();
      } else {
        pending.controller.abort();
      }
    }
    clients.delete(socket);
    scheduleIdle();
  });
  socket.on('error', () => {});
});

server.on('error', async () => {
  await releaseOwner(ownership.directory, ownership.owner);
  process.exit(1);
});
server.listen(endpoint);
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.once('SIGHUP', () => void stop());

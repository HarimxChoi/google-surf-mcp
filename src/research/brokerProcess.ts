import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  RESEARCH_BROKER_METHODS,
  RESEARCH_BROKER_PROTOCOL,
  RESEARCH_BROKER_READ_METHODS,
  researchBrokerConfigHash,
  researchBrokerDirectory,
  researchBrokerEndpoint,
  researchBrokerTokenPath,
  type ResearchBrokerConfig,
} from './broker.js';
import { ResearchService } from './service.js';

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
    try {
      await mkdir(directory);
      await writeFile(resolve(directory, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
      return { owner, directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
  if (!value.enabled || !value.root || !Number.isFinite(value.idleMs)) throw new Error('invalid research broker config');
  return { ...value, root: resolve(value.root), idleMs: Math.max(100, value.idleMs) };
}

const config = parseConfig();
const acquiredOwnership = await acquireOwner(config.root);
if (!acquiredOwnership) process.exit(0);
const ownership = acquiredOwnership!;

const token = (await readFile(researchBrokerTokenPath(config.root), 'utf8')).trim();
const configHash = researchBrokerConfigHash(config);
const service = new ResearchService(config);
const endpoint = researchBrokerEndpoint(config.root);
const clients = new Set<Socket>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let writeTail: Promise<unknown> = Promise.resolve();
let stopping = false;
let activeRequests = 0;

if (process.platform !== 'win32' && process.platform !== 'linux') {
  await rm(endpoint, { force: true });
}

function response(socket: Socket, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

async function invoke(request: BrokerRequest): Promise<unknown> {
  const method = (service as unknown as Record<string, (...args: unknown[]) => unknown>)[request.method];
  if (typeof method !== 'function') throw new Error(`unsupported research broker method: ${request.method}`);
  const operation = async () => await method.apply(service, request.args);
  if (RESEARCH_BROKER_READ_METHODS.has(request.method)) return await operation();
  const current = writeTail.then(operation, operation);
  writeTail = current.then(() => undefined, () => undefined);
  return await current;
}

async function handle(socket: Socket, line: string): Promise<void> {
  let request: BrokerRequest | undefined;
  activeRequests++;
  try {
    request = JSON.parse(line) as BrokerRequest;
    if (request.protocol !== RESEARCH_BROKER_PROTOCOL) throw new Error('research broker protocol mismatch');
    if (request.configHash !== configHash) throw new Error('research broker configuration mismatch');
    if (request.token !== token) throw new Error('research broker authentication failed');
    if (!request.id || !RESEARCH_BROKER_METHODS.has(request.method) || !Array.isArray(request.args)) {
      throw new Error('invalid research broker request');
    }
    const result = await invoke(request);
    response(socket, { id: request.id, ok: true, result, status: service.status() });
  } catch (error) {
    response(socket, {
      id: request?.id ?? '',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: service.status(),
    });
  } finally {
    activeRequests--;
    scheduleIdle();
  }
}

function scheduleIdle(): void {
  if (clients.size || activeRequests || stopping) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop(), config.idleMs);
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
  clearTimeout(idleTimer);
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

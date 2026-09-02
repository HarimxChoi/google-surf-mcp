import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import {
  NATIVE_BROWSER_BROKER_PROTOCOL,
  nativeBrowserBrokerConfigHash,
  nativeBrowserBrokerDirectory,
  nativeBrowserBrokerEndpoint,
  nativeBrowserBrokerTokenPath,
  normalizeNativeBrowserBrokerConfig,
  type NativeBrowserBrokerConfig,
} from './nativeBrowserBrokerProtocol.js';

interface BrokerRequest {
  protocol: number;
  configHash: string;
  token: string;
  id: string;
  method: 'search' | 'searchMany' | 'scholar' | '$status';
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

async function acquireOwner(profileDir: string): Promise<{
  owner: OwnerRecord;
  directory: string;
} | undefined> {
  const brokerDirectory = nativeBrowserBrokerDirectory(profileDir);
  const directory = resolve(brokerDirectory, 'owner');
  await mkdir(brokerDirectory, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    const owner: OwnerRecord = {
      owner_id: randomUUID(),
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    try {
      await mkdir(directory);
      await writeFile(resolve(directory, 'owner.json'), JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
      });
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

function parseConfig(): NativeBrowserBrokerConfig {
  const encoded = process.env.SURF_NATIVE_BROWSER_BROKER_CONFIG;
  delete process.env.SURF_NATIVE_BROWSER_BROKER_CONFIG;
  if (!encoded) throw new Error('SURF_NATIVE_BROWSER_BROKER_CONFIG required');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as NativeBrowserBrokerConfig;
  if (!value.executablePath || !value.profileDir || !value.selfHealingFile
    || !Number.isFinite(value.idleMs)) throw new Error('invalid native browser broker config');
  return normalizeNativeBrowserBrokerConfig(value);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const value = error as Error & { userAction?: string; retryAfterMs?: number };
  return {
    name: error.name,
    message: error.message,
    ...(value.userAction ? { userAction: value.userAction } : {}),
    ...(value.retryAfterMs ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

const config = parseConfig();
const acquiredOwnership = await acquireOwner(config.profileDir);
if (!acquiredOwnership) process.exit(0);
const ownership = acquiredOwnership!;
const token = (await readFile(nativeBrowserBrokerTokenPath(config.profileDir), 'utf8')).trim();
const configHash = nativeBrowserBrokerConfigHash(config);
interface BrowserRuntime {
  browser: import('./nativeBrowser.js').NativeChromeBrowser;
  healing: import('./strategyHealing.js').StrategyHealing;
}

let runtimePromise: Promise<BrowserRuntime> | undefined;

function getRuntime(): Promise<BrowserRuntime> {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import('./nativeBrowser.js'),
      import('./parse.js'),
      import('./strategyHealing.js'),
    ]).then(async ([nativeModule, parseModule, healingModule]) => {
      const healing = new healingModule.StrategyHealing(
        config.selfHealingFile,
        config.selfHealingEnabled,
        parseModule.STRATEGIES.map((strategy) => strategy.id),
      );
      await healing.load();
      return {
        browser: new nativeModule.NativeChromeBrowser({
          executablePath: config.executablePath,
          profileDir: config.profileDir,
        }),
        healing,
      };
    });
  }
  return runtimePromise;
}
const endpoint = nativeBrowserBrokerEndpoint(config.profileDir);
const clients = new Set<Socket>();
let requestTail: Promise<unknown> = Promise.resolve();
let activeRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;

if (process.platform !== 'win32' && process.platform !== 'linux') {
  await rm(endpoint, { force: true });
}

function response(socket: Socket, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ ...value, brokerPid: process.pid })}\n`);
}

async function invoke(request: BrokerRequest): Promise<unknown> {
  if (request.method === '$status') return { state: 'connected', pid: process.pid };
  const { browser, healing } = await getRuntime();
  if (request.method === 'search') {
    const [query, limit, options] = request.args as [string, number, { locale?: string }];
    return await browser.search(query, limit, { ...options, healing });
  }
  if (request.method === 'searchMany') {
    const [queries, limit, options] = request.args as [string[], number, { locale?: string }];
    return await browser.searchMany(queries, limit, { ...options, healing });
  }
  if (request.method === 'scholar') {
    const [query, limit, locale] = request.args as [string, number, string | undefined];
    return await browser.scholar(query, limit, locale);
  }
  throw new Error('invalid native browser broker method');
}

async function handle(socket: Socket, line: string): Promise<void> {
  let request: BrokerRequest | undefined;
  activeRequests++;
  try {
    request = JSON.parse(line) as BrokerRequest;
    if (request.protocol !== NATIVE_BROWSER_BROKER_PROTOCOL) throw new Error('native browser broker protocol mismatch');
    if (request.configHash !== configHash) throw new Error('native browser broker configuration mismatch');
    if (request.token !== token) throw new Error('native browser broker authentication failed');
    if (!request.id || !Array.isArray(request.args)) throw new Error('invalid native browser broker request');
    const operation = () => invoke(request!);
    const current = requestTail.then(operation, operation);
    requestTail = current.then(() => undefined, () => undefined);
    const result = await current;
    response(socket, { id: request.id, ok: true, result });
  } catch (error) {
    response(socket, {
      id: request?.id ?? '',
      ok: false,
      error: serializeError(error),
    });
  } finally {
    activeRequests--;
    scheduleIdle();
  }
}

function scheduleIdle(): void {
  if (clients.size || activeRequests || stopping || config.idleMs === 0) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stop(), config.idleMs);
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(idleTimer);
  for (const client of clients) client.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (runtimePromise) {
    const runtime = await runtimePromise.catch(() => undefined);
    await runtime?.browser.close().catch(() => {});
    await runtime?.healing.flush().catch(() => {});
    runtime?.healing.shutdown();
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    await rm(endpoint, { force: true }).catch(() => {});
  }
  await releaseOwner(ownership.directory, ownership.owner);
  process.exit(0);
}

const server = createServer((socket) => {
  clients.add(socket);
  clearTimeout(idleTimer);
  let buffer = '';
  socket.setNoDelay(true);
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 16 * 1024 * 1024) {
      socket.destroy(new Error('native browser broker request exceeded 16 MiB'));
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
server.listen(endpoint, () => {
  if (config.idleMs !== 0) {
    idleTimer = setTimeout(() => void stop(), Math.max(config.idleMs, 10_000));
  }
});
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.once('SIGHUP', () => void stop());

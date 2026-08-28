import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ResearchService, type ResearchServiceOptions } from './service.js';

export const RESEARCH_BROKER_PROTOCOL = 1;
export const RESEARCH_BROKER_METHODS = new Set([
  'capture',
  'correctAssertion',
  'createPlan',
  'createProject',
  'exportVisualization',
  'finishExperiment',
  'forgetAssertion',
  'forgetProject',
  'getAssertion',
  'getEntity',
  'getProject',
  'indexProject',
  'linkEntity',
  'listProjects',
  'mergeEntities',
  'prepareRepositoryResults',
  'probe',
  'previewForgetAssertion',
  'previewForgetProject',
  'rebuildDerivedState',
  'recordDecision',
  'recordOntologyTerm',
  'recordSessionIntent',
  'rerankCandidates',
  'researchSearchContext',
  'restoreAssertion',
  'restoreProject',
  'search',
  'searchFamilies',
  'splitEntity',
  'startExperiment',
]);

export const RESEARCH_BROKER_READ_METHODS = new Set([
  'getAssertion',
  'getEntity',
  'getProject',
  'linkEntity',
  'listProjects',
  'probe',
  'rerankCandidates',
  'researchSearchContext',
  'search',
  'searchFamilies',
]);

export interface ResearchBrokerConfig {
  enabled: boolean;
  root: string;
  vectorModel?: string;
  repositoryAuto?: boolean;
  repositoryMaxSourceBytes?: number;
  repositoryMaxSourceFiles?: number;
  idleMs: number;
}

interface BrokerRequest {
  protocol: number;
  configHash: string;
  token: string;
  id: string;
  method: string;
  args: unknown[];
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  status?: ReturnType<ResearchService['status']>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ResearchBrokerClientOptions {
  idleMs?: number;
  processPath?: string;
}

function stableConfig(config: ResearchBrokerConfig): ResearchBrokerConfig {
  return { ...config, root: resolve(config.root) };
}

export function researchBrokerConfigHash(config: ResearchBrokerConfig): string {
  return createHash('sha256').update(JSON.stringify(stableConfig(config))).digest('hex');
}

function rootHash(root: string): string {
  const normalized = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 20);
}

export function researchBrokerEndpoint(root: string): string {
  const name = `google-surf-research-${rootHash(root)}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  return resolve(tmpdir(), `${name}.sock`);
}

export function researchBrokerDirectory(root: string): string {
  return resolve(root, 'broker');
}

export function researchBrokerTokenPath(root: string): string {
  return resolve(researchBrokerDirectory(root), 'token');
}

async function brokerToken(root: string): Promise<string> {
  const directory = researchBrokerDirectory(root);
  const path = researchBrokerTokenPath(root);
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const existing = (await readFile(path, 'utf8')).trim();
      if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      const value = randomBytes(32).toString('hex');
      await writeFile(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('research broker token is unavailable');
}

function defaultBrokerProcessPath(): string {
  const sibling = fileURLToPath(new URL('./brokerProcess.js', import.meta.url));
  if (existsSync(sibling)) return sibling;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../build/research/brokerProcess.js');
}

function connectSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('research broker connection timed out'));
    }, timeoutMs);
    const connected = () => {
      clearTimeout(timer);
      socket.off('error', failed);
      resolveSocket(socket);
    };
    const failed = (error: Error) => {
      clearTimeout(timer);
      socket.off('connect', connected);
      socket.destroy();
      reject(error);
    };
    socket.once('connect', connected);
    socket.once('error', failed);
  });
}

class ResearchBrokerClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = '';
  private readonly pending = new Map<string, PendingCall>();
  private currentStatus: ReturnType<ResearchService['status']>;
  private closed = false;

  constructor(
    private readonly config: ResearchBrokerConfig,
    private readonly processPath: string,
  ) {
    this.currentStatus = {
      enabled: config.enabled,
      state: 'broker_disconnected',
      root: config.root,
      vector: config.vectorModel === '' ? 'off' : 'on',
      external_sync: 'off',
      graph_projection_cache: 0,
      graph_artifact_cache: 0,
    };
  }

  status(): ReturnType<ResearchService['status']> {
    return this.currentStatus;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectPending(new Error('research broker client closed'));
    this.currentStatus = { ...this.currentStatus, state: 'broker_disconnected' };
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    if (!RESEARCH_BROKER_METHODS.has(method)) throw new Error(`unsupported research broker method: ${method}`);
    const token = await brokerToken(this.config.root);
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('research broker disconnected');
    const id = randomUUID();
    const request: BrokerRequest = {
      protocol: RESEARCH_BROKER_PROTOCOL,
      configHash: researchBrokerConfigHash(this.config),
      token,
      id,
      method,
      args,
    };
    const timeoutMs = ['exportVisualization', 'indexProject', 'rebuildDerivedState'].includes(method)
      ? 60 * 60_000
      : 5 * 60_000;
    return await new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`research broker method timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('research broker client closed');
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.connectOrStart().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async connectOrStart(): Promise<void> {
    const endpoint = researchBrokerEndpoint(this.config.root);
    try {
      this.attach(await connectSocket(endpoint, 250));
      return;
    } catch {}
    this.spawnBroker();
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      try {
        this.attach(await connectSocket(endpoint, 250));
        return;
      } catch (error) {
        lastError = error;
      }
      if (attempt > 0 && attempt % 10 === 0) this.spawnBroker();
    }
    throw new Error(`research broker did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private spawnBroker(): void {
    const encoded = Buffer.from(JSON.stringify(this.config)).toString('base64url');
    const child = spawn(process.execPath, [this.processPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SURF_RESEARCH_BROKER_CONFIG: encoded },
    });
    child.once('error', () => {});
    child.unref();
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = '';
    this.closed = false;
    this.currentStatus = { ...this.currentStatus, state: 'broker_connected' };
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('error', (error) => this.disconnected(socket, error));
    socket.on('close', () => this.disconnected(socket, new Error('research broker disconnected')));
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 64 * 1024 * 1024) {
      this.socket?.destroy(new Error('research broker response exceeded 64 MiB'));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response: BrokerResponse;
      try {
        response = JSON.parse(line) as BrokerResponse;
      } catch {
        this.socket?.destroy(new Error('invalid research broker response'));
        return;
      }
      if (response.status) this.currentStatus = response.status;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? 'research broker request failed'));
    }
  }

  private disconnected(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.currentStatus = { ...this.currentStatus, state: 'broker_disconnected' };
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createSharedResearchService(
  options: ResearchServiceOptions,
  clientOptions: ResearchBrokerClientOptions = {},
): ResearchService {
  if (!options.enabled || options.endpoint || options.embeddingProvider || options.repositoryClient) {
    return new ResearchService(options);
  }
  const config: ResearchBrokerConfig = stableConfig({
    enabled: options.enabled,
    root: options.root,
    vectorModel: options.vectorModel,
    repositoryAuto: options.repositoryAuto,
    repositoryMaxSourceBytes: options.repositoryMaxSourceBytes,
    repositoryMaxSourceFiles: options.repositoryMaxSourceFiles,
    idleMs: clientOptions.idleMs ?? 1_000,
  });
  const client = new ResearchBrokerClient(config, clientOptions.processPath ?? defaultBrokerProcessPath());
  const target = {
    status: () => client.status(),
    close: async () => await client.close(),
  };
  return new Proxy(target as unknown as ResearchService, {
    get(value, property, receiver) {
      if (Reflect.has(value as object, property)) return Reflect.get(value as object, property, receiver);
      if (typeof property !== 'string' || !RESEARCH_BROKER_METHODS.has(property)) return undefined;
      return async (...args: unknown[]) => await client.call(property, args);
    },
  });
}

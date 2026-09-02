import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { SearchOptions, SearchOutcome } from './search.js';
import { CaptchaError } from './search.js';
import { ScholarRateLimitError, type ScholarResult } from './scholar.js';
import type { NativeBrowserHandle } from './nativeBrowser.js';
import {
  NATIVE_BROWSER_BROKER_PROTOCOL,
  nativeBrowserBrokerConfigHash,
  nativeBrowserBrokerDirectory,
  nativeBrowserBrokerEndpoint,
  nativeBrowserBrokerTokenPath,
  normalizeNativeBrowserBrokerConfig,
  type NativeBrowserBrokerConfig,
} from './nativeBrowserBrokerProtocol.js';
export {
  nativeBrowserBrokerConfigHash,
  nativeBrowserBrokerDirectory,
  nativeBrowserBrokerEndpoint,
  nativeBrowserBrokerTokenPath,
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

interface SerializedError {
  name: string;
  message: string;
  userAction?: string;
  retryAfterMs?: number;
}

interface BrokerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: SerializedError;
  brokerPid?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface NativeBrowserBrokerClientOptions {
  processPath?: string;
}

export interface NativeBrowserBrokerStatus {
  state: 'disconnected' | 'connected';
  pid?: number;
}

async function brokerToken(profileDir: string): Promise<string> {
  const directory = nativeBrowserBrokerDirectory(profileDir);
  const path = nativeBrowserBrokerTokenPath(profileDir);
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
  throw new Error('native browser broker token is unavailable');
}

function defaultBrokerProcessPath(): string {
  const sibling = fileURLToPath(new URL('./nativeBrowserBrokerProcess.js', import.meta.url));
  if (existsSync(sibling)) return sibling;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../build/nativeBrowserBrokerProcess.js');
}

function connectSocket(endpoint: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveSocket, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('native browser broker connection timed out'));
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

function deserializeError(value?: SerializedError): Error {
  if (value?.name === 'CaptchaError') {
    const error = new CaptchaError('native-broker', value.userAction);
    error.message = value.message;
    return error;
  }
  if (value?.name === 'ScholarRateLimitError') {
    return new ScholarRateLimitError(value.retryAfterMs);
  }
  const error = new Error(value?.message ?? 'native browser broker request failed');
  error.name = value?.name ?? 'Error';
  return error;
}

export class SharedNativeBrowser implements NativeBrowserHandle {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<string, PendingCall>();
  private currentStatus: NativeBrowserBrokerStatus = { state: 'disconnected' };

  constructor(
    private readonly config: NativeBrowserBrokerConfig,
    private readonly processPath: string,
  ) {}

  status(): NativeBrowserBrokerStatus {
    return { ...this.currentStatus };
  }

  async probe(): Promise<NativeBrowserBrokerStatus> {
    return await this.call('$status', []) as NativeBrowserBrokerStatus;
  }

  async search(query: string, limit: number, opts: SearchOptions = {}): Promise<SearchOutcome> {
    return await this.call('search', [query, limit, { locale: opts.locale }]) as SearchOutcome;
  }

  async searchMany(
    queries: string[],
    limit: number,
    opts: SearchOptions = {},
  ): Promise<Array<{ query: string; outcome?: SearchOutcome; error?: string }>> {
    return await this.call('searchMany', [queries, limit, { locale: opts.locale }]) as Array<{
      query: string;
      outcome?: SearchOutcome;
      error?: string;
    }>;
  }

  async scholar(query: string, limit: number, locale?: string): Promise<ScholarResult[]> {
    return await this.call('scholar', [query, limit, locale]) as ScholarResult[];
  }

  async close(): Promise<void> {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectPending(new Error('native browser broker client closed'));
    this.currentStatus = { state: 'disconnected' };
  }

  private async call(method: BrokerRequest['method'], args: unknown[]): Promise<unknown> {
    const token = await brokerToken(this.config.profileDir);
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('native browser broker disconnected');
    const id = randomUUID();
    const request: BrokerRequest = {
      protocol: NATIVE_BROWSER_BROKER_PROTOCOL,
      configHash: nativeBrowserBrokerConfigHash(this.config),
      token,
      id,
      method,
      args,
    };
    return await new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(new Error(`native browser broker method timed out: ${method}`));
      }, 5 * 60_000);
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
    if (this.closed) throw new Error('native browser broker client closed');
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.connectOrStart().finally(() => { this.connecting = undefined; });
    }
    await this.connecting;
  }

  private async connectOrStart(): Promise<void> {
    const endpoint = nativeBrowserBrokerEndpoint(this.config.profileDir);
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
      if (attempt === 50) this.spawnBroker();
    }
    throw new Error(`native browser broker did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private spawnBroker(): void {
    const encoded = Buffer.from(JSON.stringify(this.config)).toString('base64url');
    const child = spawn(process.execPath, [this.processPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, SURF_NATIVE_BROWSER_BROKER_CONFIG: encoded },
    });
    child.once('error', () => {});
    child.unref();
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = '';
    this.currentStatus = { state: 'connected' };
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('error', (error) => this.disconnected(socket, error));
    socket.on('close', () => this.disconnected(socket, new Error('native browser broker disconnected')));
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.socket?.destroy(new Error('native browser broker response exceeded 16 MiB'));
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
        this.socket?.destroy(new Error('invalid native browser broker response'));
        return;
      }
      if (response.brokerPid) this.currentStatus = { state: 'connected', pid: response.brokerPid };
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(deserializeError(response.error));
    }
  }

  private disconnected(socket: Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.currentStatus = { state: 'disconnected' };
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

export function createSharedNativeBrowser(
  options: NativeBrowserBrokerConfig,
  clientOptions: NativeBrowserBrokerClientOptions = {},
): SharedNativeBrowser {
  return new SharedNativeBrowser(
    normalizeNativeBrowserBrokerConfig(options),
    clientOptions.processPath ?? defaultBrokerProcessPath(),
  );
}

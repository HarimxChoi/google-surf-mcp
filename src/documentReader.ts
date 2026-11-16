import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DOCUMENT_BYTES, type DocumentFormat } from './documentFormats.js';
import type { ExtractMode, ExtractResult } from './extract.js';
import { DOCUMENT_SETTING_KEYS } from './documentSettings.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dependencyRoots = new Set<string>();
function dependencyVersion(name: string): string {
  let path: string;
  try { path = dirname(require.resolve(name)); } catch { return 'unavailable'; }
  for (let i = 0; i < 5; i++, path = dirname(path)) {
    try {
      const metadata = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      if (metadata.name !== name) continue;
      const parent = dirname(path);
      dependencyRoots.add(basename(parent).startsWith('@') ? dirname(parent) : parent);
      return String(metadata.version);
    } catch {}
  }
  return 'unknown';
}
const versions = Object.fromEntries(['@llamaindex/liteparse', 'officeparser', '@xberg-io/xberg', 'hwp-convert', 'saxes']
  .map(name => [name, dependencyVersion(name)]));
// Module lookup can read a junction alias before resolving its real dependency path.
for (const path of require.resolve.paths('officeparser') ?? []) dependencyRoots.add(path);

function settings(): Record<string, string> {
  return Object.fromEntries(DOCUMENT_SETTING_KEYS.map(name => [name, process.env[name] ?? '']));
}

export function documentParserFingerprint(): string {
  return JSON.stringify({ reader: 'document-v2', versions, settings: settings() });
}

let worker: ChildProcess | undefined;
let idle: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

function stopWorker(): void {
  if (idle) clearTimeout(idle);
  worker?.kill(); worker = undefined;
}

function acquireWorker(): ChildProcess {
  if (idle) clearTimeout(idle);
  if (worker?.connected && !worker.killed) { worker.ref(); worker.channel?.ref(); return worker; }
  const env: NodeJS.ProcessEnv = { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', UV_THREADPOOL_SIZE: '2',
    TOKIO_WORKER_THREADS: '2', RAYON_NUM_THREADS: '2' };
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  worker = fork(new URL('./documentWorker.js', import.meta.url), [], { windowsHide: true,
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env,
    execArgv: ['--max-old-space-size=256', '--permission', '--allow-addons',
      `--allow-fs-read=${here}`, `--allow-fs-read=${join(dirname(here), 'package.json')}`,
      ...[...dependencyRoots].map(root => `--allow-fs-read=${root}`)] });
  return worker;
}

async function execute(bytes: Uint8Array, format: DocumentFormat | 'native', mode: ExtractMode, maxChars: number): Promise<ExtractResult> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { url: '', error: 'document exceeds 25 MiB; split the source', extraction_quality: 'metadata_only' };
  const child = acquireWorker();
  const id = ++sequence;
  return await new Promise<ExtractResult>(resolve => {
    let settled = false;
    const finish = (result: ExtractResult, failed = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', exit);
      if (failed) stopWorker();
      else {
        child.unref(); child.channel?.unref(); idle = setTimeout(stopWorker, 2000); idle.unref();
      }
      resolve(result);
    };
    const error = (failure: Error): void => finish({ url: '', error: `document worker: ${failure.message.slice(0, 180)}`,
      extraction_quality: 'metadata_only', quality_reason: 'document_worker_failed' }, true);
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => error(new Error(`exited before returning a result (code=${code}, signal=${signal})`));
    const message = (value: unknown): void => {
      const row = value as { id?: number; result?: ExtractResult };
      if (row.id === id && row.result) finish(row.result);
    };
    const timer = setTimeout(() => finish({ url: '', error: 'document parsing timed out; split the source or disable OCR',
      extraction_quality: 'metadata_only', quality_reason: 'document_worker_timeout' }, true), format === 'native' ? 30_000 : 120_000);
    child.on('message', message); child.once('error', error); child.once('exit', exit);
    child.send({ id, bytes, format, mode, maxChars: Math.min(1_000_000, Math.max(0, maxChars)), settings: settings() }, error => {
      if (error) finish({ url: '', error: error.message.slice(0, 180), extraction_quality: 'metadata_only' }, true);
    });
  });
}

export function readBinaryDocument(bytes: Uint8Array, format: DocumentFormat | 'native', mode: ExtractMode = 'full', maxChars = 1_000_000): Promise<ExtractResult> {
  const result = queue.then(() => execute(bytes, format, mode, maxChars)).catch(error => ({ url: '',
    error: `document worker: ${(error as Error).message.slice(0, 180)}`, extraction_quality: 'metadata_only' as const,
    quality_reason: 'document_worker_failed' }));
  queue = result.catch(() => {});
  return result;
}

export const closeDocumentReader = stopWorker;

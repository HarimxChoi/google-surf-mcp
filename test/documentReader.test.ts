import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDocumentReader, documentParserFingerprint, readBinaryDocument } from '../src/documentReader.js';

const state = vi.hoisted(() => ({ requests: [] as Array<{ id: number; bytes: Uint8Array; settings: object }>,
  options: [] as Array<Record<string, unknown>>, active: 0, peak: 0, silent: false, failNext: false, killed: 0 }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return { fork: vi.fn((_url: unknown, _args: unknown, options: Record<string, unknown>) => {
    state.options.push(options);
    const child = Object.assign(new EventEmitter(), { connected: true, killed: false,
      ref: vi.fn(), unref: vi.fn(), channel: { ref: vi.fn(), unref: vi.fn() },
      kill() { child.killed = true; state.killed++; },
      send(request: { id: number; bytes: Uint8Array; settings: object }, callback: (error: Error | null) => void) {
        state.requests.push(request);
        if (state.failNext) { state.failNext = false; callback(new Error('IPC failed')); return; }
        callback(null);
        if (state.silent) return;
        state.peak = Math.max(state.peak, ++state.active);
        setTimeout(() => { state.active--; child.emit('message', { id: request.id,
          result: { url: '', content: '8192', extraction_quality: 'full_text' } }); }, 1);
      } });
    return child;
  }) };
});
afterEach(() => {
  closeDocumentReader(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  state.requests.length = state.options.length = 0;
  state.active = state.peak = state.killed = 0; state.silent = state.failNext = false;
});

describe('bounded document worker lifecycle', () => {
  it('serializes parallel inputs and reuses the same worker within a burst', async () => {
    const results = await Promise.all([1, 2, 3].map(value => readBinaryDocument(Uint8Array.of(value), 'native')));
    expect(results.map(r => r.content)).toEqual(['8192', '8192', '8192']);
    expect(state.peak).toBe(1);
    expect(state.options).toHaveLength(1);
    expect(state.requests).toHaveLength(3);
  });
  it('uses a hidden byte-only process without copying provider secrets or shell configuration', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-be-inherited');
    vi.stubEnv('NODE_OPTIONS', '--require=untrusted-hook');
    await readBinaryDocument(Uint8Array.of(1), 'native');
    const options = state.options[0];
    expect(options.windowsHide).toBe(true);
    expect(options.serialization).toBe('advanced');
    expect(options.execArgv).toContain('--max-old-space-size=256');
    expect(options.env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(state.requests[0]).not.toHaveProperty('command');
    expect(state.requests[0]).not.toHaveProperty('url');
  });
  it('returns a local worker failure and permits the next call to start a fresh worker', async () => {
    state.failNext = true;
    expect((await readBinaryDocument(Uint8Array.of(1), 'native')).error).toContain('IPC failed');
    expect((await readBinaryDocument(Uint8Array.of(2), 'native')).content).toBe('8192');
    expect(state.options).toHaveLength(2);
  });
  it('permits module lookup aliases without granting arbitrary filesystem reads', async () => {
    await readBinaryDocument(Uint8Array.of(1), 'native');
    const arguments_ = state.options[0].execArgv as string[];
    const source = new URL('../src/documentReader.ts', import.meta.url);
    for (const path of createRequire(source).resolve.paths('officeparser') ?? []) {
      expect(arguments_).toContain(`--allow-fs-read=${path}`);
    }
    expect(arguments_).toContain(`--allow-fs-read=${join(dirname(dirname(fileURLToPath(source))), 'package.json')}`);
    expect(arguments_).not.toContain('--allow-fs-read=*');
  });
  it('rejects oversized input before starting a process', async () => {
    const result = await readBinaryDocument(new Uint8Array(25 * 1024 * 1024 + 1), 'native');
    expect(result.error).toContain('25 MiB');
    expect(state.options).toHaveLength(0);
  });
  it('terminates a stalled native parse at the deadline', async () => {
    vi.useFakeTimers(); state.silent = true;
    const pending = readBinaryDocument(Uint8Array.of(1), 'native');
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await pending).quality_reason).toBe('document_worker_timeout');
    expect(state.killed).toBe(1);
  });
  it('includes parser policy changes in the reuse fingerprint', () => {
    const before = documentParserFingerprint();
    vi.stubEnv('SURF_EXTRACT_OCR_LANGUAGE', 'kor');
    expect(documentParserFingerprint()).not.toBe(before);
  });
});

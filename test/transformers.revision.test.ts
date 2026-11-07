import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/transformers-revision.mjs', import.meta.url));

function runFixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'surf-transformers-revision-'));
  try {
    const child = spawnSync(process.execPath, [fixture, mode, root], {
      encoding: 'utf8', timeout: 15_000,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    return JSON.parse(child.stdout.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('vendored Transformers pinned revision loading', () => {
  it('loads a callable tokenizer from only the requested revision and cache_dir', () => {
    const result = runFixture('pinned-cache');
    expect(result).toMatchObject({
      tokenizer_type: 'function',
      input_ids: [[2, 4, 5, 3], [2, 4, 3, 0]],
      output_shape: [2, 2],
      model_loads: 1,
      model_calls: 1,
      disposals: 1,
      fetches: [],
      default_cache_created: false,
      onnx_files: 0,
    });
    expect(result.fixture_bytes).toBeLessThan(2_048);
  }, 20_000);

  it('honors local_files_only on a cache miss even when remote models are enabled', () => {
    const result = runFixture('local-only-miss');
    expect(result).toMatchObject({
      model_loads: 0,
      model_calls: 0,
      disposals: 0,
      fetches: [],
      default_cache_created: false,
      onnx_files: 0,
    });
    expect(result.missing_error).toContain('local_files_only=true');
  }, 20_000);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';

describe('deterministic project indexing', () => {
  let root: string;
  let source: string;
  let service: ResearchService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'surf-index-db-'));
    source = mkdtempSync(join(tmpdir(), 'surf-index-source-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
    mkdirSync(join(source, 'src'));
    mkdirSync(join(source, 'evidence'));
    mkdirSync(join(source, 'docs'));
    writeFileSync(join(source, 'src', 'kernel.ts'), 'export const unique_code_token = 1;');
    writeFileSync(join(source, 'evidence', 'run-prereg.json'), JSON.stringify({
      hypothesis: 'unique prereg hypothesis',
    }));
    writeFileSync(join(source, 'evidence', 'run-result.json'), JSON.stringify({
      decision: 'retain unique_result_token',
    }));
    writeFileSync(join(source, 'docs', 'README.md'), 'duplicate report body');
    writeFileSync(join(source, 'docs', 'PLAN.md'), 'duplicate report body');
    writeFileSync(join(source, 'notes.txt'), 'untracked_data_token');
    writeFileSync(join(source, 'model.gguf'), 'binary reference');
  });

  afterEach(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  it('stores one stable structured snapshot and searches selected bodies', async () => {
    await service.createProject('Index test', 'index-test');
    const first = await service.indexProject({
      project_id: 'index-test',
      roots: [{ label: 'repo', path: source }],
    });
    const second = await service.indexProject({
      project_id: 'index-test',
      roots: [{ label: 'repo', path: source }],
    });
    const derived = await service.rebuildDerivedState('index-test');
    const graph = await service.materializeGraph(['index-test']);
    const reusedDerived = await service.rebuildDerivedState('index-test');
    const detail = await service.getProject('index-test');

    expect(first).toMatchObject({
      reused: false,
      policy: 'structured',
      file_count: 7,
      searchable_file_count: 5,
      unique_body_count: 4,
      added_count: 7,
      modified_count: 0,
      removed_count: 0,
      job_status: 'done',
    });
    expect(second).toMatchObject({
      reused: true,
      snapshot_id: first.snapshot_id,
      added_count: 0,
      modified_count: 0,
      removed_count: 0,
      summary: 'Project: Index test | Stored: no changes',
      job_id: first.job_id,
      job_status: 'done',
    });
    expect(detail.source_entry_count).toBe(7);
    expect(graph.job.status).toBe('done');
    expect(derived.projection_id).toBe(graph.projection.projection_id);
    expect(reusedDerived).toMatchObject({ code_elapsed_ms: 0, graph_elapsed_ms: 0 });
    expect(detail.job_counts.done).toBe(3);
    expect(detail.active_source_snapshot?.inventory_digest).toBe(first.inventory_digest);
    expect(await service.search('index-test', 'unique_result_token', 10)).toHaveLength(1);
    expect(await service.search('index-test', 'unique_code_token', 10)).toHaveLength(1);
    expect(await service.search('index-test', 'untracked_data_token', 10)).toHaveLength(0);
  });

  it('stores only deterministic changes and updates the active projection', async () => {
    await service.createProject('Index delta test', 'index-delta-test');
    const first = await service.indexProject({
      project_id: 'index-delta-test',
      roots: [{ label: 'repo', path: source }],
    });

    writeFileSync(join(source, 'src', 'kernel.ts'), 'export const replacement_code_token = 2;');
    const modified = await service.indexProject({
      project_id: 'index-delta-test',
      roots: [{ label: 'repo', path: source }],
    });

    expect(modified).toMatchObject({
      reused: false,
      added_count: 0,
      modified_count: 1,
      removed_count: 0,
      file_count: 7,
    });
    expect(modified.snapshot_id).not.toBe(first.snapshot_id);
    expect(await service.search('index-delta-test', 'unique_code_token', 10)).toHaveLength(0);
    expect(await service.search('index-delta-test', 'replacement_code_token', 10)).toHaveLength(1);

    rmSync(join(source, 'evidence', 'run-result.json'));
    const removed = await service.indexProject({
      project_id: 'index-delta-test',
      roots: [{ label: 'repo', path: source }],
    });
    const detail = await service.getProject('index-delta-test');

    expect(removed).toMatchObject({
      reused: false,
      added_count: 0,
      modified_count: 0,
      removed_count: 1,
      file_count: 6,
    });
    expect(detail.source_entry_count).toBe(6);
    expect(await service.search('index-delta-test', 'unique_result_token', 10)).toHaveLength(0);

    writeFileSync(join(source, 'evidence', 'run-result.json'), JSON.stringify({
      decision: 'retain unique_result_token',
    }));
    writeFileSync(join(source, 'src', 'kernel.ts'), 'export const unique_code_token = 1;');
    const reverted = await service.indexProject({
      project_id: 'index-delta-test',
      roots: [{ label: 'repo', path: source }],
    });

    expect(reverted).toMatchObject({
      reused: false,
      added_count: 1,
      modified_count: 1,
      removed_count: 0,
      file_count: 7,
    });
    expect(reverted.inventory_digest).toBe(first.inventory_digest);
    expect(reverted.snapshot_id).not.toBe(first.snapshot_id);
  });

  it('drains code larger than one worker batch without permanent deferral', async () => {
    const padding = 'x'.repeat(900 * 1024);
    for (let index = 0; index < 10; index++) {
      writeFileSync(
        join(source, 'src', `bulk-${index}.ts`),
        `export function bulk_symbol_${index}() { return ${index}; }\n/*${padding}*/`,
      );
    }
    await service.createProject('Full code index', 'full-code-index');
    await service.indexProject({
      project_id: 'full-code-index',
      roots: [{ label: 'repo', path: source }],
    });
    const derived = await service.rebuildDerivedState('full-code-index');
    const graph = await service.exportGraphProjection(['full-code-index']);

    expect(derived.code_sources).toBe(11);
    expect(derived.code_sources_deferred).toBe(0);
    expect(graph.nodes.some((node) => node.kind === 'symbol' && node.label === 'bulk_symbol_9'))
      .toBe(true);
  });
});

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';

describe('deterministic project indexing', () => {
  let root: string;
  let source: string;
  let extraSource: string | undefined;
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
    if (extraSource) rmSync(extraSource, { recursive: true, force: true });
    extraSource = undefined;
  });

  it('stores one stable structured snapshot and searches selected bodies', async () => {
    await service.createProject('Index test', 'index-test');
    const first = await service.indexProject({
      project_id: 'index-test',
      roots: [{ label: 'repo', path: source }],
    });
    await service.waitForIdle();
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
      job_status: 'running',
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
    await service.waitForIdle();

    writeFileSync(join(source, 'src', 'kernel.ts'), 'export const replacement_code_token = 2;');
    const modified = await service.indexProject({
      project_id: 'index-delta-test',
      roots: [{ label: 'repo', path: source }],
    });
    await service.waitForIdle();

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
    await service.waitForIdle();
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
    await service.waitForIdle();

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

  it('syncs declared paths without rescanning or removing unrelated entries', async () => {
    await service.createProject('Explicit delta', 'explicit-delta');
    await service.indexProject({
      project_id: 'explicit-delta', roots: [{ label: 'repo', path: source }],
    });
    await service.waitForIdle();
    writeFileSync(join(source, 'src', 'kernel.ts'), 'export const incremental_only_token = 3;');
    writeFileSync(join(source, 'docs', 'PLAN.md'), 'unannounced disk change');
    rmSync(join(source, 'evidence', 'run-result.json'));
    const changed = await service.indexProject({
      project_id: 'explicit-delta',
      changed_paths: [{ root: 'repo', path: 'src/kernel.ts' }],
      removed_paths: [{ root: 'repo', path: 'evidence/run-result.json' }],
    });
    await service.waitForIdle();

    expect(changed).toMatchObject({
      added_count: 0,
      modified_count: 1,
      removed_count: 1,
      file_count: 6,
    });
    expect(await service.search('explicit-delta', 'incremental_only_token', 10)).toHaveLength(1);
    expect(await service.search('explicit-delta', 'unique_result_token', 10)).toHaveLength(0);
    expect(await service.search('explicit-delta', 'unannounced disk change', 10)).toHaveLength(0);
    expect(await service.search('explicit-delta', 'duplicate report body', 10)).not.toHaveLength(0);
  });

  it('adds and removes one registered root without replacing unrelated roots', async () => {
    extraSource = mkdtempSync(join(tmpdir(), 'surf-index-extra-'));
    writeFileSync(join(extraSource, 'RESEARCH.md'), 'extra_root_only_token');
    await service.createProject('Root registry', 'root-registry');
    await service.indexProject({
      project_id: 'root-registry', roots: [{ label: 'repo', path: source }],
    });
    await service.waitForIdle();

    const added = await service.indexProject({
      project_id: 'root-registry', roots: [{ label: 'extra', path: extraSource }],
    });
    await service.waitForIdle();
    expect(added).toMatchObject({ file_count: 8, added_count: 1, removed_count: 0 });
    expect(await service.search('root-registry', 'unique_code_token', 10)).toHaveLength(1);
    expect(await service.search('root-registry', 'extra_root_only_token', 10)).toHaveLength(1);

    const removed = await service.indexProject({
      project_id: 'root-registry',
      root_mode: 'remove',
      roots: [{ label: 'extra', path: extraSource }],
    });
    await service.waitForIdle();
    const detail = await service.getProject('root-registry');
    expect(removed).toMatchObject({ file_count: 7, added_count: 0, removed_count: 1 });
    expect(detail.active_source_snapshot?.roots.map((root) => root.label)).toEqual(['repo']);
    expect(await service.search('root-registry', 'unique_code_token', 10)).toHaveLength(1);
    expect(await service.search('root-registry', 'extra_root_only_token', 10)).toHaveLength(0);
  });

  it('keeps an unambiguous moved path as an exact historical alias', async () => {
    await service.createProject('Move alias', 'move-alias');
    await service.indexProject({
      project_id: 'move-alias', roots: [{ label: 'repo', path: source }],
    });
    await service.waitForIdle();
    renameSync(join(source, 'src', 'kernel.ts'), join(source, 'src', 'renamed-kernel.ts'));
    const moved = await service.indexProject({
      project_id: 'move-alias',
      changed_paths: [{ root: 'repo', path: 'src/renamed-kernel.ts' }],
      removed_paths: [{ root: 'repo', path: 'src/kernel.ts' }],
    });
    await service.waitForIdle();

    expect(moved).toMatchObject({ added_count: 1, removed_count: 1, unique_body_count: 4 });
    const historical = await service.search('move-alias', 'repo/src/kernel.ts', 10);
    expect(historical).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'repo/src/renamed-kernel.ts',
        record_id: expect.any(String),
        body_handle: expect.any(String),
        index_freshness: 'current',
      }),
    ]));
    const exact = await service.getCatalogRecord(
      'move-alias', historical[0].body_handle!, undefined, 0, 1_024,
    ) as unknown as { source: true; entry: { historical_locations: string[] }; body: string };
    expect(exact).toMatchObject({
      source: true,
      entry: { historical_locations: ['repo/src/kernel.ts'] },
      body: 'export const unique_code_token = 1;',
    });
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
    await service.waitForIdle();
    const derived = await service.rebuildDerivedState('full-code-index');
    const graph = await service.exportGraphProjection(['full-code-index']);

    expect(derived.code_sources).toBe(11);
    expect(derived.code_sources_deferred).toBe(0);
    expect(graph.nodes.some((node) => node.kind === 'symbol' && node.label === 'bulk_symbol_9'))
      .toBe(true);
  }, 15_000);
});

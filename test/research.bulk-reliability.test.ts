import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiDirectedGraph } from 'graphology';
import { stronglyConnectedComponents } from 'graphology-components';
import type { KnowledgeJobRecord } from '../src/research/contracts.js';
import { legacyCatalogFields } from '../src/research/catalogFields.js';
import { stronglyConnectedCount } from '../src/research/graphSidecar.js';
import { ResearchService } from '../src/research/service.js';
import { projectMemoryTool } from '../src/research/tools.js';

describe('bulk research reliability', () => {
  let root: string;
  let service: ResearchService;
  const projectId = 'bulk-reliability';
  const nbaFields = { metric: 'home_win_rate', value: 0.625, unit: 'fraction',
    evaluator_contract: 'nba-game-outcomes-v1', dataset: 'synthetic-nba-games', split: 'validation',
    targets: 'home-team wins', source_locator: 'fixture://nba/outcomes/home-win-rate' };

  async function catalog(recordId: string) {
    const stored = await service.getCatalogRecord(projectId, recordId);
    if ('legacy' in stored || 'source' in stored) throw new Error('Expected a catalog record');
    return stored;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-bulk-reliability-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Sports Research Workspace', projectId);
  });

  afterEach(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it('records an NBA measurement without inapplicable LLM tokenizer, context, or carrier fields', async () => {
    const fields = nbaFields;
    const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
      operation: 'create', asset_id: 'nba-home-win-rate', idempotency_key: 'nba-home-win-rate-v1', fields });
    expect(receipt.durability).toBe('committed');
    const stored = await service.getCatalogRecord(projectId, receipt.record_id);
    if ('legacy' in stored || 'source' in stored) throw new Error('Expected a catalog measurement');
    expect(stored.asset.kind).toBe('measurement');
    expect(stored.revision.fields).toMatchObject(fields);
    for (const name of ['tokenizer', 'context_length', 'carrier_precision']) {
      expect(stored.revision.fields[name]).toBeUndefined();
    }
  });

  it.each(['generic', 'llm'] as const)('validates a value-only %s measurement patch against merged fields', async profile => {
    const fields = { ...nbaFields, measurement_profile: profile,
      ...(profile === 'llm' ? { tokenizer: 'fixture-tokenizer', context_length: 2048, carrier_precision: 'fp16' } : {}) };
    const assetId = `value-only-${profile}`;
    const first = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
      operation: 'create', asset_id: assetId, idempotency_key: `${assetId}-v1`, fields });
    const before = await catalog(first.record_id);
    const patched = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
      operation: 'patch', asset_id: assetId, expected_revision: first.revision,
      idempotency_key: `${assetId}-v2`, fields: { value: 0.75 } });
    const after = await catalog(patched.record_id);
    expect(after.revision.fields).toMatchObject({ ...fields, value: 0.75 });
    expect(after.revision.fields.comparison_contract_id).toBe(before.revision.fields.comparison_contract_id);
    expect(patched.revision).toBe(first.revision + 1);
  });

  it('preserves measurement comparison identity when relocating only its source locator', async () => {
    const first = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
      operation: 'create', asset_id: 'relocated-measurement', idempotency_key: 'relocation-v1', fields: nbaFields });
    const before = await catalog(first.record_id);
    const moved = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
      operation: 'relocate', asset_id: first.record_id, expected_revision: first.revision,
      idempotency_key: 'relocation-v2', fields: { source_locator: 'fixture://relocated/nba/result.json' } });
    const after = await catalog(moved.record_id);
    expect(after.revision.fields.source_locator).toBe('fixture://relocated/nba/result.json');
    expect(after.revision.fields.comparison_contract_id).toBe(before.revision.fields.comparison_contract_id);
    expect(after.revision.fields.value).toBe(nbaFields.value);
  });

  it('preserves declared missing dataset on a value-only NBA measurement patch', async () => {
    const { dataset: _dataset, ...fields } = nbaFields;
    const created = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement', operation: 'create',
      asset_id: 'nba-unknown-dataset', idempotency_key: 'nba-unknown-dataset-v1', fields, missing_fields: ['dataset'] });
    const before = await catalog(created.record_id);
    const patched = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement', operation: 'patch',
      asset_id: created.record_id, expected_revision: created.revision, idempotency_key: 'nba-unknown-dataset-v2',
      fields: { value: 0.75 } });
    const after = await catalog(patched.record_id);
    expect(after.revision.fields.value).toBe(0.75);
    expect(after.revision.fields.dataset).toBeUndefined();
    expect(after.revision.missing_fields).toEqual(['dataset']);
    expect(after.revision.fields.comparison_contract_id).toBe(before.revision.fields.comparison_contract_id);
  });

  it('replays an exact legacy measurement receipt hash but rejects changed values', async () => {
    const fields = { metric: 'ppl', value: 7.04, unit: 'perplexity', evaluator_contract: 'fixture-ppl-v1',
      dataset: 'synthetic-text', split: 'test', tokenizer: 'fixture-tokenizer', context_length: 2048,
      targets: 'all fixture tokens', carrier_precision: 'fp16', source_locator: 'fixture://legacy/ppl.json' };
    const input = { project_id: projectId, kind: 'measurement' as const, operation: 'create' as const,
      idempotency_key: 'legacy-measurement-v1', fields };
    const commits = vi.spyOn(service['store'], 'commitCatalogRevision');
    let first: Awaited<ReturnType<ResearchService['writeCatalogRecord']>>;
    let captured: Parameters<ResearchService['store']['commitCatalogRevision']>[0];
    try {
      first = await service.writeCatalogRecord({ ...input, asset_id: 'legacy-existing-record-id' });
      captured = commits.mock.calls[0][0];
    } finally { commits.mockRestore(); }
    await service.waitForIdle();
    const { request_hash: _hash, update_project_profile: _profile, ...normalized } = captured!;
    const legacy = { ...normalized, fields: legacyCatalogFields('measurement', fields), missing_fields: [] };
    const propertyOrder = [...new Set([...Object.keys(legacy), ...Object.keys(legacy.fields)])].sort();
    const legacyHash = createHash('sha256').update(JSON.stringify(legacy, propertyOrder)).digest('hex');
    const storedReceipt = await service['store'].getOperationReceipt(projectId, input.idempotency_key);
    expect(legacyHash).not.toBe(storedReceipt!.request_hash);
    await service['store'].updateOperationReceipt({ ...storedReceipt!, request_hash: legacyHash });
    const replayed = await service.writeCatalogRecord(input);
    expect(replayed).toMatchObject({ record_id: first!.record_id, revision: first!.revision,
      request_hash: legacyHash, idempotent_replay: true, applied_this_request: false });
    await expect(service.writeCatalogRecord({ ...input, fields: { ...fields, value: 8.1 } }))
      .rejects.toThrow('idempotency key conflict');
    expect((await catalog(first!.record_id)).revision.fields.value).toBe(7.04);
    expect((await service['store'].getOperationReceipt(projectId, input.idempotency_key))?.request_hash).toBe(legacyHash);
  });

  it('gives equal measurement conditions the same comparison ID across different source paths', async () => {
    const ids = [];
    for (const suffix of ['a', 'b']) {
      const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement',
        operation: 'create', asset_id: `same-conditions-${suffix}`, idempotency_key: `same-conditions-${suffix}-v1`,
        fields: { ...nbaFields, source_locator: `fixture://source-${suffix}/nba/result.json` } });
      ids.push((await catalog(receipt.record_id)).revision.fields.comparison_contract_id);
    }
    expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('distinguishes inapplicable generic fields from unknown fields and rejects conflicting declarations', async () => {
    const { dataset: _dataset, ...knownFields } = nbaFields;
    const fields = { ...knownFields, measurement_profile: 'generic',
      not_applicable_fields: ['tokenizer', 'context_length', 'carrier_precision'] };
    const input = { project_id: projectId, kind: 'measurement' as const, operation: 'create' as const,
      asset_id: 'declared-unknown', idempotency_key: 'declared-unknown-v1', fields, missing_fields: ['dataset'] };
    const receipt = await service.writeCatalogRecord(input);
    const stored = await catalog(receipt.record_id);
    expect(stored.revision.fields.not_applicable_fields).toEqual(fields.not_applicable_fields);
    expect(stored.revision.missing_fields).toEqual(['dataset']);
    expect(stored.revision.fields.dataset).toBeUndefined();
    await expect(service.writeCatalogRecord({ ...input, asset_id: 'undeclared-unknown',
      idempotency_key: 'undeclared-unknown-v1', missing_fields: [] })).rejects.toThrow('measurement fields missing: dataset');
    const conflict = { ...input, asset_id: 'declaration-conflict', idempotency_key: 'declaration-conflict-v1',
      missing_fields: ['dataset', 'tokenizer'] };
    await expect(service.writeCatalogRecord(conflict)).rejects.toThrow('not_applicable_fields cannot also');
    await expect(service.getCatalogRecord(projectId, conflict.asset_id)).rejects.toThrow('record not found in project');
    await expect(service.writeCatalogRecord({ ...input, asset_id: 'value-conflict', idempotency_key: 'value-conflict-v1',
      fields: { ...fields, tokenizer: 'inapplicable-but-provided' } })).rejects.toThrow('not_applicable_fields cannot also');
    const repaired = await service.writeCatalogRecord({ ...conflict, missing_fields: ['dataset'] });
    expect(repaired.durability).toBe('committed');
  });

  it('requires LLM extension fields for an explicit LLM profile or an inferred tokenizer profile', async () => {
    for (const [suffix, extra] of [['explicit', { measurement_profile: 'llm' }], ['inferred', { tokenizer: 'fixture-tokenizer' }]] as const) {
      await expect(service.writeCatalogRecord({ project_id: projectId, kind: 'measurement', operation: 'create',
        asset_id: `llm-${suffix}`, idempotency_key: `llm-${suffix}-v1`, fields: { ...nbaFields, ...extra } }))
        .rejects.toThrow('context_length');
    }
  });

  it('keeps a project-kind subcatalog asset from renaming or replacing the parent profile', async () => {
    const before = (await service.getProject(projectId)).project;
    const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'project',
      operation: 'create', asset_id: 'nba-track', idempotency_key: 'nba-track-v1',
      fields: { name: 'NBA Tracking Experiment', purpose: 'Synthetic sports tracking subcatalog.' } });
    const after = (await service.getProject(projectId)).project;
    expect(after.name).toBe(before.name);
    expect(after.purpose).toBe(before.purpose);
    expect(after.project_profile_asset_id).toBe(before.project_profile_asset_id);
    expect(after.project_profile_revision_id).toBe(before.project_profile_revision_id);
    const stored = await service.getCatalogRecord(projectId, receipt.record_id);
    if ('legacy' in stored || 'source' in stored) throw new Error('Expected a catalog project asset');
    expect(stored.asset.asset_id).toBe('nba-track');
    expect(stored.revision.fields.name).toBe('NBA Tracking Experiment');
  });

  it('stores an explicit track asset without mutating the parent project profile', async () => {
    const before = (await service.getProject(projectId)).project;
    const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'track',
      operation: 'create', asset_id: 'nba-track-kind', idempotency_key: 'nba-track-kind-v1',
      fields: { name: 'NBA Track', purpose: 'Synthetic child track.' } });
    const stored = await catalog(receipt.record_id);
    expect(stored.asset.kind).toBe('track');
    const after = (await service.getProject(projectId)).project;
    expect(after.name).toBe(before.name);
    expect(after.project_profile_asset_id).toBe(before.project_profile_asset_id);
    const updated = await service.updateProjectProfile({ project_id: projectId,
      expected_revision: 0, idempotency_key: 'explicit-profile-update-v1',
      name: 'Explicitly Updated Sports Workspace', purpose: 'User-approved root profile update.' });
    expect(updated.project.name).toBe('Explicitly Updated Sports Workspace');
    expect(updated.project.project_profile_asset_id).toBe(projectId);
    expect((await catalog(receipt.record_id)).revision.fields.name).toBe('NBA Track');
  });

  it('keeps 2899-source job views compact while paging every preserved source ID', async () => {
    const sourceIds = Array.from({ length: 2899 }, (_, index) => `synthetic-source-${index}`);
    const request = { operation: 'sync', changed_paths: sourceIds };
    const queued = await service.queueKnowledgeJob({ project_id: projectId, kind: 'source_sync',
      source_hash: 'compact-job-sources-v1', schema_version: 'fixture-v1', algorithm_version: 'fixture-v1',
      affected_source_ids: sourceIds, request });
    const response = await projectMemoryTool({ action: 'job_status', project_id: projectId, job_id: queued.job_id }, service);
    expect(response.isError).not.toBe(true);
    const status = response.structuredContent?.job as Awaited<ReturnType<ResearchService['jobStatus']>>;
    expect(status.affected_source_count).toBe(2899);
    expect(status).not.toHaveProperty('affected_source_ids');
    expect(status).not.toHaveProperty('request');
    expect(JSON.stringify(response).length).toBeLessThan(5000);
    expect(status.sources).toMatchObject({ action: 'job_sources', job_id: queued.job_id, offset: 0, limit: 100 });
    const collected: string[] = [];
    let offset: number | undefined = 0;
    let pageCount = 0;
    while (offset !== undefined) {
      const page = await projectMemoryTool({ action: 'job_sources', project_id: projectId,
        job_id: queued.job_id, offset, page_limit: 500 }, service);
      expect(page.isError).not.toBe(true);
      const data = page.structuredContent?.job as Awaited<ReturnType<ResearchService['jobSources']>>;
      expect(data.total).toBe(2899);
      expect(data.source_ids.length).toBeLessThanOrEqual(500);
      collected.push(...data.source_ids);
      if (data.next_offset !== undefined) expect(data.next_offset).toBeGreaterThan(offset);
      offset = data.next_offset;
      pageCount++;
      expect(pageCount).toBeLessThanOrEqual(6);
    }
    expect(pageCount).toBe(6);
    expect(collected).toEqual(sourceIds);
    const cancelled = await service.cancelJob(projectId, queued.job_id, 'fixture complete');
    const waited = await service.waitForJob(projectId, queued.job_id, cancelled.revision, 0);
    for (const view of [cancelled, waited.job]) {
      expect(view.status).toBe('cancelled');
      expect(view.affected_source_count).toBe(2899);
      expect(view).not.toHaveProperty('affected_source_ids');
      expect(view).not.toHaveProperty('request');
      expect(JSON.stringify(view).length).toBeLessThan(5000);
    }
    const raw = await service['store'].getKnowledgeJob(queued.job_id);
    expect(raw?.affected_source_ids).toEqual(sourceIds);
    expect(raw?.request).toEqual(request);
  });

  it('returns an async rebuild job then records failure and a resumable trace for an invalid root', async () => {
    const missingRoot = join(root, 'missing-source-root');
    const started = await projectMemoryTool({ action: 'rebuild', project_id: projectId,
      roots: [{ label: 'missing', path: missingRoot }], root_mode: 'replace' }, service);
    expect(started.isError).not.toBe(true);
    const job = started.structuredContent?.job as Awaited<ReturnType<ResearchService['startProjectOperation']>>;
    expect(job).toMatchObject({ kind: 'source_sync', status: 'queued', affected_source_count: 0 });
    expect(job).not.toHaveProperty('request');
    await service.waitForIdle();
    const failed = await service.jobStatus(projectId, job.job_id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('missing-source-root');
    const traceId = failed.failures?.at(-1)?.trace_id;
    expect(traceId).toMatch(/^[a-f0-9-]{36}$/);
    const trace = JSON.parse(await readFile(join(root, 'job-errors', `${traceId}.json`), 'utf8'));
    expect(trace).toMatchObject({ job_id: job.job_id, message: failed.error });
    expect(trace.stack).toBeTruthy();
    const resumed = await service.resumeJob(projectId, job.job_id);
    expect(resumed.job_id).toBe(job.job_id);
    expect(resumed).not.toHaveProperty('request');
    await service.waitForIdle();
    const retried = await service.jobStatus(projectId, job.job_id);
    expect(retried.status).toBe('failed');
    expect(retried.attempts).toBe(failed.attempts + 1);
    expect(retried.failures?.at(-1)?.trace_id).not.toBe(traceId);
    expect(retried.failures?.some(failure => failure.trace_id === traceId)).toBe(true);
  });

  it('previews JSONL without writes, applies it, and replays identical records with stable IDs', async () => {
    const entries = [
      { type: 'catalog', record: { kind: 'document', operation: 'create', asset_id: 'import-doc-a',
        idempotency_key: 'import-doc-a-v1', body: 'Synthetic NFL import source A.' } },
      { type: 'ontology', record: { kind: 'relation', name: 'fixture_capacity',
        definition: 'Synthetic import capacity.', idempotency_key: 'import-relation-v1' } },
      { type: 'catalog', record: { kind: 'document', operation: 'create', asset_id: 'import-doc-b',
        idempotency_key: 'import-doc-b-v1', body: 'Synthetic NFL import source B.' } },
    ];
    const bytes = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    const path = join(root, 'records.jsonl');
    await writeFile(path, bytes);
    const preview = await service.importRecords({ project_id: projectId, path });
    expect(preview.preview).toMatchObject({ valid: 3, invalid: 0,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(preview).not.toHaveProperty('job');
    await expect(service.getCatalogRecord(projectId, 'import-doc-a')).rejects.toThrow('record not found');
    const applied = await service.importRecords({ project_id: projectId, path, dry_run: false });
    expect(applied.job?.kind).toBe('bulk_import');
    await service.waitForIdle();
    const done = await service.jobStatus(projectId, applied.job!.job_id);
    expect(done).toMatchObject({ status: 'done', result_counts: { committed: 3, failed: 0 } });
    const readReceipts = async (id: string) => (await readFile(join(root, 'job-imports', `${id}.jsonl`), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    const original = await readReceipts(applied.job!.job_id);
    expect(original).toHaveLength(3);
    expect(original.every(row => row.status === 'committed' && row.record_id)).toBe(true);
    const repeated = await service.importRecords({ project_id: projectId, path, dry_run: false });
    await service.waitForIdle();
    expect((await service.jobStatus(projectId, repeated.job!.job_id)).status).toBe('done');
    expect((await readReceipts(repeated.job!.job_id)).map(row => row.record_id)).toEqual(original.map(row => row.record_id));
    const copyPath = join(root, 'same-records-other-path.jsonl');
    await writeFile(copyPath, bytes);
    const replayed = await service.importRecords({ project_id: projectId, path: copyPath, dry_run: false });
    await service.waitForIdle();
    expect((await service.jobStatus(projectId, replayed.job!.job_id)).status).toBe('done');
    expect((await readReceipts(replayed.job!.job_id)).map(row => row.record_id)).toEqual(original.map(row => row.record_id));
    expect((await catalog('import-doc-a')).revision.revision).toBe(1);
    expect((await catalog('import-doc-b')).revision.revision).toBe(1);
  });

  it('rejects a changed JSONL resume hash before writes and resumes after original bytes are restored', async () => {
    const path = join(root, 'hash-guard.jsonl');
    const bytes = JSON.stringify({ type: 'catalog', record: { kind: 'document', operation: 'create',
      asset_id: 'hash-guard-document', idempotency_key: 'hash-guard-document-v1', body: 'Original immutable import bytes.' } }) + '\n';
    await writeFile(path, bytes);
    const { preview } = await service.importRecords({ project_id: projectId, path });
    await writeFile(path, bytes + '\n');
    const job = await service.startProjectOperation(projectId, { operation: 'import', path,
      sha256: preview.sha256, total: preview.valid, allow_partial: false });
    await service.waitForIdle();
    const failed = await service.jobStatus(projectId, job.job_id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('import file changed');
    await expect(service.getCatalogRecord(projectId, 'hash-guard-document')).rejects.toThrow('record not found');
    await writeFile(path, bytes);
    const resumed = await service.resumeJob(projectId, job.job_id);
    expect(resumed.job_id).toBe(job.job_id);
    await service.waitForIdle();
    expect((await service.jobStatus(projectId, job.job_id)).status).toBe('done');
    expect((await catalog('hash-guard-document')).body).toBe('Original immutable import bytes.');
  });

  it('requires partial-import opt-in and preserves valid rows after a malformed middle entry', async () => {
    const path = join(root, 'partial-import.jsonl');
    const entry = (suffix: string) => ({ type: 'catalog', record: { kind: 'document', operation: 'create',
      asset_id: `partial-import-${suffix}`, idempotency_key: `partial-import-${suffix}-v1`, body: `Synthetic ${suffix}.` } });
    await writeFile(path, [entry('before'), { type: 'catalog', record: { kind: 'document', operation: 'create', idempotency_key: '' } },
      entry('after')].map(row => JSON.stringify(row)).join('\n') + '\n');
    const preview = await service.importRecords({ project_id: projectId, path });
    expect(preview.preview).toMatchObject({ valid: 2, invalid: 1 });
    await expect(service.importRecords({ project_id: projectId, path, dry_run: false })).rejects.toThrow('import preflight found 1 invalid');
    await expect(service.getCatalogRecord(projectId, 'partial-import-before')).rejects.toThrow('record not found');
    const applied = await service.importRecords({ project_id: projectId, path, dry_run: false, allow_partial: true });
    await service.waitForIdle();
    const result = await service.jobStatus(projectId, applied.job!.job_id);
    expect(result).toMatchObject({ status: 'failed', result_counts: { committed: 2, failed: 1 } });
    expect((await catalog('partial-import-before')).body).toBe('Synthetic before.');
    expect((await catalog('partial-import-after')).body).toBe('Synthetic after.');
    const lines = (await readFile(join(root, 'job-imports', `${applied.job!.job_id}.jsonl`), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(row => row.status)).toEqual(['committed', 'failed', 'committed']);
  });

  it('previews and syncs only explicit whitelist files and denies an unlisted incremental path', async () => {
    const files = join(root, 'whitelist');
    await mkdir(files);
    const allowed = 'ALLOWLISTED_SOURCE_SENTINEL\n';
    await writeFile(join(files, 'allowed.txt'), allowed);
    await writeFile(join(files, 'unlisted.txt'), 'UNLISTED_SOURCE_SENTINEL\n');
    const roots = [{ label: 'fixture', path: files, role: 'source' as const, include_paths: ['allowed.txt'] }];
    const preview = await projectMemoryTool({ action: 'sync', project_id: projectId, roots, dry_run: true }, service);
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent?.index).toMatchObject({ files: 1, bytes: Buffer.byteLength(allowed),
      explicit_whitelist: true, parsed: false, stored: false, errors: [] });
    expect(await service['store'].listProjectSourceEntries(projectId)).toHaveLength(0);
    const applied = await projectMemoryTool({ action: 'sync', project_id: projectId, roots, root_mode: 'replace' }, service);
    expect(applied.isError).not.toBe(true);
    const job = applied.structuredContent?.job as Awaited<ReturnType<ResearchService['startProjectOperation']>>;
    await service.waitForIdle();
    expect((await service.jobStatus(projectId, job.job_id)).status).toBe('done');
    const entries = await service['store'].listProjectSourceEntries(projectId);
    expect(entries.map(row => row.path)).toEqual(['allowed.txt']);
    await expect(service.indexProject({ project_id: projectId, changed_paths: [{ root: 'fixture', path: 'unlisted.txt' }] }))
      .rejects.toThrow('include_paths whitelist');
    await expect(service.previewProjectImport([{ ...roots[0], include_paths: ['../outside.txt'] }]))
      .rejects.toThrow('exact files inside root');
  });

  it('checkpoints a 101-file whitelist and retains the latest source-index child job', async () => {
    const files = join(root, 'chunked-whitelist');
    await mkdir(files);
    const paths = Array.from({ length: 101 }, (_, index) => `source-${String(index).padStart(3, '0')}.txt`);
    for (const [index, path] of paths.entries()) await writeFile(join(files, path), `SMALL_SOURCE_${index}\n`);
    const updates = vi.spyOn(service['store'], 'putKnowledgeJob');
    try {
      const parent = await service.startProjectOperation(projectId, { operation: 'sync',
        roots: [{ label: 'chunked', path: files, role: 'source', include_paths: paths }], root_mode: 'merge' });
      await service.waitForIdle();
      const done = await service.jobStatus(projectId, parent.job_id);
      expect(done).toMatchObject({ status: 'done', stage: 'stored', completed_items: 101, total_items: 101 });
      const checkpoints = updates.mock.calls.map(([job]) => job).filter(job => job.job_id === parent.job_id);
      expect(checkpoints.some(job => job.request?.source_offset === 100)).toBe(true);
      expect(checkpoints.some(job => job.request?.source_offset === 101)).toBe(true);
      const raw = await service['store'].getKnowledgeJob(parent.job_id);
      expect(raw?.request?.source_offset).toBe(101);
      expect(done.child_job_ids).toHaveLength(1);
      const child = await service.jobStatus(projectId, done.child_job_ids![0]);
      const project = (await service.getProject(projectId)).project;
      expect(child.source_hash).toBe(project.active_source_snapshot_id);
      expect(child.status).toBe('done');
      const entries = await service['store'].listProjectSourceEntries(projectId);
      expect(entries.map(entry => entry.path).sort()).toEqual(paths);
    } finally { updates.mockRestore(); }
  }, 30000);

  it('hydrates exact catalog hits with their actual kind, record ID, and revision ID', async () => {
    const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement', operation: 'create',
      asset_id: 'exact-nfl-measurement', idempotency_key: 'exact-nfl-measurement-v1',
      fields: { ...nbaFields, model_id: 'fixture-model-101', sport: 'NFL', namespace: 'sports:nfl' } });
    await service.waitForIdle();
    const raw = await service['store'].searchProjectExact(projectId, 'exact-nfl-measurement', 5);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ kind: 'measurement', record_id: receipt.record_id, revision_id: receipt.revision_id });
    const searched = await service.searchBatch(projectId, 'exact-nfl-measurement', [], 1, [], undefined,
      { kinds: ['measurement'], sports: ['NFL'], retrieval_lanes: ['exact'] });
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0]).toMatchObject({ kind: 'measurement', record_id: receipt.record_id });
  });

  it('continues catalog indexing after a missing middle row and preserves partial counts and lexical hits', async () => {
    const deferred = vi.spyOn(service as unknown as {
      scheduleCatalogIndex(job: KnowledgeJobRecord): void;
    }, 'scheduleCatalogIndex').mockImplementation(() => {});
    let before: Awaited<ReturnType<ResearchService['writeCatalogRecord']>>;
    let after: Awaited<ReturnType<ResearchService['writeCatalogRecord']>>;
    try {
      before = await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
        asset_id: 'catalog-before', idempotency_key: 'catalog-before-v1',
        fields: { title: 'Before missing row' }, body: 'beforemarker evidence is preserved.' });
      after = await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
        asset_id: 'catalog-after', idempotency_key: 'catalog-after-v1',
        fields: { title: 'After missing row' }, body: 'aftermarker evidence is preserved.' });
    } finally { deferred.mockRestore(); }
    expect(await service['store'].listProjectDocuments(projectId)).toHaveLength(0);
    const missing = 'catalog-missing-middle';
    const job = await service.queueKnowledgeJob({ project_id: projectId, kind: 'retrieval_index',
      source_hash: 'catalog-missing-middle-v1', schema_version: 'catalog-record-v1', algorithm_version: 'fixture-v1',
      affected_source_ids: [before!.record_id, missing, after!.record_id] });
    service['scheduleCatalogIndex'](job);
    await service.waitForIdle();
    const failed = await service.jobStatus(projectId, job.job_id);
    expect(failed).toMatchObject({ status: 'failed', stage: 'lexical_partial', completed_items: 3, total_items: 3,
      result_counts: { indexed: 2, failed: 1 } });
    const failure = failed.failures?.at(-1);
    expect(failure?.source_id).toBe(missing);
    expect(failure?.trace_id).toMatch(/^[a-f0-9-]{36}$/);
    const trace = JSON.parse(await readFile(join(root, 'job-errors', `${failure!.trace_id}.json`), 'utf8'));
    expect(trace).toMatchObject({ job_id: job.job_id, source_id: missing, message: 'catalog record not found' });
    expect(await service['store'].listProjectDocuments(projectId)).toHaveLength(2);
    for (const [query, id] of [['beforemarker', before!.record_id], ['aftermarker', after!.record_id]]) {
      const result = await service.searchBatch(projectId, query, [], 5, [], undefined, { retrieval_lanes: ['bm25'] });
      expect(result.results.some(hit => hit.record_id === id), `${query} must remain lexically available`).toBe(true);
    }
  });

  it('returns a committed receipt with a resumable warning when post-commit scheduling fails', async () => {
    await service.materializeGraph([projectId]);
    expect((await service['store'].currentGraph(projectId)).current).toBe(true);
    const effects = vi.spyOn(service as unknown as {
      invalidateGraph(project: string, schedule?: boolean): Promise<void>;
    }, 'invalidateGraph').mockRejectedValueOnce(new Error('synthetic post-commit scheduling failure'));
    let receipt: Awaited<ReturnType<ResearchService['writeCatalogRecord']>>;
    try {
      receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
        asset_id: 'committed-with-warning', idempotency_key: 'committed-with-warning-v1', body: 'Durable synthetic evidence.' });
    } finally { effects.mockRestore(); }
    expect(receipt!.durability).toBe('committed');
    expect(receipt!.post_commit_warning).toMatchObject({ stage: 'index_scheduling', retry_action: 'job_resume' });
    expect(receipt!.post_commit_warning?.message).toContain('synthetic post-commit');
    expect((await catalog(receipt!.record_id)).body).toBe('Durable synthetic evidence.');
    expect((await service['store'].currentGraph(projectId)).current).toBe(false);
    const resumed = await service.resumeJob(projectId, receipt!.index_job_id!);
    expect(resumed.job_id).toBe(receipt!.index_job_id);
    await service.waitForIdle();
    expect((await service.jobStatus(projectId, resumed.job_id)).status).toBe('done');
  });

  it('preserves relocation history and rejects changed conditions, content, and artifact hashes', async () => {
    const originalPath = join(root, 'original-source.txt');
    const movedPath = join(root, 'moved-source.txt');
    const body = 'Original tiny NBA source bytes.\n';
    const digest = createHash('sha256').update(body).digest('hex');
    await writeFile(originalPath, body);
    await writeFile(movedPath, body);
    const first = await service.writeCatalogRecord({ project_id: projectId, kind: 'measurement', operation: 'create',
      asset_id: 'history-measurement', idempotency_key: 'history-measurement-v1',
      fields: { ...nbaFields, source_locator: originalPath }, artifact_references: [{ artifact_id: 'nba-source',
        location: originalPath, content_hash: digest, size: Buffer.byteLength(body), verification: 'declared' }] });
    const input = { project_id: projectId, kind: 'measurement' as const, operation: 'relocate' as const,
      asset_id: first.record_id, expected_revision: first.revision, idempotency_key: 'history-measurement-v2',
      fields: { source_locator: movedPath }, artifact_references: [{ artifact_id: 'nba-source', location: movedPath,
        content_hash: digest, size: Buffer.byteLength(body), verification: 'declared' as const }] };
    const moved = await service.writeCatalogRecord(input);
    const old = await service.getCatalogRecord(projectId, first.record_id, first.revision);
    if ('legacy' in old || 'source' in old) throw new Error('Expected old catalog revision');
    const current = await catalog(first.record_id);
    expect(old.revision.fields.source_locator).toBe(originalPath);
    expect(old.revision.artifact_references[0].location).toBe(originalPath);
    expect(current.revision.artifact_references[0].location).toBe(movedPath);
    expect(current.revision.fields.comparison_contract_id).toBe(old.revision.fields.comparison_contract_id);
    await expect(service.writeCatalogRecord({ ...input, expected_revision: moved.revision,
      idempotency_key: 'bad-condition-relocation', fields: { value: 0.99 } })).rejects.toThrow('not evaluation conditions');
    await expect(service.writeCatalogRecord({ ...input, expected_revision: moved.revision,
      idempotency_key: 'bad-body-relocation', body: 'Changed record content' })).rejects.toThrow('cannot replace record content');
    await expect(service.writeCatalogRecord({ ...input, expected_revision: moved.revision,
      idempotency_key: 'bad-hash-relocation', artifact_references: [{ ...input.artifact_references[0],
        content_hash: 'f'.repeat(64) }] })).rejects.toThrow('cannot change artifact content_hash');
    expect((await catalog(first.record_id)).revision.revision).toBe(moved.revision);
    expect((await service.verifyCatalogRecord(projectId, first.record_id, 'hash_verified')).complete).toBe(true);
    await writeFile(movedPath, 'Tampered synthetic bytes.');
    expect((await service.verifyCatalogRecord(projectId, first.record_id, 'hash_verified')).complete).toBe(false);
  });

  it('returns ready BM25 evidence at a 50ms vector budget and waits for late work before close', async () => {
    const receipt = await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
      asset_id: 'slow-vector-control', idempotency_key: 'slow-vector-control-v1',
      body: 'overtime has ready synthetic BM25 evidence.', fields: { title: 'Ready overtime evidence' } });
    await service.waitForIdle();
    let modelFinished = false;
    const enabled = vi.spyOn(service['embeddings'], 'enabled').mockReturnValue(true);
    const delayed = vi.spyOn(service['embeddings'], 'embedQueries').mockImplementation(async queries => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
      modelFinished = true;
      return queries.map(() => Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0));
    });
    let closing: Promise<void> | undefined;
    try {
      const result = await service.searchBatch(projectId, 'overtime', [], 5, [], undefined,
        { retrieval_lanes: ['bm25', 'vector'], lane_budget_ms: { vector: 50 } }, false);
      expect(result.partial).toBe(true);
      expect(result.degraded_lanes).toContain('vector');
      expect(result.results.some(hit => hit.title === 'Ready overtime evidence')).toBe(true);
      expect(modelFinished).toBe(false);
      expect(delayed).toHaveBeenCalled();
      expect((await catalog(receipt.record_id)).body).toBe('overtime has ready synthetic BM25 evidence.');
      const returned = result.results.map(hit => hit.document_id);
      let closed = false;
      closing = service.close().then(() => { closed = true; });
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
      expect(closed).toBe(false);
      await closing;
      expect(modelFinished).toBe(true);
      expect(result.results.map(hit => hit.document_id)).toEqual(returned);
    } finally {
      if (closing) await closing;
      else await service.waitForIdle();
      delayed.mockRestore();
      enabled.mockRestore();
    }
  });

  it.each([
    ['sport', { sports: ['NFL'] }],
    ['namespace', { namespaces: ['sports:nfl'] }],
    ['sport and namespace', { sports: ['NFL'], namespaces: ['sports:nfl'] }],
  ] as const)('applies %s scope before limit-one lexical and graph ranking', async (_name, scope) => {
    const query = 'OVERTIME_SCOPE_7';
    await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
      asset_id: 'scoped-lol', idempotency_key: 'scoped-lol-v1', body: `${query} `.repeat(30),
      fields: { title: query, sport: 'LoL', namespace: 'sports:lol' } });
    await service.writeCatalogRecord({ project_id: projectId, kind: 'document', operation: 'create',
      asset_id: 'scoped-nfl', idempotency_key: 'scoped-nfl-v1', body: `${query} valid football evidence.`,
      fields: { title: `NFL ${query}`, sport: 'NFL', namespace: 'sports:nfl' } });
    await service.waitForIdle();
    expect(await service['store'].listProjectDocuments(projectId)).toHaveLength(2);
    const selected = await service['store'].retrievalScope(projectId, { ...scope, kinds: ['document'] });
    expect(selected.document_ids, `${_name} scope must select exactly the NFL document before ranking`).toHaveLength(1);
    for (const lane of ['bm25', 'exact', 'graph'] as const) {
      const result = await service.searchBatch(projectId, query, [], 1, [], undefined,
        { ...scope, retrieval_lanes: [lane], kinds: ['document'] });
      expect(result.results, `${_name} ${lane} scope returned no matching NFL evidence`).toHaveLength(1);
      expect(result.results[0].title, `${_name} ${lane} scope leaked LoL evidence`).toBe(`NFL ${query}`);
    }
  });

  it('reports 43 committed and 5 invalid rows as partial and replays the same durable IDs', async () => {
    const invalid = new Set([8, 18, 28, 38, 47]);
    const records = Array.from({ length: 48 }, (_, index) => ({
      kind: 'document' as const, operation: 'create' as const,
      idempotency_key: invalid.has(index) ? ' ' : `bulk-row-${index}-v1`,
      body: `Synthetic NBA evidence row ${index}.`, fields: { title: `NBA evidence ${index}` },
    }));
    const input = { action: 'record_batch' as const, project_id: projectId, records };
    const first = await projectMemoryTool(input, service);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ committed: 43, replayed: 0, failed: 5, partial: true });
    expect(first.structuredContent?.memory).toContain('Status: partial');
    const firstRows = first.structuredContent?.results as Array<{
      index: number;
      status: 'committed' | 'replayed' | 'failed';
      idempotency_key: string;
      receipt?: { record_id: string; revision: number; operation_id: string; request_hash: string; idempotent_replay?: boolean };
      error?: string;
    }>;
    expect(firstRows).toHaveLength(48);
    expect(firstRows.filter(row => row.error).map(row => row.index)).toEqual([...invalid]);
    for (const row of firstRows) {
      expect(row.idempotency_key).toBe(records[row.index].idempotency_key);
      if (invalid.has(row.index)) {
        expect(row.status).toBe('failed');
        expect(row.error).toContain('idempotency_key required');
      } else {
        expect(row.status).toBe('committed');
        expect(row.receipt).toMatchObject({ revision: 1 });
      }
    }
    const successful = firstRows.filter(row => row.receipt);
    const ids = successful.map(row => row.receipt!.record_id);
    expect(new Set(ids).size).toBe(43);
    const readback = await service.getCatalogRecords(projectId, ids);
    expect(readback).toHaveLength(43);
    for (let index = 0; index < readback.length; index++) {
      expect(readback[index].error).toBeUndefined();
      expect(readback[index].record?.body).toBe(records[successful[index].index].body);
    }

    await service.waitForIdle();
    const beforeReplayDirty = (await service['store'].getProject(projectId))?.graph_dirty_at;
    const replay = await projectMemoryTool(input, service);
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ committed: 43, replayed: 43, failed: 5, partial: true });
    const replayRows = replay.structuredContent?.results as typeof firstRows;
    expect(replayRows).toHaveLength(48);
    for (const row of successful) {
      const repeated = replayRows[row.index].receipt;
      expect(replayRows[row.index].status).toBe('replayed');
      expect(replayRows[row.index].idempotency_key).toBe(records[row.index].idempotency_key);
      expect(repeated).toMatchObject({ record_id: row.receipt!.record_id, revision: row.receipt!.revision,
        operation_id: row.receipt!.operation_id, request_hash: row.receipt!.request_hash, idempotent_replay: true });
    }
    for (const index of invalid) expect(replayRows[index]).toMatchObject({ status: 'failed', idempotency_key: ' ' });
    expect(replayRows.filter(row => row.error).map(row => row.index)).toEqual([...invalid]);
    expect(new Set(replayRows.filter(row => row.receipt).map(row => row.receipt!.record_id))).toEqual(new Set(ids));
    await service.waitForIdle();
    expect((await service['store'].getProject(projectId))?.graph_dirty_at).toBe(beforeReplayDirty);
  });
});

describe('bulk graph reliability', () => {
  it('counts an 11k-node chain and its closing cycle without recursive stack growth', () => {
    const graph = new MultiDirectedGraph();
    for (let index = 0; index < 11000; index++) graph.addNode(String(index));
    for (let index = 0; index < 10999; index++) graph.addDirectedEdge(String(index), String(index + 1));
    expect(stronglyConnectedCount(graph)).toBe(11000);
    graph.addDirectedEdge('10999', '0');
    expect(stronglyConnectedCount(graph)).toBe(1);
  });

  it('matches the reference SCC count for mixed cycles, parallel edges, and isolated nodes', () => {
    const graph = new MultiDirectedGraph();
    expect(stronglyConnectedCount(graph)).toBe(0);
    for (let index = 0; index < 9; index++) graph.addNode(String(index));
    for (const [from, to] of [['0', '1'], ['1', '2'], ['2', '0'], ['0', '1'],
      ['3', '4'], ['4', '3'], ['5', '5'], ['6', '7']]) graph.addDirectedEdge(from, to);
    expect(stronglyConnectedCount(graph)).toBe(stronglyConnectedComponents(graph).length);
    expect(stronglyConnectedCount(graph)).toBe(6);
  });
});

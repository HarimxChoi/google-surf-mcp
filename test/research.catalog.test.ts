import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';

describe('durable research catalog', () => {
  let root: string | undefined;
  let service: ResearchService | undefined;

  afterEach(async () => {
    await service?.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it('round-trips full bodies, manifests, revisions, aliases, and idempotency after restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Catalog', 'catalog');
    const body = `  first line\n${'long evidence line\n'.repeat(5_000)}끝  `;
    const artifacts = Array.from({ length: 300 }, (_, index) => ({
      artifact_id: `artifact-${index}`,
      path: `results/member-${index}.json`,
      verification: 'declared' as const,
    }));
    const created = await service.writeCatalogRecord({
      project_id: 'catalog',
      kind: 'experiment',
      operation: 'create',
      asset_id: 'run-r0215',
      expected_revision: 0,
      idempotency_key: 'create-r0215',
      body,
      fields: { title: 'Qwen r0215', status: 'success' },
      artifact_references: artifacts,
      aliases: ['r0215'],
      protected: true,
      effective_at: '2026-09-01T00:00:00.000Z',
      source_sequence: 12,
    });

    expect(created).toMatchObject({
      durability: 'committed',
      changed: true,
      revision: 1,
      artifact_references_received: 300,
      artifact_references_stored: 300,
      body_bytes_received: Buffer.byteLength(body),
      body_bytes_stored: Buffer.byteLength(body),
      truncated: false,
      index_state: 'queued',
    });
    expect(created.index_job_id).toBeTruthy();

    await service.waitForIdle();

    let offset = 0;
    let restored = '';
    for (;;) {
      const page = await service.getCatalogRecord('catalog', 'r0215', undefined, offset, 4_001, 0, 200);
      expect('legacy' in page).toBe(false);
      if ('legacy' in page) throw new Error('unexpected legacy record');
      restored += page.body ?? '';
      if (page.next_body_offset === undefined) {
        expect(page.revision.artifact_references).toHaveLength(200);
        expect(page.next_artifact_offset).toBe(200);
        break;
      }
      offset = page.next_body_offset;
    }
    expect(Buffer.from(restored)).toEqual(Buffer.from(body));
    const artifactTail = await service.getCatalogRecord('catalog', 'r0215', undefined, 0, 1, 200, 200);
    if ('legacy' in artifactTail) throw new Error('unexpected legacy record');
    expect(artifactTail.revision.artifact_references).toHaveLength(100);
    expect(artifactTail.next_artifact_offset).toBeUndefined();
    const artifactHead = await service.getCatalogRecord('catalog', 'r0215');
    if ('legacy' in artifactHead) throw new Error('unexpected legacy record');
    expect(new Set([
      ...artifactHead.revision.artifact_references,
      ...artifactTail.revision.artifact_references,
    ].map((reference) => reference.artifact_id)).size).toBe(300);

    const replayed = await service.writeCatalogRecord({
      project_id: 'catalog', kind: 'experiment', operation: 'create', asset_id: 'run-r0215',
      expected_revision: 0, idempotency_key: 'create-r0215', body,
      fields: { title: 'Qwen r0215', status: 'success' },
      artifact_references: artifacts, aliases: ['r0215'], protected: true,
      effective_at: '2026-09-01T00:00:00.000Z', source_sequence: 12,
    });
    expect(replayed).toMatchObject({
      record_id: created.record_id,
      revision: created.revision,
      operation_id: created.operation_id,
      request_hash: created.request_hash,
      changed: created.changed,
      index_state: 'current',
    });

    await expect(service.writeCatalogRecord({
      project_id: 'catalog', kind: 'experiment', operation: 'create', asset_id: 'run-r0215',
      idempotency_key: 'create-r0215', body: 'different',
    })).rejects.toThrow('idempotency key conflict');

    const duplicate = await service.writeCatalogRecord({
      project_id: 'catalog', kind: 'experiment', operation: 'create', asset_id: 'run-r0215',
      idempotency_key: 'same-content-new-key', body,
      fields: { title: 'Qwen r0215', status: 'success' },
      artifact_references: artifacts, aliases: ['r0215'], protected: true,
      effective_at: '2026-09-01T00:00:00.000Z', source_sequence: 12,
    });
    expect(duplicate).toMatchObject({ changed: false, revision: 1, index_state: 'current' });

    const patched = await service.writeCatalogRecord({
      project_id: 'catalog', kind: 'experiment', operation: 'patch', asset_id: 'run-r0215',
      expected_revision: 1, idempotency_key: 'patch-r0215', fields: { interpretation: 'verified' },
      evidence_ids: ['evidence-1'],
    });
    expect(patched).toMatchObject({ changed: true, revision: 2, previous_revision: 1 });
    await expect(service.writeCatalogRecord({
      project_id: 'catalog', kind: 'experiment', operation: 'patch', asset_id: 'run-r0215',
      expected_revision: 1, idempotency_key: 'stale-r0215', fields: { stale: true },
    })).rejects.toThrow('revision conflict');

    const old = await service.getCatalogRecord('catalog', 'run-r0215', 1);
    const current = await service.getCatalogRecord('catalog', 'run-r0215', 2);
    expect('legacy' in old || 'legacy' in current).toBe(false);
    if ('legacy' in old || 'legacy' in current) throw new Error('unexpected legacy record');
    expect(old.revision.fields).not.toHaveProperty('interpretation');
    expect(current.revision.fields).toMatchObject({ interpretation: 'verified' });
    expect(old.revision.artifact_manifest_id).toBeTruthy();
    expect(current.revision.artifact_manifest_id).toBe(old.revision.artifact_manifest_id);
    expect(current.revision.artifact_references).toHaveLength(200);
    expect(current.revision.artifact_reference_count).toBe(300);
    expect((await service.catalogTimeline('catalog')).events).toHaveLength(2);
  }, 60_000);

  it('streams large body attachments, indexes their tail, and verifies local artifacts', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Attachments', 'attachments');
    const body = `${'large body line\n'.repeat(80_000)}unique_attachment_tail`;
    const bodyPath = join(root, 'large-body.txt');
    await writeFile(bodyPath, body, 'utf8');
    const hash = createHash('sha256').update(body).digest('hex');
    const receipt = await service.writeCatalogRecord({
      project_id: 'attachments',
      kind: 'experiment',
      operation: 'create',
      asset_id: 'large-record',
      idempotency_key: 'large-record-v1',
      body_path: bodyPath,
      artifact_references: [{
        artifact_id: 'large-body-artifact',
        location: bodyPath,
        size: Buffer.byteLength(body),
        content_hash: hash,
      }],
    });
    expect(receipt.body_bytes_stored).toBe(Buffer.byteLength(body));
    await service.waitForIdle();

    let restored = '';
    let offset = 0;
    for (;;) {
      const page = await service.getCatalogRecord('attachments', 'large-record', undefined, offset, 65_537);
      if ('legacy' in page) throw new Error('unexpected legacy record');
      restored += page.body ?? '';
      if (page.next_body_offset === undefined) break;
      offset = page.next_body_offset;
    }
    expect(restored).toBe(body);
    expect(await service.search('attachments', 'unique_attachment_tail', 5)).toHaveLength(1);
    expect(await service.verifyCatalogRecord('attachments', 'large-record', 'hash_verified'))
      .toMatchObject({ complete: true, artifacts: [{ satisfies: true, observed_hash: hash }] });
  }, 60_000);

  it('keeps a selected current plan while reconstructing historical plan time', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Temporal', 'temporal');
    await service.writeCatalogRecord({
      project_id: 'temporal', kind: 'plan', operation: 'create', asset_id: 'plan-a',
      idempotency_key: 'plan-a-v1', body: 'First active plan', fields: { title: 'Plan A' },
      effective_at: '2026-09-01T00:00:00.000Z', set_current: true,
    });
    await service.writeCatalogRecord({
      project_id: 'temporal', kind: 'plan', operation: 'create', asset_id: 'plan-b',
      idempotency_key: 'plan-b-v1', body: 'Later historical plan', fields: { title: 'Plan B' },
      effective_at: '2026-09-02T00:00:00.000Z', set_current: false,
    });

    expect(await service.projectContext('temporal')).toMatchObject({
      active_plan: { asset_id: 'plan-a', title: 'Plan A' },
      warnings: [expect.stringContaining('plan-b:v1')],
    });
    expect(await service.projectContext('temporal', 12_000, undefined, '2026-09-03T00:00:00.000Z'))
      .toMatchObject({ active_plan: { asset_id: 'plan-b', title: 'Plan B' } });

    await service.writeCatalogRecord({
      project_id: 'temporal', kind: 'plan', operation: 'create', asset_id: 'plan-b',
      idempotency_key: 'plan-b-select', body: 'Later historical plan', fields: { title: 'Plan B' },
      effective_at: '2026-09-02T00:00:00.000Z', set_current: true,
    });
    expect(await service.projectContext('temporal')).toMatchObject({
      active_plan: { asset_id: 'plan-b', title: 'Plan B' },
    });
  });

  it('versions project profiles and separates durable intent from query intent and process liveness', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Context authority', 'context-authority');
    const first = await service.updateProjectProfile({
      project_id: 'context-authority', expected_revision: 0, idempotency_key: 'profile-v1',
      purpose: 'Preserve the durable project purpose.', user_constraints: ['Keep history'],
    });
    const replay = await service.updateProjectProfile({
      project_id: 'context-authority', expected_revision: 0, idempotency_key: 'profile-v1',
      purpose: 'Preserve the durable project purpose.', user_constraints: ['Keep history'],
    });
    const second = await service.updateProjectProfile({
      project_id: 'context-authority', expected_revision: 1, idempotency_key: 'profile-v2',
      purpose: 'Preserve purpose and compare alternatives.', protected_parent_ids: ['parent-one'],
    });
    await service.recordSessionIntent({
      project_id: 'context-authority', intent: 'Run the confirmed research plan.',
    });
    await service.ensureMemorySession('context-authority', undefined, 'temporary packaging web query');
    const plan = await service.createPlan({
      project_id: 'context-authority', title: 'Plan', body: 'Run one experiment.',
      idempotency_key: 'context-plan-v1',
    });
    const experiment = await service.startExperiment({
      project_id: 'context-authority', plan_revision_id: plan.plan_revision_id,
      name: 'Historical run', hypothesis: 'The run completes.', idempotency_key: 'context-run-start',
    });
    await service.writeCatalogRecord({
      project_id: 'context-authority', kind: 'experiment', operation: 'patch',
      asset_id: experiment.experiment_id, expected_revision: 1,
      idempotency_key: 'context-run-terminal-v1',
      fields: {
        name: experiment.name,
        hypothesis: experiment.hypothesis,
        status: 'success',
        process_liveness: 'stopped',
        process_observed_at: experiment.started_at,
      },
    });

    expect(first.receipt).toMatchObject({ revision: 1, applied_this_request: true, idempotent_replay: false });
    expect(replay.receipt).toMatchObject({
      revision: 1, operation_id: first.receipt.operation_id,
      index_job_id: first.receipt.index_job_id,
      applied_this_request: false, idempotent_replay: true,
    });
    expect(second.receipt).toMatchObject({ revision: 2, previous_revision: 1 });
    const oldProfile = await service.getCatalogRecord('context-authority', 'context-authority', 1, 0, 0);
    if ('legacy' in oldProfile || 'source' in oldProfile || 'document' in oldProfile) {
      throw new Error('unexpected project profile type');
    }
    expect(oldProfile.revision.fields).toMatchObject({ purpose: 'Preserve the durable project purpose.' });
    expect((await service.catalogTimeline('context-authority')).events
      .filter((event) => event.kind === 'project')).toHaveLength(2);
    const context = await service.projectContext('context-authority');
    expect(context).toMatchObject({
      project: {
        purpose: 'Preserve purpose and compare alternatives.',
        protected_parent_ids: ['parent-one'],
      },
      project_intent: { intent: 'Preserve purpose and compare alternatives.', source: 'project_profile' },
      session_intent: { intent: 'Run the confirmed research plan.', status: 'confirmed' },
      current_intent: { intent: 'Run the confirmed research plan.', status: 'confirmed' },
      recent_query_intent: { intent: 'temporary packaging web query', status: 'provisional' },
      active_work: [],
      work_history: [expect.objectContaining({
        experiment_id: experiment.experiment_id,
        historical_status: 'running',
        latest_scientific_state: 'success',
        process_liveness: 'stopped',
        schedulable: false,
      })],
    });
  });

  it('bounds legacy exact reads and supports metadata-only paging', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Legacy paging', 'legacy-paging');
    const term = await service.recordOntologyTerm({
      project_id: 'legacy-paging', kind: 'entity_type',
      name: 'Long legacy ontology term', aliases: Array.from({ length: 30 }, (_, index) => `alias-${index}`),
    });
    const metadata = await service.getCatalogRecord('legacy-paging', term.term_id, undefined, 0, 0);
    expect(metadata).toMatchObject({
      legacy: true,
      record_type: 'ontology',
      record_id: term.term_id,
      body_span: { start: 0, end: 0, total_bytes: expect.any(Number) },
      omitted_fields: ['record', 'body'],
    });
    expect('body' in metadata).toBe(false);
    const complete = await service.getCatalogRecord('legacy-paging', term.term_id);
    expect(complete).toMatchObject({ legacy: true, record: { term_id: term.term_id }, omitted_fields: [] });
    expect('body' in complete).toBe(false);
    const firstPage = await service.getCatalogRecord('legacy-paging', term.term_id, undefined, 0, 40);
    expect(firstPage).toMatchObject({ legacy: true, body_span: { start: 0, total_bytes: expect.any(Number) } });
    if (!('legacy' in firstPage)) throw new Error('expected legacy readback');
    expect(firstPage.body?.length).toBeGreaterThan(0);
    expect(firstPage.next_body_offset).toBeGreaterThan(0);
  });

  it('exports revision history and rolls back current state without deleting later records', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Rollback', 'rollback');
    await service.writeCatalogRecord({
      project_id: 'rollback', kind: 'plan', operation: 'create', asset_id: 'main-plan',
      idempotency_key: 'plan-v1', body: 'Original plan', fields: { title: 'Original' },
      set_current: true,
    });
    await service.recordSessionIntent({
      project_id: 'rollback', intent: 'Preserve exact research history',
    });
    await service.updateProjectContext({
      project_id: 'rollback', protected_parent_ids: ['successful-parent'],
    });
    await service.writeCatalogRecord({
      project_id: 'rollback', kind: 'task', operation: 'create', asset_id: 'successful-parent',
      idempotency_key: 'successful-parent-v1', fields: { title: 'Successful parent' },
      protected: true,
      artifact_references: [{
        artifact_id: 'remote-checkpoint', location: 'gdrive:warpquant/parent.tar',
        available: false, verification: 'hash_verified', role: 'successful_parent',
      }],
    });
    await service.writeCatalogRecord({
      project_id: 'rollback', kind: 'attempt', operation: 'create', asset_id: 'ablation-attempt',
      idempotency_key: 'ablation-attempt-v1',
      fields: {
        title: 'Recovery ablation', task_id: 'successful-parent', parent_ids: ['successful-parent'],
      },
    });
    const snapshot = await service.exportCatalogSnapshot('rollback');
    await service.writeCatalogRecord({
      project_id: 'rollback', kind: 'plan', operation: 'patch', asset_id: 'main-plan',
      expected_revision: 1, idempotency_key: 'plan-v2', body: 'Changed plan',
      fields: { title: 'Changed' }, set_current: true,
    });
    await service.writeCatalogRecord({
      project_id: 'rollback', kind: 'experiment', operation: 'create', asset_id: 'post-snapshot-run',
      idempotency_key: 'post-snapshot-run-v1', fields: { status: 'running', title: 'Later run' },
    });
    const before = await service.getProject('rollback');
    const preview = await service.importCatalogSnapshot({
      project_id: 'rollback', path: snapshot.path, expected_generation: before.catalog_generation,
      rollback: true,
    });
    expect(preview).toMatchObject({ dry_run: true, mode: 'rollback', current_records: 4 });
    const applied = await service.importCatalogSnapshot({
      project_id: 'rollback', path: snapshot.path, expected_generation: before.catalog_generation,
      rollback: true, dry_run: false,
    });
    expect(applied).toMatchObject({
      dry_run: false, mode: 'rollback', preserved_post_snapshot_assets: true,
    });
    const currentPlan = await service.getCatalogRecord('rollback', 'main-plan');
    if ('legacy' in currentPlan) throw new Error('unexpected legacy plan');
    expect(currentPlan.body).toBe('Original plan');
    expect(currentPlan.revision.revision).toBe(3);
    const changedPlan = await service.getCatalogRecord('rollback', 'main-plan', 2);
    if ('legacy' in changedPlan) throw new Error('unexpected legacy plan');
    expect(changedPlan.body).toBe('Changed plan');
    expect(await service.getCatalogRecord('rollback', 'post-snapshot-run')).toBeTruthy();
    const parent = await service.getCatalogRecord('rollback', 'successful-parent');
    const ablation = await service.getCatalogRecord('rollback', 'ablation-attempt');
    if ('legacy' in parent || 'source' in parent || 'document' in parent
      || 'legacy' in ablation || 'source' in ablation || 'document' in ablation) {
      throw new Error('unexpected record type');
    }
    expect(parent.asset.protected).toBe(true);
    expect(parent.revision.artifact_references).toEqual([
      expect.objectContaining({ artifact_id: 'remote-checkpoint', available: false }),
    ]);
    expect(ablation.revision.fields).toMatchObject({
      task_id: 'successful-parent', parent_ids: ['successful-parent'],
    });
    expect(await service.verifyCatalogRecord('rollback', 'successful-parent', 'hash_verified'))
      .toMatchObject({
        complete: true,
        artifacts: [{ payload_state: 'remote_unavailable', verification_source: 'existing_receipt' }],
      });
    const projection = await service.exportGraphProjection(['rollback']);
    expect(projection.edges.some((edge) => edge.type === 'IMPLEMENTS_TASK')).toBe(true);
    expect(projection.edges.some((edge) => edge.type === 'DERIVED_FROM_PARENT')).toBe(true);
    expect(projection.edges.some((edge) => edge.type === 'REFERENCES_ARTIFACT_MANIFEST'
      && edge.qualifiers?.reference_count === 1)).toBe(true);

    const view = await service.materializeCurrentView('rollback');
    const currentMarkdown = await readFile(view.path, 'utf8');
    expect(currentMarkdown).toContain('Preserve exact research history');
    expect(currentMarkdown).toContain('Original plan');
    expect(currentMarkdown).not.toContain('Changed plan');
  }, 60_000);

  it('records cancellation and stops terminal job transitions', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Jobs', 'jobs');
    let job = await service.queueKnowledgeJob({
      project_id: 'jobs',
      kind: 'retrieval_index',
      source_hash: 'source-v1',
      schema_version: 'schema-v1',
      algorithm_version: 'algorithm-v1',
    });
    job = await service.transitionKnowledgeJob({
      project_id: 'jobs', job_id: job.job_id, status: 'running',
    });
    const cancelled = await service.cancelJob('jobs', job.job_id, 'test cancellation');
    expect(cancelled).toMatchObject({
      status: 'cancelled', cancel_reason: 'test cancellation', revision: 3,
    });
    expect((await service.waitForJob('jobs', job.job_id)).job.status).toBe('cancelled');
    await expect(service.transitionKnowledgeJob({
      project_id: 'jobs', job_id: job.job_id, status: 'done',
    })).rejects.toThrow('invalid job transition');
    expect((await service.jobStatus('jobs', job.job_id)).status).toBe('cancelled');
  });

  it('keeps measurement and byte-ledger comparison contracts explicit', async () => {
    root = await mkdtemp(join(tmpdir(), 'surf-catalog-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://', vectorModel: '' });
    await service.createProject('Contracts', 'contracts');
    const measurement = (asset_id: string, context_length: number, carrier_precision: string) => ({
      project_id: 'contracts', kind: 'measurement' as const, operation: 'create' as const,
      asset_id, idempotency_key: `${asset_id}-v1`,
      fields: {
        metric: 'ppl', value: 7.04, unit: 'perplexity', evaluator_contract: 'wt2-v1',
        dataset: 'WikiText-2', split: 'test', tokenizer: 'llama-3', context_length,
        targets: 'all tokens', carrier_precision, source_locator: `${asset_id}.json:$.ppl`,
      },
    });
    await service.writeCatalogRecord(measurement('ppl-512-fp16', 512, 'fp16'));
    await service.writeCatalogRecord(measurement('ppl-2048-int8', 2048, 'int8'));
    await expect(service.writeCatalogRecord({
      project_id: 'contracts', kind: 'measurement', operation: 'create',
      asset_id: 'ambiguous-ppl', idempotency_key: 'ambiguous-ppl-v1', fields: { metric: 'ppl' },
    })).rejects.toThrow('provide values or list unknowns in missing_fields');
    await expect(service.getCatalogRecord('contracts', 'ambiguous-ppl'))
      .rejects.toThrow('record not found in project');
    await service.writeCatalogRecord({
      project_id: 'contracts', kind: 'byte_ledger', operation: 'create',
      asset_id: 'ledger-one', idempotency_key: 'ledger-one-v1',
      fields: { byte_components: { weights: 100 }, denominator: 1_000, scope: 'whole_model' },
    });

    const first = await service.getCatalogRecord('contracts', 'ppl-512-fp16');
    const second = await service.getCatalogRecord('contracts', 'ppl-2048-int8');
    const ledger = await service.getCatalogRecord('contracts', 'ledger-one');
    if ('legacy' in first || 'source' in first || 'legacy' in second || 'source' in second
      || 'legacy' in ledger || 'source' in ledger) throw new Error('unexpected record type');
    expect(first.revision.fields.comparison_contract_id)
      .not.toBe(second.revision.fields.comparison_contract_id);
    expect(ledger.revision.fields.ledger_scope_id).toMatch(/^[a-f0-9]{64}$/);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';

describe('research project memory', () => {
  let root: string;
  let service: ResearchService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'surf-research-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
  });

  afterEach(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves plan, failed experiment, and revised plan lineage', async () => {
    await service.createProject('Retrieval study', 'retrieval-study');
    const v1 = await service.createPlan({
      project_id: 'retrieval-study',
      title: 'Plan v1',
      body: 'Run the initial retrieval benchmark.',
    }, false);
    const experiment = await service.startExperiment({
      project_id: 'retrieval-study',
      name: 'BM25 baseline',
      hypothesis: 'BM25 retrieves exact terminology.',
    });
    const failed = await service.finishExperiment({
      project_id: 'retrieval-study',
      experiment_id: experiment.experiment_id,
      status: 'failed',
      summary: 'Korean compound terms were missed.',
      metrics: { recall_at_10: 0.42 },
    });
    const v2 = await service.createPlan({
      project_id: 'retrieval-study',
      title: 'Plan v2',
      body: 'Add a Korean analyzer challenger.',
      change_reason: 'Baseline recall was insufficient.',
      based_on_experiment_id: failed.experiment_id,
    }, true);

    const detail = await service.getProject('retrieval-study');

    expect(v1.revision).toBe(1);
    expect(v2).toMatchObject({
      revision: 2,
      parent_revision_id: v1.plan_revision_id,
      based_on_experiment_id: failed.experiment_id,
    });
    expect(detail.project.active_plan_revision_id).toBe(v2.plan_revision_id);
    expect(detail.plans).toHaveLength(2);
    expect(detail.experiments[0]).toMatchObject({ status: 'failed', plan_revision_id: v1.plan_revision_id });
  });

  it('archives search metadata and activates extracted content for BM25', async () => {
    await service.createProject('Graph memory', 'graph-memory');
    const archived = await service.capture({
      tool: 'search',
      project_id: 'graph-memory',
      query: 'temporal graph memory',
      payload: {
        results: [{
          title: 'Temporal Graph Memory',
          url: 'https://example.com/paper',
          description: 'A paper about temporal graphs.',
        }],
      },
    });
    const activated = await service.capture({
      tool: 'extract',
      project_id: 'graph-memory',
      payload: {
        title: 'Temporal Graph Memory',
        url: 'https://example.com/paper',
        content: 'Bitemporal provenance tracks valid time and transaction time.',
        extraction_quality: 'full_text',
      },
    });
    const hits = await service.search('graph-memory', 'bitemporal provenance', 10);

    expect(archived).toMatchObject({ stored: 1, rag_active: 0, rag_inactive: 1 });
    expect(activated).toMatchObject({ stored: 1, rag_active: 1, rag_inactive: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: 'Temporal Graph Memory', source_family: 'document' });
  });

  it('indexes long documents beyond 50000 characters and replaces stale chunks', async () => {
    await service.createProject('Long evidence', 'long-evidence');
    const url = 'https://example.com/long-paper';
    await service.capture({
      tool: 'extract',
      project_id: 'long-evidence',
      payload: {
        title: 'Long Paper',
        url,
        content: `${'prefix '.repeat(9_000)} latechunkneedle`,
        extraction_quality: 'full_text',
      },
    });
    await service.waitForIdle();

    expect(await service.search('long-evidence', 'latechunkneedle', 10)).toHaveLength(1);

    await service.capture({
      tool: 'extract',
      project_id: 'long-evidence',
      payload: {
        title: 'Long Paper',
        url,
        content: 'replacement body without the prior marker',
        extraction_quality: 'full_text',
      },
    });
    await service.waitForIdle();

    expect(await service.search('long-evidence', 'latechunkneedle', 10)).toHaveLength(0);
    expect(await service.search('long-evidence', 'replacement body', 10)).toHaveLength(1);
  });

  it('stores PDF metadata with abstract and full evidence', async () => {
    await service.createProject('PDF evidence', 'pdf-evidence');
    for (const extraction_quality of ['abstract', 'full_text']) {
      const receipt = await service.capture({
        tool: 'extract',
        project_id: 'pdf-evidence',
        payload: {
          title: `Metadata paper ${extraction_quality}`,
          url: `https://example.com/${extraction_quality}.pdf`,
          content: `searchable ${extraction_quality} paper body`,
          is_pdf: true,
          page_count: 12,
          extraction_quality,
          authors: 'Ada Lovelace',
          publication: 'Systems Journal',
          published_at: '2026-08-26',
          year: 2026,
          doi: `10.1234/${extraction_quality}`,
          subject: 'Graph retrieval',
          keywords: ['graph RAG', 'lineage'],
        },
      });
      expect(receipt).toMatchObject({ stored: 1, rag_active: 1, rag_inactive: 0 });
    }

    const detail = await service.getProject('pdf-evidence');
    expect(detail).toMatchObject({ document_count: 2, assertion_count: 16 });
    expect(await service.search('pdf-evidence', 'searchable paper body', 10)).toHaveLength(2);
  });

  it('keeps project retrieval isolated', async () => {
    await service.createProject('Project A', 'project-a');
    await service.createProject('Project B', 'project-b');
    await service.capture({
      tool: 'extract',
      project_id: 'project-a',
      payload: {
        title: 'Private A result',
        url: 'https://example.com/a',
        content: 'uniquetermalpha appears only in project A.',
        extraction_quality: 'full_text',
      },
    });

    expect(await service.search('project-a', 'uniquetermalpha', 10)).toHaveLength(1);
    expect(await service.search('project-b', 'uniquetermalpha', 10)).toHaveLength(0);
  });

  it('reads selected projects without changing project isolation', async () => {
    await service.createProject('Project A', 'project-a');
    await service.createProject('Project B', 'project-b');
    await service.capture({
      tool: 'extract',
      project_id: 'project-a',
      payload: {
        title: 'Project A evidence',
        url: 'https://example.com/project-a',
        content: 'sharedretrievalterm appears in project A.',
        extraction_quality: 'full_text',
      },
    });
    await service.capture({
      tool: 'extract',
      project_id: 'project-b',
      payload: {
        title: 'Project B evidence',
        url: 'https://example.com/project-b',
        content: 'sharedretrievalterm appears in project B.',
        extraction_quality: 'full_text',
      },
    });

    const combined = await service.search('project-a', 'sharedretrievalterm', 10, ['project-b']);

    expect(combined.map((row) => row.title)).toEqual([
      'Project A evidence',
      'Project B evidence',
    ]);
    expect(await service.search('project-a', 'sharedretrievalterm', 10)).toHaveLength(1);
  });

  it('installs the core ontology in a new local knowledge base', async () => {
    await service.createProject('Core ontology', 'core-ontology');

    const projection = await service.exportGraphProjection(['core-ontology']);
    const terms = projection.nodes.filter((node) => node.kind === 'ontology')
      .map((node) => node.label);

    expect(terms).toEqual(expect.arrayContaining([
      'paper', 'repo', 'web', 'authors', 'published_in', 'publication_year',
      'project', 'source_snapshot', 'source_file', 'code_symbol', 'code_dependency',
      'session', 'intent', 'plan', 'experiment', 'decision', 'evidence', 'assertion',
      'contains', 'defines', 'calls', 'imports', 'derived_from', 'supported_by',
      'supersedes', 'uses_plan', 'based_on', 'decides',
    ]));
    const projectNode = projection.nodes.find((node) => node.kind === 'project')!;
    const projectSchema = projection.nodes.find((node) => (
      node.kind === 'schema' && node.label === 'project'
    ))!;
    expect(projection.edges).toContainEqual(expect.objectContaining({
      source: projectNode.node_id,
      target: projectSchema.node_id,
      type: 'INSTANCE_OF',
    }));
  });

  it('uses schema-linked identities only across selected projects', async () => {
    await service.createProject('Project A', 'project-a');
    await service.createProject('Project B', 'project-b');
    await service.recordOntologyTerm({
      kind: 'entity_type',
      name: 'paper',
      aliases: ['publication'],
    });
    const entityA = await service.recordEntity({
      project_id: 'project-a',
      kind: 'paper',
      name: 'Paper A',
      aliases: ['doi:10.1000/shared'],
      source: 'explicit',
    });
    const entityB = await service.recordEntity({
      project_id: 'project-b',
      kind: 'publication',
      name: 'Paper B',
      aliases: ['doi:10.1000/shared'],
      source: 'explicit',
    });
    await service.recordAssertion({
      project_id: 'project-a',
      subject: entityA.entity_id,
      predicate: 'finding',
      value: 'crossprojectrareterm',
      source: 'explicit',
    });
    const decision = await service.recordDecision({
      project_id: 'project-b',
      title: 'Linked implementation decision',
      summary: 'Apply the shared paper in project B.',
    });
    const evidence = await service.recordEvidence({
      project_id: 'project-b',
      source_type: 'decision',
      source_id: decision.decision_id,
    });
    await service.recordAssertion({
      project_id: 'project-b',
      subject: entityB.entity_id,
      predicate: 'applies_to',
      value: 'project B implementation',
      source: 'explicit',
      evidence_ids: [evidence.evidence_id],
    });

    const isolated = await service.search('project-a', 'crossprojectrareterm', 10);
    const linkedBatch = await service.searchBatch(
      'project-a',
      'crossprojectrareterm',
      [],
      10,
      ['project-b'],
    );
    const linked = linkedBatch.results;

    expect(isolated.some((row) => row.title === 'Linked implementation decision')).toBe(false);
    expect(linked.some((row) => row.title === 'Linked implementation decision')).toBe(true);
    expect(linkedBatch.graph_project_count).toBe(2);
  });

  it('abstains when one project has an ambiguous identity match', async () => {
    await service.createProject('Project A', 'project-a');
    await service.createProject('Project B', 'project-b');
    await service.recordOntologyTerm({
      kind: 'entity_type',
      name: 'paper',
      aliases: ['publication'],
    });
    await service.recordEntity({
      project_id: 'project-a', kind: 'paper', name: 'Paper A',
      aliases: ['doi:10.1000/ambiguous'], source: 'explicit',
    });
    await service.recordEntity({
      project_id: 'project-b', kind: 'paper', name: 'Paper B1',
      aliases: ['doi:10.1000/ambiguous'], source: 'explicit',
    });
    await service.recordEntity({
      project_id: 'project-b', kind: 'publication', name: 'Paper B2',
      aliases: ['doi:10.1000/ambiguous'], source: 'explicit',
    });

    const projection = await service.exportGraphProjection(['project-a', 'project-b']);

    expect(projection.edges.some((edge) => edge.type === 'IDENTITY_LINK')).toBe(false);
  });

  it('keeps graph retrieval isolated in a shared projection', async () => {
    await service.createProject('Graph A', 'graph-a');
    await service.createProject('Graph B', 'graph-b');
    await service.capture({
      tool: 'extract',
      project_id: 'graph-b',
      payload: {
        title: 'Graph B evidence',
        url: 'https://example.com/graph-b',
        content: 'onlygraphbterm belongs to graph B.',
        extraction_quality: 'full_text',
      },
    });
    await service.materializeGraph(['graph-a', 'graph-b']);

    expect(await service.search('graph-a', 'onlygraphbterm', 10)).toHaveLength(0);
    expect(await service.search('graph-b', 'onlygraphbterm', 10)).toHaveLength(1);
    expect((await service.getProject('graph-a')).job_counts.done).toBe(1);
    expect((await service.getProject('graph-b')).job_counts.done).toBe(1);
  });

  it('routes graph-only all-project retrieval through indexed project seeds', async () => {
    const projectIds = Array.from({ length: 6 }, (_, index) => `graph-route-${index}`);
    for (const [index, projectId] of projectIds.entries()) {
      await service.createProject(`Graph route ${index}`, projectId);
      await service.recordDecision({
        project_id: projectId,
        title: `Decision ${index}`,
        summary: index === 5 ? 'uniqueroutingneedle target decision' : `unrelated decision ${index}`,
      });
      await service.materializeGraph([projectId]);
    }

    const result = await service.searchBatch(
      projectIds[0],
      'uniqueroutingneedle',
      [],
      10,
      projectIds.slice(1),
    );

    expect(result.graph_project_count).toBe(1);
    expect(result.results.some((row) => row.title === 'Decision 5')).toBe(true);
  });

  it('keeps a shared graph readable when one project publishes a replacement', async () => {
    await service.createProject('Graph A', 'graph-a');
    await service.createProject('Graph B', 'graph-b');
    const shared = await service.materializeGraph(['graph-a', 'graph-b']);
    await service.capture({
      tool: 'extract',
      project_id: 'graph-b',
      payload: {
        title: 'Graph B replacement',
        url: 'https://example.com/graph-b-replacement',
        content: 'replacementgraphterm belongs to graph B.',
        extraction_quality: 'full_text',
      },
    });
    await service.materializeGraph(['graph-b']);

    const seed = shared.projection.nodes.find((node) => node.project_id === 'graph-a')!.node_id;
    expect(await service.traverseMaterializedGraph(
      shared.projection.projection_id,
      [seed],
      1,
    )).toContain(seed);
  });

  it('bounds graph projection and artifact caches across projects', async () => {
    for (let index = 0; index < 6; index++) {
      const projectId = `cache-${index}`;
      await service.createProject(`Cache ${index}`, projectId);
      await service.materializeGraph([projectId]);
    }

    expect(service.status()).toMatchObject({
      graph_projection_cache: 1,
      graph_artifact_cache: 1,
    });
  });

  it('rebuilds a completed graph job when its artifact is missing', async () => {
    await service.createProject('Graph repair', 'graph-repair');
    const first = await service.materializeGraph(['graph-repair']);
    rmSync(join(root, 'graphs'), { recursive: true, force: true });

    const repaired = await service.materializeGraph(['graph-repair']);

    expect(repaired.projection.projection_id).toBe(first.projection.projection_id);
    expect(repaired.job.attempts).toBe(2);
    expect(repaired.analysis).toBeDefined();
  });

  it('stores Scholar metadata without promoting snippets to full-text evidence', async () => {
    await service.createProject('Scholar metadata', 'scholar-metadata');
    const receipt = await service.capture({
      tool: 'scholar_search',
      project_id: 'scholar-metadata',
      query: 'retrieval systems',
      payload: {
        results: [{
          title: 'Retrieval Systems',
          authors: 'A. Author, B. Author',
          publication: 'IR Journal',
          year: 2026,
          snippet: 'Scholar metadata is not paper evidence.',
          cited_by_count: 17,
          scholar_id: 'scholar-17',
        }],
      },
    });
    const detail = await service.getProject('scholar-metadata');

    expect(receipt).toMatchObject({ stored: 1, rag_active: 0, rag_inactive: 1 });
    expect(detail.citation_observation_count).toBe(1);
    expect(await service.search('scholar-metadata', 'paper evidence', 10)).toHaveLength(0);
  });

  it('does not infer or overwrite a completed experiment outcome', async () => {
    await service.createProject('Experiment guard', 'experiment-guard');
    await service.createPlan({
      project_id: 'experiment-guard', title: 'Plan', body: 'Run once.',
    }, false);
    const run = await service.startExperiment({
      project_id: 'experiment-guard', name: 'Run', hypothesis: 'One transition.',
    });
    await service.finishExperiment({
      project_id: 'experiment-guard',
      experiment_id: run.experiment_id,
      status: 'inconclusive',
      summary: 'The sample was too small.',
    });

    await expect(service.finishExperiment({
      project_id: 'experiment-guard',
      experiment_id: run.experiment_id,
      status: 'success',
      summary: 'Overwrite attempt.',
    })).rejects.toThrow('experiment already finished');
  });

  it('links project calls through an explicit memory handle and immutable intent revisions', async () => {
    await service.createProject('Session memory', 'session-memory');
    const first = await service.capture({
      tool: 'search',
      project_id: 'session-memory',
      query: 'initial retrieval intent',
      payload: { results: [] },
    });
    const second = await service.capture({
      tool: 'search',
      project_id: 'session-memory',
      memory_handle: first.memory_handle,
      query: 'follow-up query',
      payload: { results: [] },
    });
    const recorded = await service.recordSessionIntent({
      project_id: 'session-memory',
      memory_handle: first.memory_handle,
      intent: 'Evaluate cross-project retrieval without losing live discovery.',
    });
    const detail = await service.getProject('session-memory');

    expect(first.memory_handle).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.memory_handle).toBe(first.memory_handle);
    expect(second.session_intent).toBe('initial retrieval intent');
    expect(recorded.intent).toMatchObject({ revision: 2, status: 'confirmed' });
    expect(detail.session_count).toBe(1);
  });

  it('resumes host sessions deterministically and records only changed durable intent', async () => {
    await service.createProject('Automatic session', 'automatic-session');
    const first = await service.capture({
      tool: 'search',
      project_id: 'automatic-session',
      session_id: 'host-task-17',
      session_intent: 'Evaluate automatic project memory.',
      query: 'first query',
      payload: { results: [] },
    });
    const repeated = await service.capture({
      tool: 'search',
      project_id: 'automatic-session',
      session_id: 'host-task-17',
      session_intent: 'Evaluate automatic project memory.',
      query: 'second query',
      payload: { results: [] },
    });
    const changed = await service.capture({
      tool: 'search',
      project_id: 'automatic-session',
      session_id: 'host-task-17',
      session_intent: 'Measure automatic memory across process restarts.',
      query: 'third query',
      payload: { results: [] },
    });
    const detail = await service.getProject('automatic-session');

    expect(repeated.memory_handle).toBe(first.memory_handle);
    expect(changed.memory_handle).toBe(first.memory_handle);
    expect(changed.session_intent).toBe('Measure automatic memory across process restarts.');
    expect(detail.session_count).toBe(1);
  });

  it('records an explicit project decision', async () => {
    await service.createProject('Decision memory', 'decision-memory');
    const decision = await service.recordDecision({
      project_id: 'decision-memory',
      title: 'Keep live discovery',
      summary: 'Hybrid retrieval must always retain a live search lane.',
    });
    const detail = await service.getProject('decision-memory');

    expect(decision.title).toBe('Keep live discovery');
    expect(detail.decisions).toHaveLength(1);
  });

  it('previews, forgets, and restores a project without deleting its data', async () => {
    await service.createProject('Reversible project', 'reversible-project');
    await service.capture({
      tool: 'extract',
      project_id: 'reversible-project',
      payload: {
        title: 'Stored evidence',
        url: 'https://example.com/stored',
        content: 'reversibleevidence remains after a tombstone.',
        extraction_quality: 'full_text',
      },
    });
    const preview = await service.previewForgetProject('reversible-project');
    const graph = await service.materializeGraph(['reversible-project']);

    expect(preview).toMatchObject({ documents: 1, source_entries: 0, sessions: 1 });
    await expect(service.forgetProject('reversible-project', 'wrong-token'))
      .rejects.toThrow('forget confirmation expired');
    await service.forgetProject('reversible-project', preview.confirm_token);
    expect((await service.listProjects()).map((project) => project.project_id))
      .not.toContain('reversible-project');
    await expect(service.search('reversible-project', 'reversibleevidence', 10))
      .rejects.toThrow('project forgotten');

    await service.restoreProject('reversible-project');
    const restored = await service.getProject('reversible-project');
    expect(restored.project.active_graph_projection_id).toBe(graph.projection.projection_id);
    expect(restored.project.forgot_at).toBeUndefined();
    expect(await service.search('reversible-project', 'reversibleevidence', 10)).toHaveLength(1);
  });

  it('preserves assertion evidence and bitemporal history through correction', async () => {
    await service.createProject('Assertion history', 'assertion-history');
    const evidence = await service.recordEvidence({
      project_id: 'assertion-history',
      source_type: 'manual',
      source_id: 'user-review',
      locator: 'session:review',
      quote: 'The measured value is 0.74.',
    });
    const original = await service.recordAssertion({
      project_id: 'assertion-history',
      subject: 'experiment:retrieval',
      predicate: 'recall_at_10',
      value: 0.71,
      source: 'sidecar',
      evidence_ids: [evidence.evidence_id],
      valid_from: '2026-08-01T00:00:00Z',
    });
    const corrected = await service.correctAssertion({
      project_id: 'assertion-history',
      target_assertion_id: original.assertion_id,
      replacement: 0.74,
      reason: 'Correct the transcribed metric.',
    });
    const superseded = await service.getAssertion('assertion-history', original.assertion_id);
    const detail = await service.getProject('assertion-history');

    expect(superseded).toMatchObject({ status: 'superseded' });
    expect(superseded.recorded_until).toBeTruthy();
    expect(corrected.assertion).toMatchObject({
      status: 'confirmed',
      source: 'explicit',
      value: 0.74,
      supersedes_assertion_id: original.assertion_id,
      evidence_ids: [evidence.evidence_id],
    });
    expect(detail).toMatchObject({ assertion_count: 1, correction_count: 1 });
    await expect(service.correctAssertion({
      project_id: 'assertion-history',
      target_assertion_id: original.assertion_id,
      replacement: 0.75,
      reason: 'Second overwrite attempt.',
    })).rejects.toThrow('target assertion is not active');
  });

  it('keeps sidecar assertions suggested and evidence project-scoped', async () => {
    await service.createProject('Project A', 'assertion-a');
    await service.createProject('Project B', 'assertion-b');
    const evidence = await service.recordEvidence({
      project_id: 'assertion-a',
      source_type: 'manual',
      source_id: 'review-a',
    });

    await expect(service.recordAssertion({
      project_id: 'assertion-a',
      subject: 'paper:a',
      predicate: 'supports',
      object: 'claim:a',
      source: 'sidecar',
      status: 'confirmed',
    })).rejects.toThrow('sidecar assertions must start as suggested');
    await expect(service.recordAssertion({
      project_id: 'assertion-b',
      subject: 'paper:b',
      predicate: 'supports',
      object: 'claim:b',
      source: 'sidecar',
      evidence_ids: [evidence.evidence_id],
    })).rejects.toThrow('evidence_ids must belong to the project');
  });

  it('versions ontology terms without losing the prior term', async () => {
    await service.createProject('Ontology versions', 'ontology-versions');
    const first = await service.recordOntologyTerm({
      project_id: 'ontology-versions',
      kind: 'relation',
      name: 'implements',
      aliases: ['realizes'],
    });
    const second = await service.recordOntologyTerm({
      project_id: 'ontology-versions',
      kind: 'relation',
      name: 'implements',
      aliases: ['realizes', 'implements_exactly'],
      version: 2,
      supersedes_term_id: first.term_id,
    });

    expect(await service.getOntologyTerm(first.term_id)).toMatchObject({ status: 'superseded' });
    expect(second).toMatchObject({
      version: 2,
      status: 'active',
      supersedes_term_id: first.term_id,
    });
  });

  it('deduplicates knowledge jobs and permits only explicit retry transitions', async () => {
    await service.createProject('Job state', 'job-state');
    const first = await service.queueKnowledgeJob({
      project_id: 'job-state',
      kind: 'schema_link',
      source_hash: 'source-1',
      schema_version: 'schema-1',
      algorithm_version: 'algorithm-1',
      affected_source_ids: ['source-a'],
    });
    const duplicate = await service.queueKnowledgeJob({
      project_id: 'job-state',
      kind: 'schema_link',
      source_hash: 'source-1',
      schema_version: 'schema-1',
      algorithm_version: 'algorithm-1',
    });
    const running = await service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'running',
    });
    const failed = await service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'failed', error: 'probe failed',
    });
    const queued = await service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'queued',
    });
    const retried = await service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'running',
    });
    const done = await service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'done', result_digest: 'result-1',
    });

    expect(duplicate.job_id).toBe(first.job_id);
    expect(running.attempts).toBe(1);
    expect(failed.status).toBe('failed');
    expect(queued.status).toBe('queued');
    expect(retried.attempts).toBe(2);
    expect(done).toMatchObject({ status: 'done', result_digest: 'result-1' });
    await expect(service.transitionKnowledgeJob({
      project_id: 'job-state', job_id: first.job_id, status: 'running',
    })).rejects.toThrow('invalid job transition');
  });

  it('returns partial search results when one retrieval lane times out', async () => {
    await service.createProject('Timeout fallback', 'timeout-fallback');
    await service.capture({
      tool: 'extract',
      project_id: 'timeout-fallback',
      payload: {
        title: 'QWEN-HIST-SUCCESS',
        url: 'https://example.com/qwen-history',
        content: 'Historical Qwen integer assignment evidence.',
        extraction_quality: 'full_text',
      },
    });
    const store = Reflect.get(service, 'store') as {
      searchProjectBm25: typeof service.search;
    };
    const original = store.searchProjectBm25;
    store.searchProjectBm25 = async () => {
      throw new Error('The query was not executed because it exceeded the timeout: 30s');
    };

    try {
      const result = await service.searchBatch(
        'timeout-fallback',
        'QWEN-HIST-SUCCESS',
        [],
        10,
      );

      expect(result.degraded_lanes).toContain('bm25');
      expect(result.results.some((row) => row.title === 'QWEN-HIST-SUCCESS')).toBe(true);
    } finally {
      store.searchProjectBm25 = original;
    }
  });

  it('links aliases and preserves merge and split operations', async () => {
    await service.createProject('Entity history', 'entity-history');
    const target = await service.recordEntity({
      project_id: 'entity-history',
      kind: 'method',
      name: 'Activation Quantization',
      aliases: ['AQ'],
      source: 'explicit',
    });
    const source = await service.recordEntity({
      project_id: 'entity-history',
      kind: 'method',
      name: 'Activation Weight Quantization',
      aliases: ['AWQ'],
      source: 'sidecar',
    });
    const merged = await service.mergeEntities({
      project_id: 'entity-history',
      target_entity_id: target.entity_id,
      source_entity_ids: [source.entity_id],
      reason: 'The project uses one canonical method name.',
    });
    const linked = await service.linkEntity('entity-history', 'AWQ');
    const split = await service.splitEntity({
      project_id: 'entity-history',
      source_entity_id: target.entity_id,
      target_name: 'Activation-aware Weight Quantization',
      aliases: ['AWQ'],
      reason: 'AWQ names a distinct method.',
    });

    expect(merged.operation).toMatchObject({ kind: 'merge' });
    expect(await service.getEntity('entity-history', source.entity_id)).toMatchObject({
      status: 'merged',
      merged_into_entity_id: target.entity_id,
    });
    expect(linked[0]).toMatchObject({ match: 'alias' });
    expect(linked[0].entity.entity_id).toBe(target.entity_id);
    expect(split.operation).toMatchObject({ kind: 'split', source_entity_ids: [target.entity_id] });
    expect((await service.linkEntity('entity-history', 'AWQ'))[0].entity.entity_id)
      .toBe(split.entity.entity_id);
  });
});

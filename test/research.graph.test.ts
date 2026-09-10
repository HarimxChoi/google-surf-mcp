import { describe, expect, it } from 'vitest';
import type { ProjectGraphSource } from '../src/research/graphProjection.js';
import { buildGraphProjection } from '../src/research/graphProjection.js';
import {
  analyzeGraphProjection, graphQuerySeeds, personalizedPageRank, rankGraphProjection,
} from '../src/research/graphSidecar.js';

describe('research graph sidecar', () => {
  it('builds plan and experiment lineage with deterministic metrics', () => {
    const source: ProjectGraphSource = {
      project: {
        project_id: 'graph-test',
        name: 'Graph Test',
        status: 'active',
        active_source_snapshot_id: 'snapshot-1',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z',
      },
      source_snapshots: [{
        snapshot_id: 'snapshot-1',
        project_id: 'graph-test',
        inventory_digest: 'inventory-1',
        policy: 'structured',
        status: 'active',
        file_count: 1,
        collection_count: 0,
        searchable_file_count: 1,
        unique_body_count: 1,
        sensitive_file_count: 0,
        unreadable_file_count: 0,
        total_bytes: 100,
        kinds: { source: 1 },
        root_labels: ['repo'],
        roots: [{ label: 'repo', path: 'C:/repo' }],
        created_at: '2026-08-25T00:00:00.000Z',
        activated_at: '2026-08-25T00:00:00.000Z',
      }],
      source_entries: [{
        entry_id: 'kernel',
        project_id: 'graph-test',
        root: 'repo',
        path: 'src/quant/kernel.ts',
        kind: 'source',
        entry_type: 'file',
        searchable: true,
        updated_snapshot_id: 'snapshot-1',
      }],
      documents: [],
      plans: [{
        plan_revision_id: 'plan-v1',
        project_id: 'graph-test',
        revision: 1,
        title: 'Quantization plan',
        body: 'Measure activation quantization error.',
        created_at: '2026-08-25T00:00:00.000Z',
      }],
      experiments: [{
        experiment_id: 'experiment-1',
        project_id: 'graph-test',
        plan_revision_id: 'plan-v1',
        name: 'Activation probe',
        hypothesis: 'Quantization error remains bounded.',
        status: 'success',
        started_at: '2026-08-25T00:00:00.000Z',
      }],
      decisions: [],
      sessions: [],
      intents: [],
      entities: [],
      assertions: [],
      symbols: [],
      code_relations: [],
    };
    const projection = buildGraphProjection([source]);
    const seeds = graphQuerySeeds(projection, 'activation probe');
    const first = analyzeGraphProjection(projection, { seeds });
    const second = analyzeGraphProjection(projection, { seeds });
    const ppr = personalizedPageRank(projection, seeds);
    const changed = buildGraphProjection([{
      ...source,
      plans: [{ ...source.plans[0], body: 'Measure a different quantization bound.' }],
    }]);

    expect(projection.edges.some((edge) => edge.type === 'USES_PLAN')).toBe(true);
    expect(projection.edges.some((edge) => edge.type === 'CONTAINS_ENTRY')).toBe(true);
    expect(seeds.length).toBeGreaterThan(0);
    expect(Object.keys(ppr)).toHaveLength(projection.nodes.length);
    expect(first.community).toEqual(second.community);
    expect(first.pagerank).toEqual(second.pagerank);
    expect(rankGraphProjection(projection, 'activation probe')).not.toHaveLength(0);
    const target = projection.nodes.find((node) => node.label === 'Activation probe')!;
    const unrelated = projection.nodes.find((node) => node.node_id !== target.node_id)!;
    const disconnected = { ...projection, nodes: [target, unrelated], edges: [] };
    expect(rankGraphProjection(disconnected, 'activation probe', 2, [unrelated.node_id])
      .map(({ node }) => node.node_id)).toContain(target.node_id);
    expect(changed.projection_id).not.toBe(projection.projection_id);
  });

  it('links project schemas and preserves assertion evidence lineage', () => {
    const ontology = [{
      term_id: 'paper-type',
      kind: 'entity_type' as const,
      name: 'paper',
      aliases: ['publication'],
      version: 1,
      status: 'active' as const,
      created_at: '2026-08-25T00:00:00.000Z',
    }];
    const makeSource = (
      projectId: string,
      kind: string,
      documentId: string,
      assertionId: string,
      evidenceId: string,
      value: string,
    ): ProjectGraphSource => ({
      project: {
        project_id: projectId,
        name: projectId,
        status: 'active',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z',
      },
      source_entries: [],
      documents: [{
        project_id: projectId,
        document_id: documentId,
        state: 'lexical_active',
        title: `${projectId} document`,
        url: `https://example.test/${documentId}`,
        text: `${projectId} evidence body`,
      }],
      plans: [],
      experiments: [],
      decisions: [],
      sessions: [],
      intents: [],
      entities: [{
        entity_id: `${projectId}-entity`,
        project_id: projectId,
        kind,
        canonical_name: `${projectId} paper`,
        normalized_name: `${projectId} paper`,
        status: 'confirmed',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z',
      }],
      aliases: [{
        alias_id: `${projectId}-doi`,
        project_id: projectId,
        entity_id: `${projectId}-entity`,
        alias: 'https://doi.org/10.1000/shared',
        normalized_alias: 'doi.org/10.1000/shared',
        source: 'deterministic',
        confidence: 1,
        status: 'active',
        created_at: '2026-08-25T00:00:00.000Z',
      }],
      ontology_terms: ontology,
      evidence: [{
        evidence_id: evidenceId,
        project_id: projectId,
        source_type: 'document',
        source_id: documentId,
        locator: 'provider_metadata',
        created_at: '2026-08-25T00:00:00.000Z',
      }],
      assertions: [{
        assertion_id: assertionId,
        project_id: projectId,
        subject: `${projectId}-entity`,
        predicate: 'supports',
        value,
        status: 'confirmed',
        source: 'deterministic',
        evidence_ids: [evidenceId],
        ontology_version: 1,
        recorded_at: '2026-08-25T00:00:00.000Z',
      }],
      symbols: [],
      code_relations: [],
    });
    const sourceA = makeSource(
      'project-a', 'paper', 'document-a', 'assertion-a', 'evidence-a', 'rare-activation',
    );
    const sourceB = makeSource(
      'project-b', 'publication', 'document-b', 'assertion-b', 'evidence-b', 'implementation',
    );
    const projection = buildGraphProjection([sourceA, sourceB]);
    const unlinked = buildGraphProjection([sourceA, {
      ...sourceB,
      aliases: sourceB.aliases!.map((alias) => ({
        ...alias,
        alias: 'https://doi.org/10.1000/different',
        normalized_alias: 'doi.org/10.1000/different',
      })),
    }]);
    const identityEdges = projection.edges.filter((edge) => edge.type === 'IDENTITY_LINK');
    const hits = rankGraphProjection(projection, 'rare-activation', 20);
    const unlinkedHits = rankGraphProjection(unlinked, 'rare-activation', 20);

    expect(identityEdges).toHaveLength(2);
    expect(projection.edges.filter((edge) => edge.type === 'INSTANCE_OF')).toHaveLength(2);
    expect(projection.edges.filter((edge) => edge.type === 'SUPPORTED_BY')).toHaveLength(2);
    expect(projection.edges.filter((edge) => edge.type === 'DERIVED_FROM')).toHaveLength(2);
    expect(hits.some((hit) => hit.node.project_id === 'project-b'
      && hit.node.source_id === 'document-b')).toBe(true);
    expect(unlinkedHits.some((hit) => hit.node.project_id === 'project-b')).toBe(false);
  });

  it('projects typed catalog revisions without collapsing qualified lineage edges', () => {
    const recordedAt = '2026-09-04T12:00:00.000Z';
    const asset = (asset_id: string, kind: 'task' | 'attempt' | 'measurement') => ({
      asset_id,
      project_id: 'catalog-graph',
      kind,
      status: 'active' as const,
      current_revision: 1,
      current_revision_id: `${asset_id}:v1`,
      aliases: [],
      protected: false,
      access_tier: 'hot' as const,
      created_at: recordedAt,
      updated_at: recordedAt,
    });
    const source: ProjectGraphSource = {
      project: {
        project_id: 'catalog-graph', name: 'Catalog Graph', status: 'active',
        created_at: recordedAt, updated_at: recordedAt,
      },
      source_entries: [], documents: [], plans: [], experiments: [], decisions: [],
      sessions: [], intents: [], entities: [], assertions: [], symbols: [], code_relations: [],
      evidence: [{
        evidence_id: 'evidence-1', project_id: 'catalog-graph', source_type: 'manual',
        source_id: 'operator-note', created_at: recordedAt,
      }],
      catalog_assets: [
        asset('task-a', 'task'), asset('attempt-a', 'attempt'), asset('measurement-a', 'measurement'),
      ],
      catalog_revisions: [{
        revision_id: 'task-a:v1', asset_id: 'task-a', project_id: 'catalog-graph', kind: 'task',
        revision: 1, operation: 'create', body_bytes: 0, fields: { title: 'Build allocator' },
        evidence_ids: [], artifact_references: [], changed_fields: ['title'], missing_fields: [],
        effective_at: '2026-09-03T00:00:00.000Z', recorded_at: recordedAt,
      }, {
        revision_id: 'attempt-a:v1', asset_id: 'attempt-a', project_id: 'catalog-graph', kind: 'attempt',
        revision: 1, operation: 'create', body_bytes: 0,
        fields: { title: 'Integer allocation run', task_id: 'task-a' },
        evidence_ids: ['evidence-1'],
        artifact_references: [{ artifact_id: 'run-output', role: 'log', available: true }, {
          artifact_id: 'run-output', role: 'checkpoint', available: true,
        }],
        changed_fields: ['title', 'task_id'], missing_fields: [],
        effective_at: '2026-09-04T00:00:00.000Z', recorded_at: recordedAt,
      }, {
        revision_id: 'measurement-a:v1', asset_id: 'measurement-a', project_id: 'catalog-graph',
        kind: 'measurement', revision: 1, operation: 'create', body_bytes: 0,
        fields: { metric: 'ppl', value: 7.04, attempt_id: 'attempt-a' },
        evidence_ids: ['evidence-1'], artifact_references: [],
        changed_fields: ['metric', 'value', 'attempt_id'], missing_fields: [], recorded_at: recordedAt,
      }],
    };

    const projection = buildGraphProjection([source]);
    const artifactEdges = projection.edges.filter((edge) => edge.type === 'REFERENCES_ARTIFACT');
    const attemptRevision = projection.nodes.find((node) => node.source_id === 'attempt-a:v1');

    expect(projection.nodes.some((node) => node.kind === 'task' && node.source_id === 'task-a:v1'))
      .toBe(true);
    expect(projection.nodes.some((node) => node.kind === 'measurement'
      && node.source_id === 'measurement-a:v1')).toBe(true);
    expect(attemptRevision).toMatchObject({
      record_id: 'attempt-a',
      revision_id: 'attempt-a:v1',
    });
    expect(projection.edges.some((edge) => edge.type === 'IMPLEMENTS_TASK')).toBe(true);
    expect(projection.edges.some((edge) => edge.type === 'OBSERVED_IN_ATTEMPT')).toBe(true);
    expect(projection.edges.some((edge) => edge.type === 'HAS_REVISION'
      && edge.effective_at === '2026-09-04T00:00:00.000Z'
      && edge.recorded_at === recordedAt)).toBe(true);
    expect(artifactEdges).toHaveLength(2);
    expect(new Set(artifactEdges.map((edge) => edge.edge_id)).size).toBe(2);
    expect(new Set(artifactEdges.map((edge) => edge.qualifiers?.role)))
      .toEqual(new Set(['log', 'checkpoint']));
    expect(projection.edges.some((edge) => edge.source === attemptRevision?.node_id
      && edge.type === 'SUPPORTED_BY' && edge.evidence_ids?.[0] === 'evidence-1')).toBe(true);
    expect(rankGraphProjection(projection, 'integer allocation run')).not.toHaveLength(0);
  });
});

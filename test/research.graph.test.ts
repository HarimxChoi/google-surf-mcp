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
});

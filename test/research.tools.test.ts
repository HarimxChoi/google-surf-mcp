import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/research/service.js';
import { projectMemorySearchTool, projectMemoryTool } from '../src/research/tools.js';

describe('project_memory tool', () => {
  let root: string;
  let service: ResearchService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'surf-memory-tool-'));
    service = new ResearchService({ enabled: true, root, endpoint: 'mem://' });
  });

  afterEach(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('corrects and shows an assertion through one public tool', async () => {
    await service.createProject('Correction tool', 'correction-tool');
    const assertion = await service.recordAssertion({
      project_id: 'correction-tool',
      subject: 'paper:one',
      predicate: 'citation_count',
      value: 10,
      source: 'sidecar',
    });
    const corrected = await projectMemoryTool({
      action: 'record',
      record_type: 'correction',
      project_id: 'correction-tool',
      target_id: assertion.assertion_id,
      replacement: 12,
      reason: 'New citation observation.',
    }, service);
    const replacementId = corrected.structuredContent?.record?.assertion_id as string;
    const shown = await projectMemoryTool({
      action: 'show',
      project_id: 'correction-tool',
      target_id: replacementId,
    }, service);

    expect(corrected.isError).not.toBe(true);
    expect(corrected.structuredContent?.memory).toBe(
      'Project: correction-tool | Record: assertion correction 1 | Status: ready',
    );
    expect(shown.structuredContent?.assertion).toMatchObject({
      assertion_id: replacementId,
      value: 12,
      status: 'confirmed',
    });
  });

  it('records a project ontology revision through project_memory', async () => {
    await service.createProject('Ontology tool', 'ontology-tool');
    const result = await projectMemoryTool({
      action: 'record',
      record_type: 'ontology',
      project_id: 'ontology-tool',
      ontology_kind: 'entity_type',
      name: 'model',
      aliases: ['checkpoint'],
      version: 1,
    }, service);
    const firstId = result.structuredContent?.record?.record_id as string;
    const revised = await projectMemoryTool({
      action: 'record',
      record_type: 'ontology',
      project_id: 'ontology-tool',
      ontology_kind: 'entity_type',
      name: 'model',
      aliases: ['checkpoint', 'artifact'],
      supersedes_term_id: firstId,
    }, service);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.record).toEqual({
      record_type: 'ontology',
      record_id: firstId,
      project_id: 'ontology-tool',
      kind: 'entity_type',
      name: 'model',
      version: 1,
      status: 'active',
    });
    expect(revised.structuredContent?.record).toMatchObject({ version: 2 });
    expect(await service.getOntologyTerm(firstId)).toMatchObject({ status: 'superseded' });
  });

  it('keeps project summaries and write receipts compact by default', async () => {
    await service.createProject('Compact tool', 'compact-tool');
    const body = `plan-body-marker ${'long plan content '.repeat(2_000)}`;
    const plan = await projectMemoryTool({
      action: 'record',
      record_type: 'plan',
      project_id: 'compact-tool',
      title: 'Compact response plan',
      body,
    }, service);
    const decision = await projectMemoryTool({
      action: 'record',
      record_type: 'decision',
      project_id: 'compact-tool',
      title: 'Compact response decision',
      summary: `decision-body-marker ${'decision content '.repeat(400)}`,
    }, service);
    const summary = await projectMemoryTool({
      action: 'show',
      project_id: 'compact-tool',
    }, service);
    const full = await projectMemoryTool({
      action: 'show',
      project_id: 'compact-tool',
      detail_level: 'full',
    }, service);

    expect(plan.structuredContent?.record).toMatchObject({
      record_type: 'plan',
      project_id: 'compact-tool',
      revision: 1,
    });
    expect(JSON.stringify(plan.structuredContent)).not.toContain('plan-body-marker');
    expect(JSON.stringify(decision.structuredContent)).not.toContain('decision-body-marker');
    expect(summary.structuredContent).toMatchObject({
      plan_count: 1,
      experiment_count: 0,
      decision_count: 1,
    });
    expect(summary.structuredContent?.plans).toBeUndefined();
    expect(JSON.stringify(summary.structuredContent)).not.toContain('plan-body-marker');
    expect(full.structuredContent?.plans?.[0]?.body).toContain('plan-body-marker');
  });

  it('searches stored project knowledge without creating a live search event', async () => {
    await service.createProject('Memory A', 'memory-a');
    await service.createProject('Memory B', 'memory-b');
    for (const projectId of ['memory-a', 'memory-b']) {
      await service.capture({
        tool: 'extract',
        project_id: projectId,
        payload: {
          title: 'Shared local evidence',
          url: 'https://example.com/shared-local-evidence',
          content: `localmemoryneedle ${'bounded content '.repeat(150)}`,
          extraction_quality: 'full_text',
        },
      });
    }
    await service.waitForIdle();
    const before = await service.getProject('memory-a');
    const result = await projectMemorySearchTool({
      project_id: 'memory-a',
      include_project_ids: ['memory-b'],
      query: 'localmemoryneedle',
      query_variants: ['Shared local evidence', 'localmemoryneedle'],
      limit: 5,
    }, service);
    const after = await service.getProject('memory-a');
    const rows = result.structuredContent?.results as Array<Record<string, any>>;

    expect(result.isError).not.toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Shared local evidence',
      project_ids: ['memory-a', 'memory-b'],
      source_family: 'document',
    });
    expect(rows[0].retrieval_families).toEqual(expect.arrayContaining(['bm25', 'graph']));
    expect(rows[0].content.length).toBeLessThanOrEqual(1_500);
    expect(result.structuredContent?.meta).toMatchObject({
      query_count: 2,
      query_execution: 'single_broker_request',
    });
    expect(result.structuredContent?.meta).toMatchObject({
      provider: 'local',
      project_ids: ['memory-a', 'memory-b'],
      retrieval_lanes: ['exact', 'bm25', 'graph'],
      fusion: 'rrf',
      reranker: 'rrf_only',
      live_web_used: false,
      browser_used: false,
      searchapi_used: false,
      captured: false,
    });
    expect(after.search_event_count).toBe(before.search_event_count);

    const alias = await projectMemoryTool({
      action: 'search',
      project_id: 'memory-a',
      include_project_ids: ['memory-b'],
      query: 'localmemoryneedle',
      query_variants: ['Shared local evidence', 'localmemoryneedle'],
      limit: 5,
    }, service);
    expect(alias.structuredContent?.results).toEqual(result.structuredContent?.results);

    const allProjects = await projectMemorySearchTool({
      all_projects: true,
      query: 'localmemoryneedle',
      limit: 5,
    }, service);
    expect(allProjects.structuredContent?.results).toHaveLength(1);

    const invalid = await projectMemorySearchTool({
      project_id: 'memory-a',
      all_projects: true,
      query: 'localmemoryneedle',
    }, service);
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent?.error?.message).toContain('cannot be combined');
  });

  it('exports one project or all named projects without node bodies', async () => {
    await service.createProject('Export A', 'export-a');
    await service.createProject('Export B', 'export-b');
    await service.createPlan({
      project_id: 'export-a',
      title: 'Export plan',
      body: 'This body must not be exported.',
    }, false);
    const result = await projectMemoryTool({
      action: 'export',
      all_projects: true,
      export_format: 'd3',
      export_view: 'graph',
    }, service);
    const visualization = result.structuredContent?.visualization as Record<string, any>;
    const document = JSON.parse(readFileSync(visualization.path, 'utf8')) as Record<string, any>;

    expect(result.isError).not.toBe(true);
    expect(visualization.project_ids).toEqual(['export-a', 'export-b']);
    expect(visualization.path).toContain(join(root, 'exports'));
    expect(document.project_ids).toEqual(['export-a', 'export-b']);
    expect(document.nodes.some((node: any) => node.kind === 'plan')).toBe(true);
    expect(document.nodes.every((node: any) => !('text' in node))).toBe(true);
    expect(document.nodes.every((node: any) => 'pagerank' in node)).toBe(true);

    const repeated = await projectMemoryTool({
      action: 'export',
      all_projects: true,
      export_format: 'd3',
      export_view: 'graph',
    }, service);
    const dot = await projectMemoryTool({
      action: 'export',
      project_id: 'export-a',
      export_format: 'dot',
      export_view: 'ontology',
    }, service);
    const dotVisualization = dot.structuredContent?.visualization as Record<string, any>;

    expect(repeated.structuredContent?.visualization?.path).toBe(visualization.path);
    expect(dotVisualization.project_ids).toEqual(['export-a']);
    expect(dotVisualization.path).toMatch(/\.dot$/);
    expect(readFileSync(dotVisualization.path, 'utf8')).toContain('view="ontology"');

    const neo4j = await projectMemoryTool({
      action: 'export',
      project_id: 'export-a',
      export_format: 'neo4j',
      export_view: 'lineage',
    }, service);
    const neo4jVisualization = neo4j.structuredContent?.visualization as Record<string, any>;

    expect(neo4j.isError).not.toBe(true);
    expect(neo4jVisualization.path).toMatch(/-neo4j$/);
    expect(neo4jVisualization.files.map((path: string) => basename(path))).toEqual([
      'nodes.csv', 'relationships.csv', 'constraints.cypher',
      'load.cypher', 'manifest.json', 'README.txt',
    ]);
    expect(readFileSync(join(neo4jVisualization.path, 'nodes.csv'), 'utf8'))
      .not.toContain('This body must not be exported.');

    const interactive = await projectMemoryTool({
      action: 'export',
      project_id: 'export-a',
      export_format: 'html',
      export_view: 'graph',
    }, service);
    const interactiveVisualization = interactive.structuredContent?.visualization as Record<string, any>;
    const html = readFileSync(interactiveVisualization.path, 'utf8');

    expect(interactive.isError).not.toBe(true);
    expect(interactiveVisualization.path).toMatch(/\.html$/);
    expect(html).toContain('surf-interactive-graph-v1');
    expect(html).toContain('Knowledge graph');
    expect(html).not.toContain('This body must not be exported.');
  });

  it('previews, forgets, and restores one assertion without deleting evidence', async () => {
    await service.createProject('Assertion forget', 'assertion-forget');
    const evidence = await service.recordEvidence({
      project_id: 'assertion-forget',
      source_type: 'manual',
      source_id: 'review',
    });
    const assertion = await service.recordAssertion({
      project_id: 'assertion-forget',
      subject: 'paper:one',
      predicate: 'supports',
      object: 'claim:one',
      source: 'sidecar',
      evidence_ids: [evidence.evidence_id],
    });
    const preview = await projectMemoryTool({
      action: 'forget',
      project_id: 'assertion-forget',
      target_id: assertion.assertion_id,
      forget_mode: 'preview',
    }, service);
    const confirmToken = preview.structuredContent?.forget?.confirm_token as string;
    const forgotten = await projectMemoryTool({
      action: 'forget',
      project_id: 'assertion-forget',
      target_id: assertion.assertion_id,
      forget_mode: 'apply',
      confirm_token: confirmToken,
    }, service);
    const hidden = await service.getProject('assertion-forget');
    const restored = await projectMemoryTool({
      action: 'forget',
      project_id: 'assertion-forget',
      target_id: assertion.assertion_id,
      forget_mode: 'restore',
    }, service);

    expect(preview.structuredContent?.memory).toContain('evidence 1 retained');
    expect(forgotten.structuredContent?.assertion).toMatchObject({ status: 'forgotten' });
    expect(hidden.assertion_count).toBe(0);
    expect(restored.structuredContent?.assertion).toMatchObject({ status: 'suggested' });
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isMissingProjectResponse, normalizeCollectionSpec, readCollectionLog, runCollection,
} from '../src/collect.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('replayable research collection', () => {
  it('keeps bundled collection examples valid', () => {
    for (const name of [
      'research-collection.example.json',
      'project-memory-workflow.example.json',
    ]) {
      const input = JSON.parse(readFileSync(join(process.cwd(), 'examples', name), 'utf8'));
      expect(normalizeCollectionSpec(input).jobs.length).toBeGreaterThan(0);
    }
  });

  it('creates projects only after an explicit not-found response', () => {
    expect(isMissingProjectResponse({
      isError: true,
      structuredContent: { error: { code: 'NOT_FOUND', message: 'project not found: project-a' } },
    })).toBe(true);
    expect(isMissingProjectResponse({
      isError: true,
      structuredContent: { error: { code: 'INTERNAL', message: 'Transaction conflict' } },
    })).toBe(false);
  });

  it('normalizes web and local jobs with stable scoped arguments', () => {
    const input = {
      schema_version: 1,
      collection_id: 'mixed-research',
      project_id: 'project-a',
      session_id: 'session-a',
      session_intent: 'Collect and compare evidence.',
      defaults: {
        search: { extract_mode: 'abstract', extract_limit: 3 },
        project_memory_search: { limit: 7 },
      },
      jobs: [
        'new external evidence',
        { tool: 'project_memory_search', query: 'stored evidence' },
        { tool: 'project_memory_search', query: 'all projects', arguments: { all_projects: true } },
        {
          id: 'record-plan',
          tool: 'project_memory',
          arguments: {
            action: 'record',
            record_type: 'plan',
            title: 'Evaluate evidence',
            body: 'Compare primary sources with stored results.',
          },
        },
        {
          id: 'export-lineage',
          tool: 'project_memory',
          arguments: { action: 'export', export_format: 'html', export_view: 'lineage' },
        },
      ],
    };

    const first = normalizeCollectionSpec(input);
    const second = normalizeCollectionSpec(input);

    expect(first.spec_hash).toBe(second.spec_hash);
    expect(first.jobs[0].arguments).toMatchObject({
      project_id: 'project-a', session_id: 'session-a', extract_mode: 'abstract', extract_limit: 3,
    });
    expect(first.jobs[1].arguments).toMatchObject({ project_id: 'project-a', limit: 7 });
    expect(first.jobs[2].arguments).toMatchObject({ all_projects: true });
    expect(first.jobs[2].arguments).not.toHaveProperty('project_id');
    expect(first.jobs[3]).toMatchObject({
      tool: 'project_memory',
      arguments: { action: 'record', record_type: 'plan', project_id: 'project-a' },
    });
    expect(first.jobs[3]).not.toHaveProperty('query');
    expect(first.jobs[4].arguments).toMatchObject({
      action: 'export', project_id: 'project-a', export_format: 'html', export_view: 'lineage',
    });
  });

  it('rejects destructive or incomplete project memory jobs', () => {
    expect(() => normalizeCollectionSpec({
      schema_version: 1,
      collection_id: 'unsafe-workflow',
      project_id: 'project-a',
      jobs: [{
        tool: 'project_memory',
        arguments: { action: 'forget', forget_mode: 'apply', confirm_token: '1234567890123456' },
      }],
    })).toThrow();
    expect(() => normalizeCollectionSpec({
      schema_version: 1,
      collection_id: 'invalid-plan',
      project_id: 'project-a',
      jobs: [{
        tool: 'project_memory',
        arguments: { action: 'record', record_type: 'plan', title: 'Missing body' },
      }],
    })).toThrow('body required');
  });

  it('rejects collection extraction limits with an actionable message', () => {
    expect(() => normalizeCollectionSpec({
      schema_version: 1,
      collection_id: 'invalid-extract-limit',
      defaults: { search: { extract_limit: 14 } },
      jobs: ['query'],
    })).toThrow(
      'extract_limit must be an integer between 1 and 10 for abstract search; received 14',
    );
  });

  it('runs project memory jobs without adding a query argument', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-collect-memory-'));
    roots.push(root);
    const output = join(root, 'results.jsonl');
    const spec = normalizeCollectionSpec({
      schema_version: 1,
      collection_id: 'memory-workflow',
      project_id: 'project-a',
      jobs: [{
        id: 'rebuild-project',
        tool: 'project_memory',
        arguments: { action: 'rebuild' },
      }],
    });
    const call = vi.fn(async () => ({ structuredContent: { ok: true } }));

    const result = await runCollection(spec, output, call, {});

    expect(result).toEqual({ completed: 1, skipped: 0, failed: 0 });
    expect(call).toHaveBeenCalledWith('project_memory', {
      action: 'rebuild', project_id: 'project-a',
    });
  });

  it('checkpoints each job, skips success, and retries failure on resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-collect-'));
    roots.push(root);
    const output = join(root, 'results.jsonl');
    const spec = normalizeCollectionSpec({
      schema_version: 1,
      collection_id: 'resume-test',
      project_id: 'project-a',
      on_error: 'continue',
      jobs: ['first query', 'second query'],
    });
    const firstCall = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      isError: args.query === 'second query',
      structuredContent: { query: args.query },
    }));

    const first = await runCollection(spec, output, firstCall, { package: 'test@1.0.0' });
    const secondCall = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      structuredContent: { query: args.query, retried: true },
    }));
    const second = await runCollection(spec, output, secondCall, { package: 'ignored' });
    const log = await readCollectionLog(output);

    expect(first).toEqual({ completed: 1, skipped: 0, failed: 1 });
    expect(second).toEqual({ completed: 1, skipped: 1, failed: 0 });
    expect(secondCall).toHaveBeenCalledOnce();
    expect(secondCall.mock.calls[0][1]).toMatchObject({ query: 'second query' });
    expect(log.latest.get(spec.jobs[1].id)).toMatchObject({ attempt: 2, is_error: false });
    expect(readFileSync(output, 'utf8').trim().split(/\r?\n/)).toHaveLength(4);
  });

  it('rejects an existing log created from a different spec', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-collect-hash-'));
    roots.push(root);
    const output = join(root, 'results.jsonl');
    const first = normalizeCollectionSpec({
      schema_version: 1, collection_id: 'hash-test', jobs: ['first'],
    });
    const changed = normalizeCollectionSpec({
      schema_version: 1, collection_id: 'hash-test', jobs: ['changed'],
    });
    const call = vi.fn(async () => ({ structuredContent: { ok: true } }));

    await runCollection(first, output, call, {});
    await expect(runCollection(changed, output, call, {}))
      .rejects.toThrow('spec hash does not match');
  });
});

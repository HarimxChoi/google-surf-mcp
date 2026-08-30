#!/usr/bin/env node
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { searchExtractLimitSchema } from './searchLimits.js';

const ToolSchema = z.enum(['search', 'project_memory_search', 'project_memory']);
const SearchToolSchema = z.enum(['search', 'project_memory_search']);
const SearchArgumentsSchema = z.object({
  project_id: z.string().min(1).max(64).optional(),
  include_project_ids: z.array(z.string().min(1).max(64)).max(20).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  extract_mode: z.enum(['none', 'abstract', 'full']).default('none'),
  extract_limit: searchExtractLimitSchema(),
  max_chars: z.number().int().min(200).max(50_000).optional(),
  response_content: z.enum(['summary', 'full']).default('full'),
}).strict();
const LocalArgumentsSchema = z.object({
  project_id: z.string().min(1).max(64).optional(),
  include_project_ids: z.array(z.string().min(1).max(64)).max(20).optional(),
  all_projects: z.boolean().optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();
const ProjectRecordArgumentsSchema = z.object({
  action: z.literal('record'),
  project_id: z.string().min(1).max(64).optional(),
  record_type: z.enum(['session', 'plan', 'experiment', 'decision', 'ontology']),
  memory_handle: z.string().uuid().optional(),
  intent: z.string().min(1).max(2_000).optional(),
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(50_000).optional(),
  change_reason: z.string().min(1).max(2_000).optional(),
  based_on_experiment_id: z.string().min(1).max(200).optional(),
  experiment_id: z.string().min(1).max(200).optional(),
  hypothesis: z.string().min(1).max(5_000).optional(),
  plan_revision_id: z.string().min(1).max(200).optional(),
  status: z.enum(['running', 'success', 'failed', 'inconclusive']).optional(),
  summary: z.string().min(1).max(10_000).optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  artifacts: z.array(z.string().max(2_000)).max(100).optional(),
  name: z.string().min(1).max(120).optional(),
  aliases: z.array(z.string().min(1).max(2_000)).min(1).max(50).optional(),
  ontology_kind: z.enum(['entity_type', 'relation']).optional(),
  version: z.number().int().min(1).optional(),
  supersedes_term_id: z.string().min(1).max(200).optional(),
}).strict().superRefine((value, context) => {
  const required = (condition: boolean, path: string, message: string): void => {
    if (!condition) context.addIssue({ code: 'custom', path: [path], message });
  };
  if (value.record_type === 'session') required(Boolean(value.intent), 'intent', 'intent required');
  if (value.record_type === 'plan') {
    required(Boolean(value.title), 'title', 'title required');
    required(Boolean(value.body), 'body', 'body required');
  }
  if (value.record_type === 'experiment') {
    if (value.status && value.status !== 'running') {
      required(Boolean(value.experiment_id), 'experiment_id', 'experiment_id required');
      required(Boolean(value.summary), 'summary', 'summary required');
    } else {
      required(Boolean(value.title), 'title', 'title required');
      required(Boolean(value.hypothesis), 'hypothesis', 'hypothesis required');
    }
  }
  if (value.record_type === 'decision') {
    required(Boolean(value.title), 'title', 'title required');
    required(Boolean(value.summary), 'summary', 'summary required');
  }
  if (value.record_type === 'ontology') {
    required(Boolean(value.name), 'name', 'name required');
    required(Boolean(value.ontology_kind), 'ontology_kind', 'ontology_kind required');
  }
});
const ProjectRebuildArgumentsSchema = z.object({
  action: z.literal('rebuild'),
  project_id: z.string().min(1).max(64).optional(),
  roots: z.array(z.object({
    label: z.string().min(1).max(32),
    path: z.string().min(1).max(2_000),
  }).strict()).min(1).max(8).optional(),
  git_root: z.string().min(1).max(2_000).optional(),
}).strict();
const ProjectExportArgumentsSchema = z.object({
  action: z.literal('export'),
  project_id: z.string().min(1).max(64).optional(),
  include_project_ids: z.array(z.string().min(1).max(64)).max(20).optional(),
  all_projects: z.boolean().optional(),
  export_format: z.enum(['dot', 'd3', 'html', 'neo4j']).default('d3'),
  export_view: z.enum(['graph', 'ontology', 'lineage']).default('graph'),
}).strict();
const ProjectMemoryArgumentsSchema = z.discriminatedUnion('action', [
  ProjectRecordArgumentsSchema,
  ProjectRebuildArgumentsSchema,
  ProjectExportArgumentsSchema,
]);
const JobSchema = z.union([
  z.string().min(1).max(400),
  z.object({
    id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
    tool: SearchToolSchema.optional(),
    query: z.string().min(1).max(400),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional(),
    tool: z.literal('project_memory'),
    arguments: z.record(z.string(), z.unknown()),
  }).strict(),
]);
const SpecSchema = z.object({
  schema_version: z.literal(1),
  collection_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
  project_id: z.string().min(1).max(64).optional(),
  project_name: z.string().min(1).max(120).optional(),
  session_id: z.string().min(1).max(128).optional(),
  session_intent: z.string().min(1).max(4_000).optional(),
  retrieval_mode: z.enum(['live', 'hybrid']).default('live'),
  default_tool: SearchToolSchema.default('search'),
  on_error: z.enum(['stop', 'continue']).default('stop'),
  output: z.string().min(1).optional(),
  defaults: z.object({
    search: z.record(z.string(), z.unknown()).optional(),
    project_memory_search: z.record(z.string(), z.unknown()).optional(),
    project_memory: z.record(z.string(), z.unknown()).optional(),
  }).strict().default({}),
  jobs: z.array(JobSchema).min(1),
}).strict();

export type CollectionTool = z.infer<typeof ToolSchema>;

export interface CollectionJob {
  id: string;
  tool: CollectionTool;
  query?: string;
  arguments: Record<string, unknown>;
}

export interface CollectionSpec {
  schema_version: 1;
  collection_id: string;
  project_id?: string;
  project_name?: string;
  session_id?: string;
  session_intent?: string;
  retrieval_mode: 'live' | 'hybrid';
  default_tool: z.infer<typeof SearchToolSchema>;
  on_error: 'stop' | 'continue';
  output?: string;
  jobs: CollectionJob[];
  spec_hash: string;
}

interface CollectionManifest {
  type: 'manifest';
  schema_version: 1;
  spec_hash: string;
  created_at: string;
  collection: Omit<CollectionSpec, 'output' | 'spec_hash'>;
  runtime: Record<string, unknown>;
}

interface CollectionResult {
  type: 'result';
  job_id: string;
  attempt: number;
  tool: CollectionTool;
  query?: string;
  arguments: Record<string, unknown>;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  is_error: boolean;
  result?: unknown;
  exception?: { name: string; message: string };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sorted(child)]));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

export function normalizeCollectionSpec(input: unknown): CollectionSpec {
  const parsed = SpecSchema.parse(input);
  const jobs = parsed.jobs.map((entry) => {
    const raw = typeof entry === 'string' ? { query: entry } : entry;
    const tool = raw.tool ?? parsed.default_tool;
    const rawQuery = 'query' in raw ? raw.query : undefined;
    const defaults = parsed.defaults[tool] ?? {};
    const combined = { ...defaults, ...(raw.arguments ?? {}) };
    let args: Record<string, unknown>;
    let query: string | undefined;
    if (tool === 'search') {
      if (!rawQuery) throw new Error('search requires query');
      args = SearchArgumentsSchema.parse(combined);
      args.project_id ??= parsed.project_id;
      if (!args.project_id) delete args.project_id;
      if (parsed.session_id) args.session_id = parsed.session_id;
      if (parsed.session_intent) args.session_intent = parsed.session_intent;
      query = rawQuery;
    } else if (tool === 'project_memory_search') {
      if (!rawQuery) throw new Error('project_memory_search requires query');
      args = LocalArgumentsSchema.parse(combined);
      args.project_id ??= parsed.project_id;
      if (args.all_projects) {
        delete args.project_id;
        delete args.include_project_ids;
      } else if (!args.project_id) {
        throw new Error(`project_memory_search requires project_id or all_projects=true: ${rawQuery}`);
      }
      query = rawQuery;
    } else {
      args = ProjectMemoryArgumentsSchema.parse(combined);
      if (args.action === 'export' && args.all_projects) {
        delete args.project_id;
        delete args.include_project_ids;
      } else {
        args.project_id ??= parsed.project_id;
      }
      if (!args.project_id && !(args.action === 'export' && args.all_projects)) {
        throw new Error(`project_memory ${args.action} requires project_id`);
      }
    }
    const identity = { tool, ...(query ? { query } : {}), arguments: args };
    return {
      id: raw.id ?? digest(identity).slice(0, 20),
      ...identity,
    };
  });
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error(`duplicate collection job id: ${job.id}`);
    ids.add(job.id);
  }
  const base = {
    schema_version: 1 as const,
    collection_id: parsed.collection_id,
    project_id: parsed.project_id,
    project_name: parsed.project_name,
    session_id: parsed.session_id,
    session_intent: parsed.session_intent,
    retrieval_mode: parsed.retrieval_mode,
    default_tool: parsed.default_tool,
    on_error: parsed.on_error,
    jobs,
  };
  return {
    ...base,
    output: parsed.output,
    spec_hash: digest(base),
  };
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flush: true });
}

export async function readCollectionLog(path: string): Promise<{
  manifest?: CollectionManifest;
  latest: Map<string, CollectionResult>;
  attempts: Map<string, number>;
}> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { latest: new Map(), attempts: new Map() };
    }
    throw error;
  }
  let manifest: CollectionManifest | undefined;
  const latest = new Map<string, CollectionResult>();
  const attempts = new Map<string, number>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record: CollectionManifest | CollectionResult;
    try {
      record = JSON.parse(line) as CollectionManifest | CollectionResult;
    } catch {
      throw new Error(`invalid JSONL record at line ${index + 1}: ${path}`);
    }
    if (record.type === 'manifest') {
      if (manifest) throw new Error(`duplicate collection manifest: ${path}`);
      manifest = record;
      continue;
    }
    latest.set(record.job_id, record);
    attempts.set(record.job_id, Math.max(attempts.get(record.job_id) ?? 0, record.attempt));
  }
  return { manifest, latest, attempts };
}

export async function runCollection(
  spec: CollectionSpec,
  outputPath: string,
  callTool: (name: CollectionTool, args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    structuredContent?: unknown;
    content?: unknown;
  }>,
  runtime: Record<string, unknown>,
  progress: (message: string) => void = () => {},
): Promise<{ completed: number; skipped: number; failed: number }> {
  await mkdir(dirname(outputPath), { recursive: true });
  const checkpoint = await readCollectionLog(outputPath);
  if (checkpoint.manifest && checkpoint.manifest.spec_hash !== spec.spec_hash) {
    throw new Error(`collection spec hash does not match existing output: ${outputPath}`);
  }
  if (!checkpoint.manifest) {
    const { output: _output, spec_hash: _specHash, ...collection } = spec;
    await appendJsonLine(outputPath, {
      type: 'manifest',
      schema_version: 1,
      spec_hash: spec.spec_hash,
      created_at: new Date().toISOString(),
      collection,
      runtime,
    } satisfies CollectionManifest);
  }
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (const [index, job] of spec.jobs.entries()) {
    if (checkpoint.latest.get(job.id)?.is_error === false) {
      skipped++;
      progress(`[${index + 1}/${spec.jobs.length}] skip ${job.id}`);
      continue;
    }
    const subject = job.query ?? `${job.arguments.action}${job.arguments.record_type
      ? `:${job.arguments.record_type}` : ''}`;
    progress(`[${index + 1}/${spec.jobs.length}] ${job.tool} ${subject}`);
    const startedAt = new Date();
    const started = Date.now();
    const attempt = (checkpoint.attempts.get(job.id) ?? 0) + 1;
    let record: CollectionResult;
    try {
      const response = await callTool(job.tool, {
        ...(job.query ? { query: job.query } : {}),
        ...job.arguments,
      });
      record = {
        type: 'result',
        job_id: job.id,
        attempt,
        tool: job.tool,
        ...(job.query ? { query: job.query } : {}),
        arguments: job.arguments,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        elapsed_ms: Date.now() - started,
        is_error: response.isError ?? false,
        result: response.structuredContent ?? response.content,
      };
    } catch (error) {
      record = {
        type: 'result',
        job_id: job.id,
        attempt,
        tool: job.tool,
        ...(job.query ? { query: job.query } : {}),
        arguments: job.arguments,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        elapsed_ms: Date.now() - started,
        is_error: true,
        exception: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    await appendJsonLine(outputPath, record);
    checkpoint.latest.set(job.id, record);
    checkpoint.attempts.set(job.id, attempt);
    if (record.is_error) {
      failed++;
      if (spec.on_error === 'stop') break;
    } else {
      completed++;
    }
  }
  return { completed, skipped, failed };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function gitCommit(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function normalizeMcpResponse(response: Record<string, unknown>): {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
} {
  if ('toolResult' in response) return { structuredContent: response.toolResult };
  return {
    isError: response.isError as boolean | undefined,
    structuredContent: response.structuredContent,
    content: response.content,
  };
}

export function isMissingProjectResponse(response: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}): boolean {
  if (!response.isError) return false;
  const detail = JSON.stringify(response.structuredContent ?? response.content ?? '');
  return /project not found/i.test(detail);
}

async function ensureCollectionProject(
  client: Client,
  spec: CollectionSpec,
): Promise<Record<string, unknown> | undefined> {
  if (!spec.project_id) return undefined;
  const shown = normalizeMcpResponse(await client.callTool({
    name: 'project_memory',
    arguments: { action: 'show', project_id: spec.project_id },
  }) as Record<string, unknown>);
  if (!shown.isError) return { status: 'existing', project_id: spec.project_id };
  if (!isMissingProjectResponse(shown)) {
    throw new Error(`failed to inspect project: ${JSON.stringify(shown.structuredContent ?? shown.content)}`);
  }
  if (!spec.project_name) {
    throw new Error(`project not found and project_name is missing: ${spec.project_id}`);
  }
  const created = normalizeMcpResponse(await client.callTool({
    name: 'project_memory',
    arguments: { action: 'create', project_id: spec.project_id, name: spec.project_name },
  }) as Record<string, unknown>);
  if (created.isError) {
    throw new Error(`failed to create project: ${JSON.stringify(created.structuredContent)}`);
  }
  return { status: 'created', project_id: spec.project_id, name: spec.project_name };
}

async function main(): Promise<void> {
  const specArg = process.argv[2];
  if (!specArg) throw new Error('usage: google-surf-collect <spec.json> [output.jsonl]');
  const specPath = resolve(specArg);
  const spec = normalizeCollectionSpec(JSON.parse(await readFile(specPath, 'utf8')));
  const outputPath = resolve(
    dirname(specPath),
    process.argv[3] ?? spec.output ?? `${spec.collection_id}.results.jsonl`,
  );
  const serverPath = fileURLToPath(new URL('./index.js', import.meta.url));
  const packageRoot = resolve(dirname(serverPath), '..');
  const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const client = new Client({ name: 'google-surf-collector', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: packageRoot,
    env: {
      ...inheritedEnvironment(),
      SURF_RESEARCH: 'true',
      SURF_RETRIEVAL_MODE: spec.retrieval_mode,
    },
    stderr: 'pipe',
  });
  transport.stderr?.pipe(process.stderr);
  try {
    await client.connect(transport);
    const health = await client.callTool({ name: 'health', arguments: {} });
    const projectSetup = await ensureCollectionProject(client, spec);
    const summary = await runCollection(
      spec,
      outputPath,
      async (name, args) => {
        return normalizeMcpResponse(await client.callTool({
          name, arguments: args,
        }) as Record<string, unknown>);
      },
      {
        package: `${pkg.name}@${pkg.version}`,
        git_commit: gitCommit(packageRoot),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        project_setup: projectSetup,
        health: health.structuredContent ?? health.content,
      },
      (message) => process.stderr.write(`${message}\n`),
    );
    process.stdout.write(`${JSON.stringify({ output: outputPath, ...summary })}\n`);
  } finally {
    await transport.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

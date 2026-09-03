#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = mkdtempSync(join(tmpdir(), 'surf-mcp-smoke-'));
const source = mkdtempSync(join(tmpdir(), 'surf-mcp-source-'));
mkdirSync(join(source, 'src'));
writeFileSync(join(source, 'src', 'probe.ts'), 'export const smoke_index_token = 1;');
const baseEnv = {
  SURF_CLOUD_MODE: 'true',
  SURF_SEARCH_PROVIDER: 'searchapi',
  SURF_SCHOLAR_PROVIDER: 'searchapi',
  SURF_RESEARCH_VECTOR_MODEL: 'off',
  SURF_RESEARCH_BROKER_IDLE_MS: '100',
};
const offClient = new Client({ name: 'google-surf-smoke-off', version: '1.0.0' });
const offTransport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/cli.js'],
  cwd: process.cwd(),
  env: { ...baseEnv, SURF_RESEARCH: 'false' },
  stderr: 'pipe',
});
try {
  await offClient.connect(offTransport);
  const listed = await offClient.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    'extract', 'health', 'scholar_search', 'search', 'search_parallel',
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('research-off tool list mismatch');
  }
  const descriptions = new Map(listed.tools.map((tool) => [tool.name, tool.description ?? '']));
  const requiredDescriptions = {
    search: 'PRIMARY SINGLE-QUERY LIVE DISCOVERY AND CONTENT INGESTION TOOL',
    search_parallel: 'PRIMARY MULTI-QUERY LIVE DISCOVERY AND CONTENT INGESTION TOOL',
    extract: 'SECONDARY KNOWN-URL CONTENT EXTRACTION TOOL',
    scholar_search: 'Do not use',
  };
  for (const [name, phrase] of Object.entries(requiredDescriptions)) {
    if (!descriptions.get(name)?.includes(phrase)) {
      throw new Error(`${name} routing description mismatch`);
    }
  }
  const expectedTitles = {
    search: 'Web Search and Extract',
    search_parallel: 'Parallel Web Search and Extract',
    extract: 'Known URL Extract',
  };
  for (const [name, title] of Object.entries(expectedTitles)) {
    if (listed.tools.find((tool) => tool.name === name)?.title !== title) {
      throw new Error(`${name} routing title mismatch`);
    }
  }
  for (const name of ['search', 'search_parallel']) {
    const description = descriptions.get(name) ?? '';
    for (const phrase of [
      'set extract_mode=abstract or full in this call',
      'Select extract_mode=full, not abstract',
      'Do not download public PDFs, clone repositories, or invoke local parsers first',
      'Use extract separately only when the exact public URL is already known',
      'editing, building, testing, or full Git history',
    ]) {
      if (!description.includes(phrase)) throw new Error(`${name} routing hierarchy mismatch`);
    }
  }
  const extractDescription = descriptions.get('extract') ?? '';
  for (const phrase of [
    'no new web discovery is required',
    'use search or search_parallel with extract_mode instead',
    'Local PDF tools are for local files, forms, OCR recovery, or visual layout inspection',
  ]) {
    if (!extractDescription.includes(phrase)) throw new Error('extract routing hierarchy mismatch');
  }
  for (const name of ['search', 'search_parallel']) {
    const description = listed.tools.find((tool) => tool.name === name)?.description ?? '';
    const properties = listed.tools.find((tool) => tool.name === name)?.inputSchema?.properties ?? {};
    if (!('extract_mode' in properties) || 'project_id' in properties || 'retrieval_mode' in properties) {
      throw new Error(`${name} default schema mismatch`);
    }
    if (properties.max_chars?.maximum !== 50_000) {
      throw new Error(`${name} extraction limit mismatch`);
    }
    if (properties.limit?.minimum !== 1 || properties.limit?.maximum !== 20) {
      throw new Error(`${name} result limit contract mismatch`);
    }
    const expectedExtractMax = name === 'search_parallel' ? 20 : 10;
    const expectedResponseDefault = 'summary';
    if (properties.extract_limit?.minimum !== 1
      || properties.extract_limit?.maximum !== expectedExtractMax
      || (name === 'search' && properties.extract_limit?.default !== 5)
      || properties.response_content?.default !== expectedResponseDefault
      || !description.includes(name === 'search_parallel'
        ? 'extract_limit accepts 1-20 with default 12 for abstract, and 1-10 with default 10 for full'
        : 'extract_limit accepts integers from 1 to 10')) {
      throw new Error(`${name} extract_limit contract mismatch`);
    }
  }
  const parallel = listed.tools.find((tool) => tool.name === 'search_parallel');
  if (parallel?.inputSchema?.properties?.queries?.minItems !== 2
    || parallel?.inputSchema?.properties?.queries?.maxItems !== 12) {
    throw new Error('search_parallel query count contract mismatch');
  }
  const invalidLimit = await offClient.callTool({
    name: 'search_parallel',
    arguments: { queries: ['one', 'two'], extract_mode: 'full', extract_limit: 11 },
  });
  const invalidLimitText = invalidLimit.content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
  if (!invalidLimit.isError || !invalidLimitText.includes(
    'extract_limit must be an integer between 1 and 10 for full parallel; received 11',
  )) throw new Error('search_parallel extract_limit error contract mismatch');
} finally {
  await offTransport.close();
}
const client = new Client({ name: 'google-surf-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['build/cli.js'],
  cwd: process.cwd(),
  env: {
    ...baseEnv,
    SURF_RESEARCH_ROOT: root,
  },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    'extract', 'health', 'project_memory', 'project_memory_search', 'scholar_search',
    'search', 'search_parallel',
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('tool list mismatch');
  for (const name of ['search', 'search_parallel']) {
    const properties = listed.tools.find((tool) => tool.name === name)?.inputSchema?.properties ?? {};
    if (!('extract_mode' in properties) || !('project_id' in properties) || 'retrieval_mode' in properties) {
      throw new Error(`${name} schema routing mismatch`);
    }
  }
  const memoryAction = listed.tools.find((tool) => tool.name === 'project_memory')
    ?.inputSchema?.properties?.action?.description ?? '';
  if (!memoryAction.includes('create: project_id and name required')) {
    throw new Error('project_memory action contract missing');
  }
  const memoryProperties = listed.tools.find((tool) => tool.name === 'project_memory')
    ?.inputSchema?.properties ?? {};
  if (!memoryProperties.action?.enum?.includes('search')
    || !memoryProperties.action?.enum?.includes('export')
    || !('query' in memoryProperties) || !('limit' in memoryProperties)
    || !('export_format' in memoryProperties) || !('export_view' in memoryProperties)
    || !memoryProperties.export_format?.enum?.includes('html')
    || !memoryProperties.export_format?.enum?.includes('neo4j')
    || !('all_projects' in memoryProperties)
    || memoryProperties.detail_level?.default !== 'summary') {
    throw new Error('project_memory visualization contract missing');
  }
  const memoryDescription = listed.tools.find((tool) => tool.name === 'project_memory')
    ?.description ?? '';
  const brokerPhrase = 'multiple MCP sessions query the same knowledge base concurrently';
  for (const name of [
    'search', 'search_parallel', 'scholar_search', 'extract', 'project_memory_search', 'project_memory',
  ]) {
    const description = listed.tools.find((tool) => tool.name === name)?.description ?? '';
    if (!description.includes(brokerPhrase)) throw new Error(`${name} shared broker description missing`);
  }
  for (const phrase of [
    'PROJECT MEMORY MANAGEMENT', 'compatibility alias', 'project_memory_search',
    'session intent', 'immutable plan revisions',
    'versioned ontology', 'bitemporal data lineage', 'entity merge or split',
    'rebuild', 'export', 'interactive HTML', 'Graphviz DOT', 'D3 JSON', 'Neo4j', 'forget',
    'search_parallel', 'scholar_search', 'extract',
  ]) {
    if (!memoryDescription.includes(phrase)) {
      throw new Error(`project_memory description missing: ${phrase}`);
    }
  }
  const searchDescription = listed.tools.find((tool) => tool.name === 'search')
    ?.description ?? '';
  for (const phrase of [
    'ALWAYS PERFORMS LIVE WEB SEARCH', 'project_memory_search',
    'live web', 'exact', 'BM25', 'vector', 'code', 'graph',
    'prior searches', 'data lineage', 'versioned ontology', 'schema/entity links',
  ]) {
    if (!searchDescription.includes(phrase)) {
      throw new Error(`search research description missing: ${phrase}`);
    }
  }
  const localSearchTool = listed.tools.find((tool) => tool.name === 'project_memory_search');
  const localSearchProperties = localSearchTool?.inputSchema?.properties ?? {};
  if (!('query' in localSearchProperties) || !('limit' in localSearchProperties)
    || !('query_variants' in localSearchProperties)
    || localSearchProperties.query_variants?.maxItems !== 19
    || !('project_id' in localSearchProperties) || !('include_project_ids' in localSearchProperties)
    || !('all_projects' in localSearchProperties)
    || localSearchTool?.annotations?.readOnlyHint !== true
    || localSearchTool?.annotations?.idempotentHint !== true
    || localSearchTool?.annotations?.openWorldHint !== false) {
    throw new Error('project_memory_search contract missing');
  }
  for (const phrase of [
    'LOCAL PROJECT KNOWLEDGE SEARCH ONLY', 'exact, BM25, vector, and graph',
    'query_variants', 'one call', 'batched', 'RRF', 'reranked once',
    'never opens Google', 'new external information',
  ]) {
    if (!localSearchTool?.description?.includes(phrase)) {
      throw new Error(`project_memory_search description missing: ${phrase}`);
    }
  }

  const created = await client.callTool({
    name: 'project_memory',
    arguments: { action: 'create', project_id: 'smoke', name: 'Smoke project' },
  });
  if (created.isError) throw new Error('project create failed');
  const planned = await client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'record',
      record_type: 'plan',
      project_id: 'smoke',
      title: 'Smoke plan',
      body: 'Validate MCP schemas.',
    },
  });
  if (planned.isError
    || JSON.stringify(planned.structuredContent).includes('Validate MCP schemas.')) {
    throw new Error('plan compact receipt failed');
  }
  const detail = await client.callTool({
    name: 'project_memory',
    arguments: { action: 'show', project_id: 'smoke' },
  });
  if (detail.isError
    || detail.structuredContent?.search_event_count !== 0
    || detail.structuredContent?.plan_count !== 1
    || detail.structuredContent?.plans !== undefined) {
    throw new Error(`project compact show failed: ${JSON.stringify({
      is_error: detail.isError ?? false,
      error: detail.structuredContent?.error,
      search_event_count: detail.structuredContent?.search_event_count,
      plan_count: detail.structuredContent?.plan_count,
      has_plans: detail.structuredContent?.plans !== undefined,
    })}`);
  }
  const indexed = await client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'rebuild',
      project_id: 'smoke',
      roots: [{ label: 'repo', path: source }],
    },
  });
  if (indexed.isError || indexed.structuredContent?.index?.added_count !== 1) {
    throw new Error('project index failed');
  }
  const reused = await client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'rebuild',
      project_id: 'smoke',
      roots: [{ label: 'repo', path: source }],
    },
  });
  if (reused.isError || reused.structuredContent?.index?.reused !== true) {
    throw new Error('project index reuse failed');
  }
  const localSearch = await client.callTool({
    name: 'project_memory_search',
    arguments: {
      project_id: 'smoke',
      query: 'smoke_index_token',
      query_variants: ['probe.ts', 'smoke code source'],
      limit: 5,
    },
  });
  if (localSearch.isError
    || localSearch.structuredContent?.results?.[0]?.source_family !== 'code'
    || localSearch.structuredContent?.meta?.provider !== 'local'
    || localSearch.structuredContent?.meta?.query_count !== 3
    || localSearch.structuredContent?.meta?.query_execution !== 'single_broker_request'
    || localSearch.structuredContent?.meta?.live_web_used !== false) {
    throw new Error('project local search failed');
  }
  const afterSearch = await client.callTool({
    name: 'project_memory',
    arguments: { action: 'show', project_id: 'smoke' },
  });
  if (afterSearch.isError || afterSearch.structuredContent?.search_event_count !== 0) {
    throw new Error('project local search mutated search history');
  }
  const visualization = await client.callTool({
    name: 'project_memory',
    arguments: {
      action: 'export',
      project_id: 'smoke',
      export_format: 'neo4j',
      export_view: 'lineage',
    },
  });
  if (visualization.isError
    || typeof visualization.structuredContent?.visualization?.path !== 'string'
    || visualization.structuredContent.visualization.node_count < 1) {
    throw new Error('project visualization export failed');
  }
  let forgotten;
  for (let attempt = 0; attempt < 5; attempt++) {
    const preview = await client.callTool({
      name: 'project_memory',
      arguments: { action: 'forget', project_id: 'smoke', forget_mode: 'preview' },
    });
    const confirmToken = preview.structuredContent?.forget?.confirm_token;
    if (preview.isError || typeof confirmToken !== 'string') {
      throw new Error('project forget preview failed');
    }
    forgotten = await client.callTool({
      name: 'project_memory',
      arguments: {
        action: 'forget',
        project_id: 'smoke',
        forget_mode: 'apply',
        confirm_token: confirmToken,
      },
    });
    if (!forgotten.isError) break;
    if (forgotten.structuredContent?.error?.message !== 'forget confirmation expired') break;
  }
  if (!forgotten || forgotten.isError) {
    throw new Error(`project forget failed: ${JSON.stringify(forgotten?.structuredContent)}`);
  }
  const restored = await client.callTool({
    name: 'project_memory',
    arguments: { action: 'forget', project_id: 'smoke', forget_mode: 'restore' },
  });
  if (restored.isError) throw new Error('project restore failed');
  console.log('MCP smoke passed');
} finally {
  let brokerPid;
  try {
    brokerPid = JSON.parse(readFileSync(join(root, 'broker', 'owner', 'owner.json'), 'utf8')).pid;
  } catch {}
  await transport.close();
  const brokerAlive = () => {
    if (!brokerPid) return false;
    try {
      process.kill(brokerPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 200 && brokerAlive(); attempt++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  if (brokerAlive()) throw new Error('research broker did not stop');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  rmSync(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  rmSync(source, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

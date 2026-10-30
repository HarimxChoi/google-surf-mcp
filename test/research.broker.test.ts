import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSharedResearchService,
  researchBrokerDirectory,
} from '../src/research/broker.js';
import type { ResearchService } from '../src/research/service.js';

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

describe('research broker', () => {
  let root: string | undefined;
  const services: ResearchService[] = [];

  afterEach(async () => {
    let ownerPid: number | undefined;
    if (root) {
      try {
        const owner = JSON.parse(await readFile(
          resolve(researchBrokerDirectory(root), 'owner', 'owner.json'),
          'utf8',
        )) as { pid: number };
        ownerPid = owner.pid;
      } catch {}
    }
    await Promise.all(services.splice(0).map(async (service) => await service.close()));
    if (!root) return;
    if (ownerPid) {
      await waitUntil(() => {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch {
          return true;
        }
      }, 15_000);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    root = undefined;
  }, 20_000);

  it('shares one embedded database across concurrent MCP clients', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-'));
    const options = { enabled: true, root, vectorModel: '' };
    const clientOptions = {
      idleMs: 100,
      processPath: resolve('build/research/brokerProcess.js'),
    };
    const clients = Array.from({ length: 5 }, () => createSharedResearchService(options, clientOptions));
    services.push(...clients);

    await Promise.all(clients.map(async (client, index) => (
      await client.createProject(`Broker ${index}`, `broker-${index}`)
    )));

    const [projectLists, detail] = await Promise.all([
      Promise.all(clients.map(async (client) => await client.listProjects())),
      clients[0].getProject('broker-4'),
    ]);
    for (const projects of projectLists) {
      expect(projects.map((project) => project.project_id)).toEqual(expect.arrayContaining([
        'broker-0', 'broker-1', 'broker-2', 'broker-3', 'broker-4',
      ]));
    }
    expect(detail.project.project_id).toBe('broker-4');
    await clients[0].writeCatalogRecord({
      project_id: 'broker-0', kind: 'document', operation: 'create',
      asset_id: 'broker-metadata', idempotency_key: 'broker-metadata-v1',
      body: 'broker-body', fields: { title: 'Broker metadata' },
    });
    const metadata = await clients[1].getCatalogRecord(
      'broker-0', 'broker-metadata', undefined, 0, 0,
    );
    expect('legacy' in metadata).toBe(false);
    if ('legacy' in metadata) throw new Error('unexpected legacy record');
    expect(metadata.body).toBeUndefined();
    expect(metadata.body_span).toEqual({ start: 0, end: 0, total_bytes: 11 });
    expect(clients.every((client) => client.status().state === 'ready')).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(clients[0].search(
      'broker-0',
      'cancelled query',
      10,
      [],
      controller.signal,
    )).rejects.toThrow('research search cancelled');

    const owner = JSON.parse(await readFile(
      resolve(researchBrokerDirectory(root), 'owner', 'owner.json'),
      'utf8',
    )) as { pid: number };
    expect(owner.pid).toBeGreaterThan(0);
  }, 30_000);

  it('reclaims its read slot after a real native query outlives the partial response', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-native-deadline-'));
    const service = createSharedResearchService({ enabled: true, root, vectorModel: '' }, {
      idleMs: 100, readConcurrency: 1,
      processPath: resolve('test/fixtures/research-delayed-broker.mjs'),
    });
    services.push(service);
    await service.createProject('Native deadline', 'native-deadline');
    const result = await service.searchBatch('native-deadline', 'native-deadline-fixture', [], 5, [], undefined,
      { retrieval_lanes: ['exact', 'bm25'] }, false, false, 'native-timeout', 1_000);
    expect(result).toMatchObject({ partial: true, completed_lanes: ['bm25'], degraded_lanes: ['exact'] });
    const status = await service.passiveStatus();
    expect(status.broker).toMatchObject({ active_reads: 1 });
    expect(status.background_jobs).toBeGreaterThan(0);
    const next = await service.searchBatch('native-deadline', 'next-query', [], 5, [], undefined,
      { retrieval_lanes: ['exact'] }, false, false, 'after-native');
    expect(next).toMatchObject({ partial: false, completed_lanes: ['exact'] });
    const drained = await service.passiveStatus();
    expect(drained.broker).toMatchObject({ active_reads: 0 });
    expect(drained.background_jobs).toBe(0);
  }, 20_000);

  it('keeps a coalesced search alive when one subscriber cancels', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-coalesce-'));
    const options = { enabled: true, root, vectorModel: '' };
    const clientOptions = {
      idleMs: 10_000,
      processPath: resolve('build/research/brokerProcess.js'),
    };
    const first = createSharedResearchService(options, clientOptions);
    const second = createSharedResearchService(options, clientOptions);
    services.push(first, second);
    await first.createProject('Coalesced', 'coalesced');
    await first.capture({
      tool: 'extract', project_id: 'coalesced',
      payload: {
        title: 'Coalesced evidence', url: 'https://example.com/coalesced',
        content: `${'shared calculation evidence '.repeat(1_000)}coalesced_search_token`,
        extraction_quality: 'full_text',
      },
    });
    await Promise.all([first.listProjects(), second.listProjects()]);
    const groups = Array.from({ length: 20 }, (_, index) => ({
      id: `group-${index}`, query: 'coalesced_search_token',
      query_variants: ['shared calculation evidence'], limit: 5,
    }));
    const controller = new AbortController();
    const filters = { retrieval_lanes: ['bm25' as const] };
    const cancelled = first.searchGrouped('coalesced', groups, [], controller.signal, filters);
    const retained = second.searchGrouped('coalesced', groups, [], undefined, filters);
    setTimeout(() => controller.abort(), 10);

    await expect(cancelled).rejects.toThrow('research search cancelled');
    expect(await retained).toHaveLength(20);
    const status = await second.passiveStatus() as Awaited<ReturnType<ResearchService['passiveStatus']>> & {
      broker: { coalesced_read_hits: number };
    };
    expect(status.broker.coalesced_read_hits).toBeGreaterThan(0);
  }, 30_000);

  it('reports broker diagnostics without opening the database', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-passive-'));
    const service = createSharedResearchService(
      { enabled: true, root, vectorModel: '' },
      { idleMs: 100, processPath: resolve('build/research/brokerProcess.js') },
    );
    services.push(service);

    const status = await service.passiveStatus() as Awaited<ReturnType<ResearchService['passiveStatus']>> & {
      broker: {
        connected_clients: number;
        active_requests: number;
        recycle_eligible: boolean;
        recycle_blockers: string[];
        background_ownership: { checkpoint_drain_requested: boolean };
      };
    };

    expect(status).toMatchObject({
      passive: true,
      state: 'idle',
      database_open: false,
      background_jobs: 0,
      capabilities: { passive_health_opens_database: false, vector_index: 'hnsw' },
      process: { process_class: 'research_broker' },
    });
    expect(status.process.pid).toBeGreaterThan(0);
    expect(status.process.rss_bytes).toBeGreaterThan(0);
    expect(status.capabilities.embedding).toMatchObject({ loaded: false, cached_vectors: 0 });
    expect(status.capabilities.storage_cache_budgets?.SURREAL_HNSW_CACHE_SIZE).toBe(String(128 * 1024 * 1024));
    expect(status.broker.connected_clients).toBe(1);
    expect(status.broker.active_requests).toBe(0);
    expect(status.broker.recycle_eligible).toBe(true);
    expect(status.broker.recycle_blockers).toEqual([]);
    expect(status.broker.background_ownership.checkpoint_drain_requested).toBe(false);
  }, 20_000);

  it('drains while clients remain connected and reconnects on the next request', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-drain-'));
    const service = createSharedResearchService(
      { enabled: true, root, vectorModel: '' },
      { idleMs: 150, processPath: resolve('build/research/brokerProcess.js') },
    );
    services.push(service);
    await service.createProject('Drain', 'drain');
    const ownerPath = resolve(researchBrokerDirectory(root), 'owner', 'owner.json');
    const first = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };

    await waitUntil(() => {
      try {
        process.kill(first.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15_000);

    expect((await service.listProjects()).map((project) => project.project_id)).toContain('drain');
    const second = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
    expect(second.pid).not.toBe(first.pid);
  }, 30_000);

  it('does not drain the database owner while background indexing is active', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-background-'));
    const source = await mkdtemp(resolve(tmpdir(), 'surf-broker-background-src-'));
    const service = createSharedResearchService(
      { enabled: true, root, vectorModel: '' },
      { idleMs: 100, processPath: resolve('build/research/brokerProcess.js') },
    );
    services.push(service);
    try {
      await mkdir(join(source, 'src'));
      await Promise.all(Array.from({ length: 260 }, async (_value, index) => {
        await writeFile(
          join(source, 'src', `module-${index}.ts`),
          `export function module${index}() { return ${index}; }\n`,
        );
      }));
      await service.createProject('Background drain', 'background-drain');
      await service.indexProject({
        project_id: 'background-drain', roots: [{ label: 'repo', path: source }],
      });
      const ownerPath = resolve(researchBrokerDirectory(root), 'owner', 'owner.json');
      const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
      const status = await service.passiveStatus();

      expect(status.background_jobs).toBeGreaterThan(0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      expect(() => process.kill(owner.pid, 0)).not.toThrow();
    } finally {
      await rm(source, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 30_000);

  it('recycles under memory pressure without losing a committed catalog body', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-memory-pressure-'));
    const service = createSharedResearchService(
      { enabled: true, root, vectorModel: '' },
      { idleMs: 60_000, workerSoftMemoryBytes: 1, processPath: resolve('build/research/brokerProcess.js') },
    );
    services.push(service);
    await service.createProject('Memory pressure', 'memory-pressure');
    await service.writeCatalogRecord({
      project_id: 'memory-pressure', kind: 'document', operation: 'create',
      asset_id: 'pressure-document', idempotency_key: 'pressure-document-v1',
      body: 'Committed evidence survives worker recycling.', fields: { title: 'Pressure evidence' },
    });
    const ownerPath = resolve(researchBrokerDirectory(root), 'owner', 'owner.json');
    const first = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
    await waitUntil(() => {
      try { process.kill(first.pid, 0); return false; } catch { return true; }
    }, 15_000);

    const record = await service.getCatalogRecord('memory-pressure', 'pressure-document');
    expect(record.body).toBe('Committed evidence survives worker recycling.');
    const second = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
    expect(second.pid).not.toBe(first.pid);
  }, 30_000);

  it('detects memory pressure without another client request', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-broker-passive-pressure-'));
    const service = createSharedResearchService(
      { enabled: true, root, vectorModel: '' },
      { idleMs: 60_000, workerSoftMemoryBytes: 1024 ** 3,
        processPath: resolve('test/fixtures/research-pressure-broker.mjs') },
    );
    services.push(service);
    await service.createProject('Passive pressure', 'passive-pressure');
    const ownerPath = resolve(researchBrokerDirectory(root), 'owner', 'owner.json');
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number };
    await writeFile(join(root, 'pressure-on'), '');
    await waitUntil(() => {
      try { process.kill(owner.pid, 0); return false; } catch { return true; }
    }, 10_000);
  }, 20_000);
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
    expect(clients.every((client) => client.status().state === 'ready')).toBe(true);

    const owner = JSON.parse(await readFile(
      resolve(researchBrokerDirectory(root), 'owner', 'owner.json'),
      'utf8',
    )) as { pid: number };
    expect(owner.pid).toBeGreaterThan(0);
  }, 30_000);
});

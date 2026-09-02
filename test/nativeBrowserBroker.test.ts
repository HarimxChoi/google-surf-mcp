import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSharedNativeBrowser,
  nativeBrowserBrokerDirectory,
  type SharedNativeBrowser,
} from '../src/nativeBrowserBroker.js';

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

describe('native browser broker', () => {
  let root: string | undefined;
  const clients: SharedNativeBrowser[] = [];

  afterEach(async () => {
    let ownerPid: number | undefined;
    if (root) {
      try {
        const owner = JSON.parse(await readFile(resolve(
          nativeBrowserBrokerDirectory(resolve(root, 'native')),
          'owner',
          'owner.json',
        ), 'utf8')) as { pid: number };
        ownerPid = owner.pid;
      } catch {}
    }
    await Promise.all(clients.splice(0).map(async (client) => await client.close()));
    if (!root) return;
    if (ownerPid) {
      await waitUntil(() => {
        try {
          process.kill(ownerPid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 15_000);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    root = undefined;
  }, 20_000);

  it('shares one native browser owner across MCP clients', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'surf-native-broker-'));
    const profileDir = resolve(root, 'native');
    const options = {
      executablePath: process.execPath,
      profileDir,
      idleMs: 100,
      selfHealingEnabled: false,
      selfHealingFile: resolve(root, 'healing.json'),
    };
    const clientOptions = { processPath: resolve('build/nativeBrowserBrokerProcess.js') };
    clients.push(...Array.from({ length: 2 }, () => createSharedNativeBrowser(options, clientOptions)));

    const statuses = await Promise.all(clients.map(async (client) => await client.probe()));

    expect(new Set(statuses.map((status) => status.pid)).size).toBe(1);
    expect(statuses.every((status) => status.state === 'connected')).toBe(true);
    const owner = JSON.parse(await readFile(resolve(
      nativeBrowserBrokerDirectory(profileDir),
      'owner',
      'owner.json',
    ), 'utf8')) as { pid: number };
    expect(owner.pid).toBe(statuses[0].pid);
  }, 30_000);
});

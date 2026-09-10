import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createSharedResearchService } from './research/broker.js';
import type { ProjectRootInput } from './research/projectInventory.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} required`);
  return value;
}

export async function runResearchCli(args: string[]): Promise<void> {
  const config = loadConfig();
  const service = createSharedResearchService({
    enabled: true,
    root: config.researchRoot,
    endpoint: config.researchDbEndpoint,
    databaseNamespace: config.researchDbNamespace,
    databaseName: config.researchDbDatabase,
    vectorModel: config.researchVectorModel,
    vectorLowMemory: config.researchVectorLowMemory,
    vectorThreads: config.researchVectorThreads,
    vectorBackend: config.researchVectorBackend,
    repositoryAuto: config.researchRepoAuto,
    repositoryMaxSourceBytes: config.researchRepoAutoMaxMb * 1024 * 1024,
    repositoryMaxSourceFiles: config.researchRepoAutoMaxFiles,
    queryTimeoutMs: config.researchQueryTimeoutMs,
    graphCacheMaxBytes: config.researchGraphCacheMaxMb * 1024 * 1024,
  }, {
    idleMs: config.researchBrokerIdleMs,
    readConcurrency: config.researchReadConcurrency,
    workerSoftMemoryBytes: config.researchWorkerSoftMemoryMb * 1024 * 1024,
  });
  try {
    const [group, command] = args;
    let result: unknown;
    if (group === 'doctor') {
      result = await service.passiveStatus();
    } else if (group === 'daemon' && command === 'start') {
      result = await service.passiveStatus();
    } else if (group === 'daemon' && command === 'drain') {
      result = await service.requestDrain();
    } else if (group === 'memory' && command === 'get') {
      result = await service.getCatalogRecord(
        required(args, '--project'),
        required(args, '--record'),
        option(args, '--revision') ? Number(option(args, '--revision')) : undefined,
        Number(option(args, '--body-offset') ?? 0),
        Number(option(args, '--body-bytes') ?? 65_536),
      );
    } else if (group === 'memory' && command === 'sync') {
      const projectId = required(args, '--project');
      const path = resolve(required(args, '--manifest'));
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        roots?: ProjectRootInput[];
        git_root?: string;
        root_mode?: 'merge' | 'replace' | 'remove';
        changed_paths?: Array<{ root: string; path: string }>;
        removed_paths?: Array<{ root: string; path: string }>;
      };
      if (!manifest.roots?.length && !manifest.changed_paths?.length && !manifest.removed_paths?.length) {
        throw new Error('manifest roots, changed_paths, or removed_paths required');
      }
      result = await service.indexProject({
        project_id: projectId,
        roots: manifest.roots,
        git_root: manifest.git_root,
        root_mode: manifest.root_mode ?? 'merge',
        changed_paths: manifest.changed_paths,
        removed_paths: manifest.removed_paths,
      });
    } else if (group === 'memory' && command === 'current') {
      result = await service.materializeCurrentView(required(args, '--project'));
    } else if (group === 'job' && command === 'wait') {
      result = await service.waitForJob(
        required(args, '--project'),
        required(args, '--id'),
        Number(option(args, '--after-revision') ?? 0),
        Number(option(args, '--timeout-ms') ?? 60_000),
      );
    } else if (group === 'job' && command === 'cancel') {
      result = await service.cancelJob(
        required(args, '--project'),
        required(args, '--id'),
        option(args, '--reason'),
      );
    } else {
      throw new Error('usage: doctor | daemon start|drain | memory get|sync|current | job wait|cancel');
    }
    process.stdout.write(`${JSON.stringify(result, null, args.includes('--json') ? 2 : 0)}\n`);
  } finally {
    await service.close();
  }
}

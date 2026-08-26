import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideRepository, GitHubClient, parseGitHubRepositoryUrl, selectedRepositoryPaths,
  type GitHubRepository, type RepositoryClient,
} from '../src/research/github.js';
import { ResearchService } from '../src/research/service.js';

const run = promisify(execFile);

function repository(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'owner',
    name: 'repo',
    url: 'https://github.com/owner/repo',
    default_branch: 'main',
    stars: 100,
    archived: false,
    source_bytes: 40,
    source_files: [{ path: 'src/kernel.ts', size: 40 }],
    tree_truncated: false,
    readme: '# Repo\nA relevant implementation.',
    ...overrides,
  };
}

class FakeRepositoryClient implements RepositoryClient {
  readonly checkout = vi.fn(async (
    _repository: GitHubRepository,
    paths: string[],
    destination: string,
  ) => {
    for (const path of paths) {
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'export const github_source_token = 1;');
    }
  });

  constructor(private readonly value: GitHubRepository) {}

  async inspect(): Promise<GitHubRepository> {
    return this.value;
  }
}

describe('GitHub repository capture', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('uses one download decision for abstract and full modes', () => {
    const value = repository();
    const policy = { max_source_bytes: 1_000, max_source_files: 10, min_stars: 50 };

    expect(parseGitHubRepositoryUrl('https://github.com/owner/repo/tree/main/src'))
      .toEqual({ owner: 'owner', name: 'repo' });
    expect(decideRepository(value, 4, '', 'abstract', policy).action).toBe('queued');
    expect(decideRepository(value, 4, '', 'full', policy).action).toBe('queued');
    expect(decideRepository(value, 4, '', 'none', policy).action).toBe('readme');
    expect(selectedRepositoryPaths(value, 'abstract')).toEqual(['src/kernel.ts']);
  });

  it('keeps large repositories as web results with a reason', () => {
    const decision = decideRepository(
      repository({ source_bytes: 2_000 }),
      1,
      'official implementation',
      'full',
      { max_source_bytes: 1_000, max_source_files: 10, min_stars: 50 },
    );

    expect(decision).toMatchObject({
      action: 'web_only',
      reason: 'source size threshold exceeded',
    });
  });

  it('reads README without cloning in none mode and indexes a small repository in abstract mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-github-'));
    roots.push(root);
    const client = new FakeRepositoryClient(repository());
    const service = new ResearchService({
      enabled: true,
      root,
      endpoint: 'mem://',
      repositoryClient: client,
      repositoryAuto: true,
      repositoryMaxSourceBytes: 1_000,
      repositoryMaxSourceFiles: 10,
    });
    try {
      await service.createProject('GitHub project', 'github-project');
      const readme = await service.prepareRepositoryResults('github-project', 'none', [{
        title: 'Repo',
        url: 'https://github.com/owner/repo',
        description: 'repo',
      }]);
      expect(readme.rows[0].content).toContain('relevant implementation');
      expect(readme.decisions[0].action).toBe('readme');
      expect(client.checkout).not.toHaveBeenCalled();

      const indexed = await service.prepareRepositoryResults('github-project', 'abstract', [{
        title: 'Repo',
        url: 'https://github.com/owner/repo',
        description: 'official implementation',
      }]);
      await service.waitForIdle();

      expect(indexed.decisions[0].action).toBe('queued');
      expect(client.checkout).toHaveBeenCalledOnce();
      expect(await service.search('github-project', 'github_source_token', 10)).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it('refreshes an existing sparse checkout from the default branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-github-checkout-'));
    roots.push(root);
    const source = join(root, 'source');
    const remote = join(root, 'remote');
    const destination = join(root, 'checkout');
    await mkdir(join(source, 'src'), { recursive: true });
    await run('git', ['init', '-b', 'main'], { cwd: source });
    await run('git', ['config', 'user.name', 'test'], { cwd: source });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await writeFile(join(source, 'src', 'kernel.ts'), 'export const version = 1;');
    await run('git', ['add', '.'], { cwd: source });
    await run('git', ['commit', '-m', 'initial'], { cwd: source });
    await run('git', ['clone', '--bare', source, `${remote}.git`]);
    await run('git', ['remote', 'add', 'origin', `${remote}.git`], { cwd: source });

    const client = new GitHubClient();
    const value = repository({ url: remote });
    await client.checkout(value, ['src/kernel.ts'], destination);
    expect(await readFile(join(destination, 'src', 'kernel.ts'), 'utf8')).toContain('version = 1');

    await writeFile(join(source, 'src', 'kernel.ts'), 'export const version = 2;');
    await run('git', ['add', '.'], { cwd: source });
    await run('git', ['commit', '-m', 'update'], { cwd: source });
    await run('git', ['push', 'origin', 'main'], { cwd: source });
    await client.checkout(value, ['src/kernel.ts'], destination);
    expect(await readFile(join(destination, 'src', 'kernel.ts'), 'utf8')).toContain('version = 2');
  }, 15_000);
});

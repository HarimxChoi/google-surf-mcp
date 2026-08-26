import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  classifyProjectPath, isSensitivePath, isTextPath, searchableByPolicy,
} from './inventory.js';

export type RepositoryReadMode = 'none' | 'abstract' | 'full';

export interface GitHubRepository {
  owner: string;
  name: string;
  url: string;
  default_branch: string;
  stars: number;
  archived: boolean;
  source_bytes: number;
  source_files: Array<{ path: string; size: number }>;
  tree_truncated: boolean;
  readme?: string;
}

export interface RepositoryPolicy {
  max_source_bytes: number;
  max_source_files: number;
  min_stars: number;
}

export interface RepositoryDecision {
  repository: string;
  action: 'readme' | 'queued' | 'web_only';
  reason: string;
  stars?: number;
  source_bytes?: number;
  source_files?: number;
}

export interface RepositoryClient {
  inspect(url: string, includeTree?: boolean): Promise<GitHubRepository | undefined>;
  checkout(repository: GitHubRepository, paths: string[], destination: string): Promise<void>;
}

const RESERVED = new Set([
  'about', 'collections', 'events', 'explore', 'features', 'login', 'marketplace', 'orgs',
  'pricing', 'search', 'settings', 'signup', 'sponsors', 'topics', 'users',
]);

export function parseGitHubRepositoryUrl(value: string): { owner: string; name: string } | undefined {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const [owner, rawName] = url.pathname.split('/').filter(Boolean);
    const name = rawName?.replace(/\.git$/i, '');
    if (!owner || !name || RESERVED.has(owner.toLowerCase())) return undefined;
    return { owner, name };
  } catch {
    return undefined;
  }
}

function headers(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'google-surf-mcp',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

async function githubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  return await response.json() as T;
}

function sourceFiles(tree: Array<{ path: string; type: string; size?: number }>): Array<{
  path: string;
  size: number;
}> {
  return tree.flatMap((entry) => {
    if (entry.type !== 'blob' || !isTextPath(entry.path) || isSensitivePath(entry.path)) return [];
    const kind = classifyProjectPath(entry.path);
    if (!searchableByPolicy('structured', kind, true)) return [];
    const size = Number(entry.size ?? 0);
    if (size > 2 * 1024 * 1024) return [];
    return [{ path: entry.path, size }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export class GitHubClient implements RepositoryClient {
  async inspect(value: string, includeTree = true): Promise<GitHubRepository | undefined> {
    const parsed = parseGitHubRepositoryUrl(value);
    if (!parsed) return undefined;
    const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
    const metadata = await githubJson<{
      html_url: string;
      default_branch: string;
      stargazers_count: number;
      archived: boolean;
    }>(base);
    const [tree, readme] = await Promise.all([
      includeTree ? githubJson<{
        truncated: boolean;
        tree: Array<{ path: string; type: string; size?: number }>;
      }>(`${base}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`) : undefined,
      githubJson<{ content?: string; encoding?: string }>(`${base}/readme`).catch(() => undefined),
    ]);
    const files = sourceFiles(tree?.tree ?? []);
    return {
      owner: parsed.owner,
      name: parsed.name,
      url: metadata.html_url,
      default_branch: metadata.default_branch,
      stars: metadata.stargazers_count,
      archived: metadata.archived,
      source_bytes: files.reduce((sum, file) => sum + file.size, 0),
      source_files: files,
      tree_truncated: tree?.truncated ?? false,
      ...(readme?.content && readme.encoding === 'base64'
        ? { readme: Buffer.from(readme.content.replace(/\s/g, ''), 'base64').toString('utf8') }
        : {}),
    };
  }

  async checkout(repository: GitHubRepository, paths: string[], destination: string): Promise<void> {
    await mkdir(resolve(destination, '..'), { recursive: true });
    const exists = await stat(join(destination, '.git')).then(() => true, () => false);
    if (!exists) {
      await git([
        'clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--single-branch', '--no-tags',
        '--branch', repository.default_branch, `${repository.url}.git`, destination,
      ]);
    } else {
      await git([
        '-C', destination, 'fetch', '--depth=1', '--no-tags',
        'origin', repository.default_branch,
      ]);
    }
    await git(['-C', destination, 'sparse-checkout', 'init', '--no-cone']);
    await gitWithInput(['-C', destination, 'sparse-checkout', 'set', '--no-cone', '--stdin'], paths);
    await git(['-C', destination, 'checkout', '--force', exists ? 'FETCH_HEAD' : 'HEAD']);
  }
}

function git(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(error.trim() || `git exited ${code}`)));
  });
}

function gitWithInput(args: string[], lines: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(error.trim() || `git exited ${code}`)));
    child.stdin.end(`${lines.join('\n')}\n`);
  });
}

export function decideRepository(
  repository: GitHubRepository,
  rank: number,
  description: string,
  mode: RepositoryReadMode,
  policy: RepositoryPolicy,
): RepositoryDecision {
  const name = `${repository.owner}/${repository.name}`;
  if (mode === 'none') return { repository: name, action: 'readme', reason: 'README only' };
  const common = {
    repository: name,
    stars: repository.stars,
    source_bytes: repository.source_bytes,
    source_files: repository.source_files.length,
  };
  if (repository.archived) return { ...common, action: 'web_only', reason: 'archived repository' };
  if (repository.tree_truncated) return { ...common, action: 'web_only', reason: 'source tree too large' };
  if (repository.source_bytes > policy.max_source_bytes) {
    return { ...common, action: 'web_only', reason: 'source size threshold exceeded' };
  }
  if (repository.source_files.length > policy.max_source_files) {
    return { ...common, action: 'web_only', reason: 'source file threshold exceeded' };
  }
  const technical = /\b(?:official|reference implementation|paper|research|framework|library)\b/i
    .test(description);
  if (rank > 3 && repository.stars < policy.min_stars && !technical) {
    return { ...common, action: 'web_only', reason: 'importance threshold not met' };
  }
  if (!repository.source_files.length) {
    return { ...common, action: 'web_only', reason: 'no searchable source files' };
  }
  return { ...common, action: 'queued', reason: 'small relevant repository' };
}

export function selectedRepositoryPaths(
  repository: GitHubRepository,
  mode: Exclude<RepositoryReadMode, 'none'>,
): string[] {
  if (mode === 'full') return repository.source_files.map((file) => file.path);
  const priority = (path: string): number => {
    const name = path.toLowerCase();
    if (/(^|\/)(readme|license|contributing)(\.|$)/.test(name)) return 0;
    if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(name)) return 1;
    return classifyProjectPath(path) === 'source' ? 2 : 3;
  };
  const selected: string[] = [];
  let bytes = 0;
  for (const file of [...repository.source_files].sort((a, b) => (
    priority(a.path) - priority(b.path) || a.path.localeCompare(b.path)
  ))) {
    if (selected.length >= 200 || bytes + file.size > 2 * 1024 * 1024) continue;
    selected.push(file.path);
    bytes += file.size;
  }
  return selected;
}

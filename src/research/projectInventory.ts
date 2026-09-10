import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  classifyProjectPath, collectionIgnoreGlobs, experimentKey, isCollectionBoundary,
  containsSensitiveContent, isSensitivePath, isTextPath, projectRoleKind, type ProjectFileKind,
} from './inventory.js';
import type { ProjectDocumentRole, ProjectSourceEntryRecord } from './contracts.js';

export interface ProjectRootInput {
  label: string;
  path: string;
  role?: ProjectDocumentRole;
  manifest?: Array<{ path: string; role: ProjectDocumentRole; aliases?: string[] }>;
}

export interface ProjectInventoryRecord {
  id: string;
  root: string;
  path: string;
  size: number;
  modified_ms: number;
  kind: ProjectFileKind;
  tracked: boolean;
  content_hash?: string;
  text?: string;
  experiment_key?: string;
  role?: ProjectDocumentRole;
  aliases?: string[];
  sensitive: boolean;
  unreadable?: boolean;
  searchable?: boolean;
  entry_type: 'file' | 'collection';
}

export interface GitSnapshot {
  branch: string;
  head: string;
  dirty: boolean;
  changed_files: number;
}

export interface ProjectInventory {
  roots: ProjectRootInput[];
  git_root?: string;
  git?: GitSnapshot;
  records: ProjectInventoryRecord[];
  digest: string;
}

export interface ProjectPathChange {
  root: string;
  path: string;
}

function command(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
}

function gitSnapshot(gitRoot: string | undefined): GitSnapshot | undefined {
  if (!gitRoot) return undefined;
  const status = command(['-C', gitRoot, 'status', '--porcelain=v1']);
  return {
    branch: command(['-C', gitRoot, 'branch', '--show-current']) || 'detached',
    head: command(['-C', gitRoot, 'rev-parse', 'HEAD']),
    dirty: status.length > 0,
    changed_files: status ? status.split(/\r?\n/).length : 0,
  };
}

function trackedFiles(gitRoot: string | undefined): Set<string> {
  if (!gitRoot) return new Set();
  const output = execFileSync('git', ['-C', gitRoot, 'ls-files', '-z'], {
    encoding: 'buffer', windowsHide: true,
  });
  return new Set(output.toString('utf8').split('\0').filter(Boolean)
    .map((path) => resolve(gitRoot, path).toLowerCase()));
}

async function listCollectionBoundaries(root: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        output.push(path);
      } else if (entry.isDirectory()) {
        if (isCollectionBoundary(relativePath)) output.push(path);
        else pending.push(path);
      }
    }
  }
  return output.sort();
}

async function listFilesFallback(root: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!isCollectionBoundary(relativePath)) pending.push(path);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  }
  return output.sort();
}

async function listFiles(root: string): Promise<string[]> {
  const globs = collectionIgnoreGlobs().flatMap((glob) => ['-g', `!${glob}`]);
  try {
    const output = execFileSync('rg', ['--files', '--hidden', '--no-ignore', ...globs, root], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return output.split(/\r?\n/).filter(Boolean).map((path) => resolve(path)).sort();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: string }).code)
      : undefined;
    const status = error && typeof error === 'object' && 'status' in error
      ? Number((error as { status?: number }).status)
      : undefined;
    if (status === 1) return [];
    if (code === 'ENOENT') return await listFilesFallback(root);
    throw error;
  }
}

async function inventoryRecord(
  root: ProjectRootInput,
  path: string,
  tracked: Set<string>,
  collection: boolean,
): Promise<ProjectInventoryRecord> {
  const relativePath = relative(root.path, path).replace(/\\/g, '/');
  const declared = root.manifest?.find((item) => item.path.replace(/\\/g, '/') === relativePath);
  const role = declared?.role ?? root.role;
  const kind = collection ? 'cache' : role ? projectRoleKind(role) : classifyProjectPath(relativePath);
  const pathSensitive = !collection && isSensitivePath(relativePath);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: string }).code)
      : undefined;
    if (!['EACCES', 'EPERM', 'ENOENT'].includes(code ?? '')) throw error;
    return {
      id: createHash('sha256').update(`${root.label}\0${relativePath}`).digest('hex').slice(0, 32),
      root: root.label,
      path: relativePath,
      size: 0,
      modified_ms: 0,
      kind,
      tracked: tracked.has(path.toLowerCase()),
      sensitive: pathSensitive,
      unreadable: true,
      ...(role ? { role } : {}),
      ...(declared?.aliases?.length ? { aliases: [...new Set(declared.aliases)] } : {}),
      entry_type: collection ? 'collection' : 'file',
    };
  }
  const textEligible = !pathSensitive && !collection && stat.isFile() && isTextPath(path)
    && stat.size <= 2 * 1024 * 1024;
  const bytes = textEligible ? await readFile(path) : undefined;
  const text = textEligible ? bytes!.toString('utf8') : undefined;
  const sensitive = pathSensitive || (text !== undefined && containsSensitiveContent(text));
  const key = ['prereg', 'result'].includes(kind) ? experimentKey(relativePath) : undefined;
  return {
    id: createHash('sha256').update(`${root.label}\0${relativePath}`).digest('hex').slice(0, 32),
    root: root.label,
    path: relativePath,
    size: stat.size,
    modified_ms: stat.mtimeMs,
    kind,
    tracked: tracked.has(path.toLowerCase()),
    sensitive,
    entry_type: collection ? 'collection' : 'file',
    ...(!sensitive && bytes ? { content_hash: createHash('sha256').update(bytes).digest('hex') } : {}),
    ...(!sensitive && text !== undefined ? { text } : {}),
    ...(key ? { experiment_key: `${root.label}/${key}` } : {}),
    ...(role ? { role } : {}),
    ...(declared?.aliases?.length ? { aliases: [...new Set(declared.aliases)] } : {}),
  };
}

function normalizeRoots(inputs: ProjectRootInput[]): ProjectRootInput[] {
  const labels = new Set<string>();
  return inputs.map((input) => {
    const label = input.label.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(label)) throw new Error('invalid root label');
    if (labels.has(label)) throw new Error(`duplicate root label: ${label}`);
    labels.add(label);
    return {
      label,
      path: resolve(input.path),
      ...(input.role ? { role: input.role } : {}),
      ...(input.manifest?.length ? {
        manifest: input.manifest.map((item) => ({
          path: item.path.replace(/\\/g, '/'),
          role: item.role,
          ...(item.aliases?.length ? { aliases: [...new Set(item.aliases)] } : {}),
        })),
      } : {}),
    };
  });
}

export async function inventoryProject(input: {
  roots: ProjectRootInput[];
  git_root?: string;
}): Promise<ProjectInventory> {
  const roots = normalizeRoots(input.roots);
  if (!roots.length) throw new Error('at least one root required');
  const gitRoot = input.git_root ? resolve(input.git_root) : undefined;
  const tracked = trackedFiles(gitRoot);
  const records: ProjectInventoryRecord[] = [];
  for (const root of roots) {
    const entries = [
      ...(await listFiles(root.path)).map((path) => ({ path, collection: false })),
      ...(await listCollectionBoundaries(root.path)).map((path) => ({ path, collection: true })),
    ];
    for (let index = 0; index < entries.length; index += 64) {
      records.push(...await Promise.all(entries.slice(index, index + 64)
        .map((entry) => inventoryRecord(root, entry.path, tracked, entry.collection))));
    }
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256').update(JSON.stringify(records.map((record) => ({
    id: record.id,
    size: record.size,
    modified_ms: record.content_hash ? undefined : record.modified_ms,
    kind: record.kind,
    sensitive: record.sensitive || undefined,
    unreadable: record.unreadable || undefined,
    content_hash: record.content_hash,
    entry_type: record.entry_type,
    role: record.role,
    aliases: record.aliases,
  })))).digest('hex');
  return {
    roots,
    ...(gitRoot ? { git_root: gitRoot } : {}),
    ...(gitRoot ? { git: gitSnapshot(gitRoot) } : {}),
    records,
    digest,
  };
}

export async function inventoryProjectIncremental(input: {
  roots: ProjectRootInput[];
  git_root?: string;
  current: ProjectSourceEntryRecord[];
  changed_paths: ProjectPathChange[];
  removed_paths: ProjectPathChange[];
}): Promise<ProjectInventory> {
  const roots = normalizeRoots(input.roots);
  const byLabel = new Map(roots.map((root) => [root.label, root]));
  const tracked = trackedFiles(input.git_root ? resolve(input.git_root) : undefined);
  const records = new Map<string, ProjectInventoryRecord>(input.current.map((record) => [record.entry_id, {
    id: record.entry_id,
    root: record.root,
    path: record.path,
    size: record.size,
    modified_ms: record.modified_ms,
    kind: record.kind as ProjectFileKind,
    tracked: record.tracked,
    content_hash: record.content_hash,
    experiment_key: record.experiment_key,
    role: record.role,
    aliases: record.aliases,
    sensitive: record.sensitive,
    unreadable: record.unreadable,
    searchable: record.searchable,
    entry_type: record.entry_type,
  } satisfies ProjectInventoryRecord]));
  const locate = (change: ProjectPathChange): { root: ProjectRootInput; path: string; relativePath: string } => {
    const root = byLabel.get(change.root);
    if (!root) throw new Error(`unknown root label: ${change.root}`);
    const path = resolve(root.path, change.path);
    const rootPath = resolve(root.path);
    if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) {
      throw new Error(`path escapes root ${change.root}: ${change.path}`);
    }
    return { root, path, relativePath: relative(rootPath, path).replace(/\\/g, '/') };
  };
  for (const change of input.removed_paths) {
    const { root, relativePath } = locate(change);
    const id = createHash('sha256').update(`${root.label}\0${relativePath}`).digest('hex').slice(0, 32);
    records.delete(id);
  }
  for (const change of input.changed_paths) {
    const located = locate(change);
    let metadata;
    try {
      metadata = await lstat(located.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`changed path not found; declare it in removed_paths: ${change.root}/${change.path}`);
      }
      throw error;
    }
    const record = await inventoryRecord(located.root, located.path, tracked, metadata.isDirectory());
    records.set(record.id, record);
  }
  const sorted = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash('sha256').update(JSON.stringify(sorted.map((record) => ({
    id: record.id,
    size: record.size,
    modified_ms: record.content_hash ? undefined : record.modified_ms,
    kind: record.kind,
    sensitive: record.sensitive || undefined,
    unreadable: record.unreadable || undefined,
    content_hash: record.content_hash,
    entry_type: record.entry_type,
    role: record.role,
    aliases: record.aliases,
  })))).digest('hex');
  return {
    roots,
    ...(input.git_root ? { git_root: resolve(input.git_root), git: gitSnapshot(resolve(input.git_root)) } : {}),
    records: sorted,
    digest,
  };
}

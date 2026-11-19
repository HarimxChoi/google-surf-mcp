import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  classifyProjectPath, collectionIgnoreGlobs, experimentKey, isCollectionBoundary,
  containsSensitiveContent, isSensitivePath, isTextPath, projectRoleKind, type ProjectFileKind,
} from './inventory.js';
import type { ProjectDocumentRole, ProjectSourceEntryRecord } from './contracts.js';
import { documentFormatFromPath, MAX_DOCUMENT_BYTES } from '../documentFormats.js';
import { documentParserFingerprint, readBinaryDocument } from '../documentReader.js';
import type { ExtractionProvenance } from '../extractionProvenance.js';
import type { DocumentSourceMap } from '../documentSourceMap.js';

export interface ProjectRootInput {
  label: string;
  path: string;
  role?: ProjectDocumentRole;
  include_paths?: string[];
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
  source_hash?: string;
  parser_fingerprint?: string;
  source_map?: DocumentSourceMap;
  source_map_id?: string;
  text_bytes?: number;
  extraction_provenance?: ExtractionProvenance;
  extraction_quality?: string;
  extraction_error?: string;
  quality_reason?: string;
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
  current?: ProjectSourceEntryRecord,
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
  const format = !pathSensitive && !collection && stat.isFile() ? documentFormatFromPath(path) : undefined;
  let bytes = textEligible ? await readFile(path) : undefined;
  let text = textEligible ? bytes!.toString('utf8') : undefined;
  let document: Partial<ProjectInventoryRecord> = {};
  let documentSensitive = false;
  if (format) {
    const fingerprint = documentParserFingerprint();
    if (stat.size > MAX_DOCUMENT_BYTES) document = { extraction_quality: 'metadata_only',
      extraction_error: 'document exceeds 25 MiB; split the source' };
    else try {
      const [rootPath, actualPath] = await Promise.all([realpath(root.path), realpath(path)]);
      if (actualPath !== rootPath && !actualPath.startsWith(`${rootPath}${sep}`)) throw new Error(`document path escapes approved root: ${relativePath}`);
      bytes = await readFile(actualPath);
      const sourceHash = createHash('sha256').update(bytes).digest('hex');
      document = { source_hash: sourceHash, parser_fingerprint: fingerprint };
      if (current?.source_hash === sourceHash && current.parser_fingerprint === fingerprint
        && !current.extraction_error && !current.sensitive) {
        document = { ...document, content_hash: current.content_hash, text_bytes: current.text_bytes,
          source_map_id: current.source_map_id,
          extraction_provenance: current.extraction_provenance, extraction_quality: current.extraction_quality,
          quality_reason: current.quality_reason, searchable: current.searchable };
      } else {
        const parsed = await readBinaryDocument(bytes, format);
        documentSensitive = parsed.contains_sensitive_content === true;
        text = parsed.content?.trim() ? parsed.content : undefined;
        document = { ...document, extraction_provenance: parsed.extraction_provenance,
          source_map: parsed.source_map,
          extraction_quality: parsed.extraction_quality, quality_reason: parsed.quality_reason?.slice(0, 200),
          ...(parsed.error ? { extraction_error: parsed.error.slice(0, 200), unreadable: true } : {}),
          ...(text !== undefined ? { content_hash: createHash('sha256').update(text).digest('hex'),
            text_bytes: Buffer.byteLength(text, 'utf8') } : {}) };
      }
    } catch (error) {
      document = { extraction_quality: 'metadata_only', unreadable: true,
        extraction_error: (error as Error).message.slice(0, 200) };
    }
  }
  const sensitive = pathSensitive || documentSensitive || (text !== undefined && containsSensitiveContent(text));
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
    ...(!sensitive && !format && bytes ? { content_hash: createHash('sha256').update(bytes).digest('hex') } : {}),
    ...(!sensitive ? document : {}),
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
      ...(input.include_paths !== undefined ? { include_paths: [...new Set(input.include_paths.map(path => {
        const normalized = path.replace(/\\/g, '/');
        const absolute = resolve(input.path, path);
        if (!normalized || /[*?\[\]]/.test(normalized) || relative(resolve(input.path), absolute).startsWith('..')
          || absolute === resolve(input.path)) throw new Error(`include_paths requires exact files inside root ${label}: ${path}`);
        return relative(resolve(input.path), absolute).replace(/\\/g, '/');
      }))] } : {}),
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
  current?: ProjectSourceEntryRecord[];
}): Promise<ProjectInventory> {
  const roots = normalizeRoots(input.roots);
  if (!roots.length) throw new Error('at least one root required');
  const gitRoot = input.git_root ? resolve(input.git_root) : undefined;
  const tracked = trackedFiles(gitRoot);
  const records: ProjectInventoryRecord[] = [];
  const current = new Map((input.current ?? []).map(record => [`${record.root}\0${record.path}`, record]));
  for (const root of roots) {
    const entries = root.include_paths !== undefined
      ? root.include_paths.map(path => ({ path: resolve(root.path, path), collection: false })) : [
      ...(await listFiles(root.path)).map((path) => ({ path, collection: false })),
      ...(await listCollectionBoundaries(root.path)).map((path) => ({ path, collection: true })),
    ];
    for (let index = 0; index < entries.length; index += 64) {
      const batch = entries.slice(index, index + 64);
      records.push(...await Promise.all(batch.filter(entry => !documentFormatFromPath(entry.path))
        .map((entry) => inventoryRecord(root, entry.path, tracked, entry.collection))));
      for (const entry of batch.filter(entry => documentFormatFromPath(entry.path))) {
        records.push(await inventoryRecord(root, entry.path, tracked, entry.collection,
          current.get(`${root.label}\0${relative(root.path, entry.path).replace(/\\/g, '/')}`)));
      }
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
    source_hash: record.source_hash,
    parser_fingerprint: record.parser_fingerprint,
    extraction_error: record.extraction_error,
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
    source_hash: record.source_hash,
    parser_fingerprint: record.parser_fingerprint,
    source_map_id: record.source_map_id,
    text_bytes: record.text_bytes,
    extraction_provenance: record.extraction_provenance,
    extraction_quality: record.extraction_quality,
    extraction_error: record.extraction_error,
    quality_reason: record.quality_reason,
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
    if (root.include_paths !== undefined && !root.include_paths.includes(relative(rootPath, path).replace(/\\/g, '/'))) {
      throw new Error(`path is not in include_paths whitelist: ${change.root}/${change.path}`);
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
    const record = await inventoryRecord(located.root, located.path, tracked, metadata.isDirectory(),
      input.current.find(record => record.root === located.root.label && record.path === located.relativePath));
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
    source_hash: record.source_hash,
    parser_fingerprint: record.parser_fingerprint,
    extraction_error: record.extraction_error,
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

export async function previewProjectFiles(inputs: ProjectRootInput[]) {
  const roots = normalizeRoots(inputs);
  let files = 0, bytes = 0;
  const errors: Array<{ root: string; path: string; message: string }> = [];
  for (const root of roots) {
    const paths = root.include_paths !== undefined ? root.include_paths.map(path => resolve(root.path, path))
      : await listFiles(root.path);
    for (const path of paths) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('expected a regular file, not a directory or symlink');
        files++; bytes += info.size;
      } catch (error) { if (errors.length < 20) errors.push({ root: root.label,
        path: relative(root.path, path), message: String(error).slice(0, 500) }); }
    }
  }
  return { files, bytes, roots: roots.length, explicit_whitelist: roots.every(root => root.include_paths !== undefined),
    errors, parsed: false, stored: false };
}

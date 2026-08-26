import { extname, basename, dirname } from 'node:path';

export type ProjectFileKind =
  | 'prereg'
  | 'result'
  | 'report'
  | 'source'
  | 'config'
  | 'log'
  | 'checkpoint'
  | 'cache'
  | 'data'
  | 'other';

export type StoragePolicy = 'index_all' | 'structured' | 'terminal_on_demand';

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cu', '.cuh', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.mjs', '.py', '.rs', '.sh', '.swift', '.ts', '.tsx',
]);

const CONFIG_EXTENSIONS = new Set([
  '.conf', '.ini', '.json', '.jsonl', '.toml', '.yaml', '.yml',
]);

const CHECKPOINT_EXTENSIONS = new Set([
  '.bin', '.ckpt', '.gguf', '.npy', '.npz', '.onnx', '.pt', '.pth', '.safetensors',
  '.tar', '.zip',
]);

const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ...CONFIG_EXTENSIONS,
  '.csv', '.log', '.md', '.rst', '.tex', '.txt',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx',
]);

const SENSITIVE_NAMES = new Set([
  '.netrc', '.npmrc', '.pypirc', 'auth.json', 'credentials.json', 'token.json',
]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
];

const CACHE_SEGMENTS = new Set([
  '.git', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.venv', '__pycache__',
  'build', 'build-scripts', 'node_modules',
]);

const COLLECTION_PATTERNS = [
  /(^|[-_.])(build|cache|download|downloads|snapshot|snapshots)([-_.]|$)/i,
  /^llama[.-]cpp[-_]/i,
  /^models--/i,
  /^torch-extensions/i,
];

const COLLECTION_IGNORE_GLOBS = [
  '**/.git/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.ruff_cache/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/build/**',
  '**/build-*/**',
  '**/*-build/**',
  '**/build-scripts/**',
  '**/downloads/**',
  '**/hf-cache/**',
  '**/llama.cpp-*/**',
  '**/llama-cpp-*/**',
  '**/models--*/**',
  '**/node_modules/**',
  '**/snapshots/**',
  '**/torch-extensions*/**',
];

function normalizedSegments(path: string): string[] {
  return path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
}

export function classifyProjectPath(path: string): ProjectFileKind {
  const segments = normalizedSegments(path);
  const name = segments.at(-1) ?? '';
  const extension = extname(name).toLowerCase();
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) return 'cache';
  if (/(^|[-_.])prereg([-. _]|$)/i.test(name)) return 'prereg';
  if (/(^|[-_.])(result|results|summary)([-. _]|$)/i.test(name)) return 'result';
  if (extension === '.md' && /(report|plan|research|design|readme|audit|ledger)/i.test(name)) {
    return 'report';
  }
  if (extension === '.log') return 'log';
  if (CHECKPOINT_EXTENSIONS.has(extension)) return 'checkpoint';
  if (SOURCE_EXTENSIONS.has(extension)) return 'source';
  if (CONFIG_EXTENSIONS.has(extension)) return 'config';
  if (TEXT_EXTENSIONS.has(extension) || ['.parquet', '.csv'].includes(extension)) return 'data';
  return 'other';
}

export function isTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return SENSITIVE_NAMES.has(name)
    || /^\.env(?:\.|$)/.test(name)
    || /^id_(?:dsa|ecdsa|ed25519|rsa)$/.test(name)
    || /^service[-_]account(?:[-_.].*)?\.json$/.test(name)
    || SENSITIVE_EXTENSIONS.has(extname(name));
}

export function containsSensitiveContent(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function isCollectionBoundary(path: string): boolean {
  const segments = normalizedSegments(path);
  if (segments.some((segment) => CACHE_SEGMENTS.has(segment))) return true;
  return COLLECTION_PATTERNS.some((pattern) => pattern.test(segments.at(-1) ?? ''));
}

export function collectionIgnoreGlobs(): string[] {
  return [...COLLECTION_IGNORE_GLOBS];
}

export function experimentKey(path: string): string | undefined {
  const name = basename(path, extname(path)).toLowerCase()
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')
    .replace(/[-_.](prereg|result|results|summary)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return undefined;
  return `${dirname(path).replace(/\\/g, '/').toLowerCase()}/${name}`;
}

export function searchableByPolicy(
  policy: StoragePolicy,
  kind: ProjectFileKind,
  tracked: boolean,
): boolean {
  if (policy === 'index_all') return !['cache', 'checkpoint', 'other'].includes(kind);
  if (kind === 'cache' || kind === 'checkpoint' || kind === 'log' || kind === 'other') return false;
  if (policy === 'structured') {
    return tracked || ['prereg', 'result', 'report', 'source', 'config'].includes(kind);
  }
  return tracked || ['result', 'report', 'source'].includes(kind);
}

export function queryTermsFromPath(path: string): string[] {
  return basename(path, extname(path)).toLowerCase()
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !['prereg', 'result', 'results', 'summary'].includes(token));
}

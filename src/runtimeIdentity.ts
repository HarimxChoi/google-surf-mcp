import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schemas = new Map<string, unknown>();
const buildId = captureBuildId();

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function trackSchema<T extends z.ZodRawShape>(name: string, shape: T): T {
  schemas.set(name, z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }));
  return shape;
}

function captureBuildId(): string {
  const root = dirname(fileURLToPath(import.meta.url)), hash = createHash('sha256');
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:js|ts)$/.test(entry.name)) hash.update(relative(root, target).replaceAll('\\', '/')).update('\0').update(readFileSync(target));
    }
  };
  visit(root);
  const vendor = join(root, '..', 'vendor', 'transformers.node.min.mjs');
  if (existsSync(vendor)) hash.update('vendor/transformers.node.min.mjs').update('\0').update(readFileSync(vendor));
  return hash.digest('hex');
}

export function runtimeIdentity(): { build_id: string; schema_hash: string; schema_tools: string[] } {
  return { build_id: buildId, schema_hash: createHash('sha256').update(canonicalJson(Object.fromEntries(schemas))).digest('hex'), schema_tools: [...schemas.keys()].sort() };
}

#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const v = pkg.version;
const name = pkg.name;

const targets = [
  {
    path: join(root, 'server.json'),
    apply: (j) => {
      j.version = v;
      for (const p of j.packages ?? []) p.version = v;
      return j;
    },
  },
  {
    path: join(root, 'manifest.json'),
    apply: (j) => {
      j.version = v;
      const args = j.server?.mcp_config?.args;
      if (Array.isArray(args)) {
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === 'string' && args[i].startsWith(`${name}@`)) {
            args[i] = `${name}@${v}`;
          }
        }
      }
      return j;
    },
  },
];

for (const t of targets) {
  const orig = readFileSync(t.path, 'utf8');
  const j = JSON.parse(orig);
  const updated = t.apply(j);
  const out = JSON.stringify(updated, null, 2) + (orig.endsWith('\n') ? '\n' : '');
  if (out !== orig) {
    writeFileSync(t.path, out);
    console.log(`[sync-versions] ${t.path.replace(root + '/', '')} → ${v}`);
  }
}

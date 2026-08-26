#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function markdownFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

const failures = [];
for (const path of markdownFiles('prereg')) {
  const text = readFileSync(path, 'utf8');
  if (!/^## Falsifiers$/m.test(text)) failures.push(`${path}: missing Falsifiers`);
  if (!/^## Deferred$/m.test(text)) failures.push(`${path}: missing Deferred`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

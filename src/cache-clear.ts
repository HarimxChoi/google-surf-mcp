import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = resolve(homedir());
const profile = resolve(process.env.SURF_PROFILE_ROOT || join(home, '.google-surf-mcp'));
const targets = [...new Set([
  resolve(process.env.SURF_CACHE_ROOT || join(profile, 'cache')),
  resolve(fileURLToPath(new URL('../.cache/', import.meta.url))),
])];

for (const target of targets) {
  const root = resolve(parse(target).root);
  if ([root, home, profile].some((blocked) => target.toLowerCase() === blocked.toLowerCase())) {
    throw new Error(`refusing to remove unsafe cache path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
}

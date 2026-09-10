import { existsSync, readFileSync } from 'node:fs';

const packageUrl = [
  new URL('../package.json', import.meta.url),
  new URL('../../package.json', import.meta.url),
].find((candidate) => existsSync(candidate));
if (!packageUrl) throw new Error('package.json not found');
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8')) as { name: string; version: string };

export const PKG_NAME: string = pkg.name;
export const VERSION: string = pkg.version;

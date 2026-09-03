#!/usr/bin/env node
import { VERSION } from './version.js';

const args = process.argv.slice(2);

if (args[0] === 'hooks') {
  const { runHooksCli } = await import('./hooksCli.js');
  await runHooksCli(args.slice(1));
} else if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${VERSION}\n`);
} else {
  await import('./index.js');
}

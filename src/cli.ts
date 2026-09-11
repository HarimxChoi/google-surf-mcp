#!/usr/bin/env node
import { VERSION } from './version.js';

const args = process.argv.slice(2);

if (args[0] === 'hooks') {
  const { runHooksCli } = await import('./hooksCli.js');
  await runHooksCli(args.slice(1));
} else if (args[0] === 'orcarouter' || args[0] === 'orca') {
  const { runOrcaRouterCli } = await import('./orcarouter/cli.js');
  await runOrcaRouterCli(args.slice(1));
} else if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${VERSION}\n`);
} else if (['doctor', 'daemon', 'memory', 'job'].includes(args[0] ?? '')) {
  const { runResearchCli } = await import('./researchCli.js');
  await runResearchCli(args);
} else {
  await import('./index.js');
}

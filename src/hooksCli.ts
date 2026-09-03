import { codexHooksStatus, installCodexHooks, uninstallCodexHooks } from './hostHooks.js';

function help(): string {
  return [
    'Usage: google-surf-mcp hooks <install|status|update|uninstall> --host codex',
    '',
    'Installs optional host-side Bash budgets and stateless output reranking.',
    'The hooks do not execute shell commands and do not store command output.',
  ].join('\n');
}

function hostFrom(args: string[]): string {
  const index = args.indexOf('--host');
  return index >= 0 ? String(args[index + 1] ?? '') : 'codex';
}

export async function runHooksCli(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  const action = args[0];
  const host = hostFrom(args);
  if (host !== 'codex') throw new Error(`Unsupported host: ${host}. Currently supported: codex.`);
  const result = action === 'install' || action === 'update'
    ? await installCodexHooks()
    : action === 'status'
      ? await codexHooksStatus()
      : action === 'uninstall'
        ? await uninstallCodexHooks()
        : undefined;
  if (!result) throw new Error(`Unknown hooks action: ${action}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if ((action === 'install' || action === 'update') && result.installed) {
    process.stdout.write('Restart Codex, open /hooks, and review and trust the new hook definitions.\n');
  }
}

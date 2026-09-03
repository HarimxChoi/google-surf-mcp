#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'surf-host-hooks-smoke-'));
const codexHome = join(root, 'codex');
const surfHome = join(root, 'surf');
const configPath = join(codexHome, 'config.toml');
const env = { ...process.env, CODEX_HOME: codexHome, SURF_PROFILE_ROOT: surfHome };

function run(args, input) {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env, input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function runCommand(command, input) {
  const result = spawnSync(command, { cwd: process.cwd(), env, input, encoding: 'utf8', shell: true });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(configPath, '[features]\nhooks = true\n\n[mcp_servers.example]\ncommand = "example"\n', 'utf8');
  const install = run(['build/cli.js', 'hooks', 'install', '--host', 'codex']);
  assert(install.includes('"installed": true'), 'install did not report success');
  const manifest = JSON.parse(readFileSync(join(surfHome, 'hooks', 'codex', 'install.json'), 'utf8'));
  const preHook = join(manifest.install_dir, 'codexShellGuard.js');
  const postHook = join(manifest.install_dir, 'rerankOutput.js');
  assert(existsSync(preHook) && existsSync(postHook), 'installed hook files are missing');
  const configuredCommands = [...readFileSync(configPath, 'utf8').matchAll(/^command_windows = (.+)$/gm)]
    .map((match) => JSON.parse(match[1]));
  assert(configuredCommands.length === 2, 'managed hook commands are missing from Codex config');

  const preInput = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 'smoke', turn_id: 'duplicate-turn',
    tool_name: 'Bash', tool_input: { command: 'rg -n "failure|perplexity" artifacts' },
  });
  assert(runCommand(configuredCommands[0], preInput) === '', 'first command should pass');
  assert(runCommand(configuredCommands[0], preInput) === '', 'second command should pass');
  assert(runCommand(configuredCommands[0], preInput).includes('permissionDecisionReason'), 'third command should be denied');

  const postInput = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 'smoke', turn_id: 'output-turn',
    tool_name: 'Bash', tool_input: { command: 'find final perplexity status' },
    tool_response: { output: `${'still running\n\n'.repeat(700)}final perplexity: 8.42\nstatus: complete` },
  });
  const post = JSON.parse(runCommand(configuredCommands[1], postInput));
  assert(post.continue === false, 'oversized output was not replaced');
  assert(post.stopReason.length <= 6_000, 'ranked output exceeded 6000 characters');
  assert(post.stopReason.includes('perplexity'), 'ranked output dropped the relevant result');

  const status = run(['build/cli.js', 'hooks', 'status', '--host', 'codex']);
  assert(status.includes('"files_valid": true'), 'status did not validate installed files');
  run(['build/cli.js', 'hooks', 'uninstall', '--host', 'codex']);
  const config = readFileSync(configPath, 'utf8');
  assert(config.includes('[mcp_servers.example]'), 'uninstall removed unrelated config');
  assert(!config.includes('google-surf host output hooks'), 'uninstall left the managed config block');
  assert(!existsSync(join(surfHome, 'hooks', 'codex')), 'uninstall left installed hook files');
  const remainingSurfEntries = existsSync(surfHome) ? readdirSync(surfHome, { recursive: true }) : [];
  assert(!remainingSurfEntries.some((entry) => /research|chrome/i.test(String(entry))), 'hook smoke initialized runtime storage');
  process.stdout.write('Host hook smoke passed\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}

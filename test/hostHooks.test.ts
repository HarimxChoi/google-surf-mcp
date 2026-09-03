import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexHooksStatus, installCodexHooks, uninstallCodexHooks } from '../src/hostHooks.js';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'surf-host-hooks-'));
  roots.push(root);
  const codexHome = join(root, 'codex');
  const surfHome = join(root, 'surf');
  const sourceDir = join(root, 'build');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  for (const name of ['codexShellGuard.js', 'shellGuard.js', 'rerankOutput.js', 'outputRerank.js']) {
    writeFileSync(join(sourceDir, name), `// ${name}\n`, 'utf8');
  }
  writeFileSync(join(codexHome, 'config.toml'), '[features]\nhooks = true\n\n[mcp_servers.example]\ncommand = "example"\n', 'utf8');
  return {
    codex_home: codexHome,
    surf_home: surfHome,
    source_dir: sourceDir,
    node_path: 'node',
    version: 'test-version',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('host hook installer', () => {
  it('installs idempotently without replacing unrelated Codex config', async () => {
    const options = fixture();
    const first = await installCodexHooks(options);
    expect(first).toMatchObject({ installed: true, files_valid: true, stores_command_output: false });
    const once = readFileSync(join(options.codex_home, 'config.toml'), 'utf8');
    expect(once).toContain('[mcp_servers.example]');
    expect(once.match(/BEGIN google-surf host output hooks/g)).toHaveLength(1);
    expect(once).toContain('command_windows = "& \\"node\\"');

    await installCodexHooks(options);
    const twice = readFileSync(join(options.codex_home, 'config.toml'), 'utf8');
    expect(twice).toBe(once);
    expect((await codexHooksStatus(options)).warnings).toEqual([]);
  });

  it('removes only the managed config block and installed files', async () => {
    const options = fixture();
    await installCodexHooks(options);
    const removed = await uninstallCodexHooks(options);
    const config = readFileSync(join(options.codex_home, 'config.toml'), 'utf8');
    expect(removed.installed).toBe(false);
    expect(config).toContain('[mcp_servers.example]');
    expect(config).not.toContain('google-surf host output hooks');
    expect(existsSync(join(options.surf_home, 'hooks', 'codex'))).toBe(false);
  });
});

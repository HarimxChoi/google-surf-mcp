import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

const MARKER_START = '# BEGIN google-surf host output hooks';
const MARKER_END = '# END google-surf host output hooks';
const BUNDLE_FILES = [
  'codexShellGuard.js',
  'shellGuard.js',
  'rerankOutput.js',
  'outputRerank.js',
] as const;
const FINGERPRINT_SALT_FILE = 'fingerprint-salt';

type InstallManifest = {
  version: string;
  installed_at: string;
  install_dir: string;
  config_path: string;
  hashes: Record<string, string>;
};

export type HostHookOptions = {
  codex_home?: string;
  surf_home?: string;
  source_dir?: string;
  node_path?: string;
  version?: string;
};

export type HostHookStatus = {
  host: 'codex';
  installed: boolean;
  config_enabled: boolean;
  config_path: string;
  install_dir?: string;
  files_valid: boolean;
  trust_status: 'check /hooks';
  stores_command_output: false;
  warnings: string[];
};

function paths(options: HostHookOptions = {}) {
  const codexHome = resolve(options.codex_home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const surfHome = resolve(options.surf_home ?? process.env.SURF_PROFILE_ROOT ?? join(homedir(), '.google-surf-mcp'));
  const version = options.version ?? VERSION;
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid package version: ${version}`);
  return {
    codexHome,
    surfHome,
    version,
    configPath: join(codexHome, 'config.toml'),
    installRoot: join(surfHome, 'hooks', 'codex'),
    installDir: join(surfHome, 'hooks', 'codex', version),
    manifestPath: join(surfHome, 'hooks', 'codex', 'install.json'),
    sourceDir: resolve(options.source_dir ?? dirname(fileURLToPath(import.meta.url))),
    nodePath: options.node_path ?? process.execPath,
  };
}

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function atomicText(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode });
  await rename(temporary, path);
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function hookBlock(nodePath: string, prePath: string, postPath: string): string {
  const preCommand = `${tomlString(nodePath)} ${tomlString(prePath)}`;
  const postCommand = `${tomlString(nodePath)} ${tomlString(postPath)}`;
  const preWindowsCommand = `& ${preCommand}`;
  const postWindowsCommand = `& ${postCommand}`;
  return [
    MARKER_START,
    '[[hooks.PreToolUse]]',
    'matcher = "^Bash$"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = ${tomlString(preCommand)}`,
    `command_windows = ${tomlString(preWindowsCommand)}`,
    'timeout = 3',
    'statusMessage = "Checking Google Surf shell budget"',
    '',
    '[[hooks.PostToolUse]]',
    'matcher = "^Bash$"',
    '',
    '[[hooks.PostToolUse.hooks]]',
    'type = "command"',
    `command = ${tomlString(postCommand)}`,
    `command_windows = ${tomlString(postWindowsCommand)}`,
    'timeout = 5',
    'statusMessage = "Reranking oversized shell output"',
    MARKER_END,
  ].join('\n');
}

function withoutManagedBlock(config: string): string {
  const escapedStart = MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return config.replace(new RegExp(`(?:\\r?\\n)?${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\r?\\n)?`, 'g'), '\n');
}

function withManagedBlock(config: string, block: string): string {
  const base = withoutManagedBlock(config).trimEnd();
  return `${base}${base ? '\n\n' : ''}${block}\n`;
}

function hooksEnabled(config: string): boolean {
  const lines = config.split(/\r?\n/);
  let inFeatures = false;
  for (const line of lines) {
    if (/^\s*\[[^[]/.test(line)) inFeatures = /^\s*\[features\]\s*$/.test(line);
    if (inFeatures && /^\s*hooks\s*=\s*false\s*$/.test(line)) return false;
  }
  return true;
}

async function backupConfig(configPath: string, content: string): Promise<string | undefined> {
  if (!content) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${configPath}.google-surf-backup-${stamp}`;
  await writeFile(backup, content, { encoding: 'utf8', mode: 0o600 });
  return backup;
}

async function writeManifest(path: string, manifest: InstallManifest): Promise<void> {
  await atomicText(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
}

export async function installCodexHooks(options: HostHookOptions = {}): Promise<HostHookStatus & { backup_path?: string }> {
  const resolved = paths(options);
  await mkdir(resolved.installDir, { recursive: true, mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const file of BUNDLE_FILES) {
    const source = join(resolved.sourceDir, file);
    await stat(source);
    const destination = join(resolved.installDir, file);
    await copyFile(source, destination);
    hashes[file] = await hashFile(destination);
  }
  const saltPath = join(resolved.installDir, FINGERPRINT_SALT_FILE);
  try {
    await stat(saltPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(saltPath, `${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  hashes[FINGERPRINT_SALT_FILE] = await hashFile(saltPath);
  const currentConfig = await optionalText(resolved.configPath);
  const block = hookBlock(
    resolved.nodePath,
    join(resolved.installDir, 'codexShellGuard.js'),
    join(resolved.installDir, 'rerankOutput.js'),
  );
  const nextConfig = withManagedBlock(currentConfig, block);
  let backupPath: string | undefined;
  if (nextConfig !== currentConfig) {
    backupPath = await backupConfig(resolved.configPath, currentConfig);
    const configMode = await stat(resolved.configPath).then((value) => value.mode).catch(() => 0o600);
    await atomicText(resolved.configPath, nextConfig, configMode);
  }
  await writeManifest(resolved.manifestPath, {
    version: resolved.version,
    installed_at: new Date().toISOString(),
    install_dir: resolved.installDir,
    config_path: resolved.configPath,
    hashes,
  });
  return { ...await codexHooksStatus(options), ...(backupPath ? { backup_path: backupPath } : {}) };
}

export async function codexHooksStatus(options: HostHookOptions = {}): Promise<HostHookStatus> {
  const resolved = paths(options);
  const config = await optionalText(resolved.configPath);
  const warnings: string[] = [];
  let manifest: InstallManifest | undefined;
  try {
    manifest = JSON.parse(await readFile(resolved.manifestPath, 'utf8')) as InstallManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Install manifest is unreadable.');
  }
  const installed = config.includes(MARKER_START) && config.includes(MARKER_END) && Boolean(manifest);
  let filesValid = Boolean(manifest);
  if (manifest) {
    for (const file of [...BUNDLE_FILES, FINGERPRINT_SALT_FILE]) {
      try {
        if (await hashFile(join(manifest.install_dir, file)) !== manifest.hashes[file]) filesValid = false;
      } catch {
        filesValid = false;
      }
    }
  }
  const configEnabled = hooksEnabled(config);
  if (!configEnabled) warnings.push('Codex hooks are disabled in config.toml.');
  if (installed && !filesValid) warnings.push('Installed hook files are missing or changed. Run hooks update.');
  if (!installed) warnings.push('Google Surf host output hooks are not installed.');
  return {
    host: 'codex',
    installed,
    config_enabled: configEnabled,
    config_path: resolved.configPath,
    ...(manifest ? { install_dir: manifest.install_dir } : {}),
    files_valid: filesValid,
    trust_status: 'check /hooks',
    stores_command_output: false,
    warnings,
  };
}

function assertManagedPath(path: string, root: string): void {
  const target = resolve(path);
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Refusing to remove path outside the managed hook root: ${target}`);
  }
}

export async function uninstallCodexHooks(options: HostHookOptions = {}): Promise<HostHookStatus & { backup_path?: string }> {
  const resolved = paths(options);
  const currentConfig = await optionalText(resolved.configPath);
  const nextConfig = withoutManagedBlock(currentConfig).replace(/\n{3,}/g, '\n\n').trimEnd();
  let backupPath: string | undefined;
  if (`${nextConfig}${nextConfig ? '\n' : ''}` !== currentConfig) {
    backupPath = await backupConfig(resolved.configPath, currentConfig);
    const configMode = await stat(resolved.configPath).then((value) => value.mode).catch(() => 0o600);
    await atomicText(resolved.configPath, `${nextConfig}${nextConfig ? '\n' : ''}`, configMode);
  }
  assertManagedPath(resolved.installRoot, join(resolved.surfHome, 'hooks'));
  await rm(resolved.installRoot, { recursive: true, force: true });
  for (const stateName of ['google-surf-shell', 'google-surf-output']) {
    const statePath = join(resolved.codexHome, 'hooks', 'state', stateName);
    assertManagedPath(statePath, join(resolved.codexHome, 'hooks', 'state'));
    await rm(statePath, { recursive: true, force: true });
  }
  return { ...await codexHooksStatus(options), ...(backupPath ? { backup_path: backupPath } : {}) };
}

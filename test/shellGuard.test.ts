import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  guardShellInput, isForegroundPolling, minHashSignature, searchTerms, signatureSimilarity,
} from '../src/shellGuard.js';

const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'surf-shell-guard-'));
  roots.push(root);
  return root;
}

function input(command: string, turn = 'turn-1') {
  return {
    session_id: 'session-1',
    turn_id: turn,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex shell guard', () => {
  it('blocks an exact command after two runs without storing command text', async () => {
    const root = stateRoot();
    const command = 'rg -n "private-marker" C:/secret/project';
    expect(await guardShellInput(input(command), { state_root: root })).toBeUndefined();
    expect(await guardShellInput(input(command), { state_root: root })).toBeUndefined();
    expect(await guardShellInput(input(command), { state_root: root })).toContain('same shell command');

    const state = readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(root, name), 'utf8'))
      .join('\n');
    expect(state).not.toContain('private-marker');
  });

  it('detects equivalent search signatures and allows a materially refined query', async () => {
    const root = stateRoot();
    const first = 'rg -n "failed|error" artifacts';
    const second = 'Get-ChildItem artifacts -Recurse | Select-String "error|failed"';
    const similarity = signatureSimilarity(
      minHashSignature(searchTerms(first)),
      minHashSignature(searchTerms(second)),
    );
    expect(similarity).toBeGreaterThanOrEqual(0.85);
    expect(await guardShellInput(input(first), { state_root: root })).toBeUndefined();
    expect(await guardShellInput(input(second), { state_root: root })).toBeUndefined();
    expect(await guardShellInput(input(second), { state_root: root })).toContain('near-duplicate');
    expect(await guardShellInput(input(`${second} perplexity terminal_result final`), { state_root: root })).toBeUndefined();
  });

  it('allows distinct commands throughout a long turn', async () => {
    const root = stateRoot();
    for (let index = 0; index < 30; index++) {
      expect(await guardShellInput(input(`Write-Output value-${index}`), { state_root: root })).toBeUndefined();
    }
  });

  it('allows distinct remote inspections throughout a long turn', async () => {
    const root = stateRoot();
    for (let index = 0; index < 20; index++) {
      expect(await guardShellInput(input(`ssh host-${index} status`), { state_root: root })).toBeUndefined();
    }
  });

  it('allows repeated status checks that are not content searches', async () => {
    const root = stateRoot();
    for (let index = 0; index < 10; index++) {
      expect(await guardShellInput(input('ssh training-host test -f full.done'), { state_root: root }))
        .toBeUndefined();
    }
  });

  it('blocks explicit foreground polling loops', () => {
    expect(isForegroundPolling('while ($true) { Get-Content status.json; Start-Sleep 30 }')).toBe(true);
    expect(isForegroundPolling('tail -f training.log')).toBe(true);
    expect(isForegroundPolling('npm test')).toBe(false);
  });
});

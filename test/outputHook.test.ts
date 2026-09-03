import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { processOutputHook } from '../src/rerankOutput.js';

const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'surf-output-hook-'));
  roots.push(root);
  return root;
}

function input(output: string) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    turn_id: 'turn-1',
    tool_name: 'Bash',
    tool_input: { command: 'find final perplexity and failure' },
    tool_response: { output, exit_code: 0 },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Codex output hook', () => {
  it('passes a small safe result and reranks oversized output', async () => {
    const root = stateRoot();
    expect(await processOutputHook(input('short result'), {
      state_root: root, trigger_chars: 100, max_chars: 500, max_turn_chars: 700,
    })).toBeUndefined();

    const large = `${'still running\n\n'.repeat(80)}final perplexity: 8.42\nstatus: complete`;
    const response = await processOutputHook(input(large), {
      state_root: root, trigger_chars: 100, max_chars: 500, max_turn_chars: 700,
    });
    expect(response).toMatchObject({ continue: false });
    expect(String(response?.stopReason)).toContain('perplexity');
    expect(String(response?.stopReason).length).toBeLessThanOrEqual(500);
  });

  it('redacts secrets and stores counters without source output', async () => {
    const root = stateRoot();
    const marker = 'API_KEY=private-hook-value';
    const response = await processOutputHook(input(`${marker}\nerror: authentication failed`), {
      state_root: root, trigger_chars: 1_000, max_chars: 500, max_turn_chars: 1_000,
    });
    expect(String(response?.stopReason)).toContain('API_KEY=[REDACTED]');
    expect(String(response?.stopReason)).not.toContain('private-hook-value');
    const stateText = readdirSync(root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(root, name), 'utf8'))
      .join('\n');
    expect(stateText).not.toContain('private-hook-value');
    expect(stateText).not.toContain('authentication failed');
  });

  it('replaces later output after the turn budget is exhausted', async () => {
    const root = stateRoot();
    const options = { state_root: root, trigger_chars: 100, max_chars: 300, max_turn_chars: 350 };
    await processOutputHook(input('x'.repeat(300)), options);
    const response = await processOutputHook(input('y'.repeat(300)), options);
    expect(String(response?.stopReason)).toContain('reached its shell-output budget');
  });
});

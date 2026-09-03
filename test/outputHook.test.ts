import { describe, expect, it } from 'vitest';
import { processOutputHook } from '../src/rerankOutput.js';

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

describe('Codex output hook', () => {
  it('passes a small safe result and reranks oversized output', async () => {
    expect(await processOutputHook(input('short result'), {
      trigger_chars: 100, max_chars: 500,
    })).toBeUndefined();

    const large = `${'still running\n\n'.repeat(80)}final perplexity: 8.42\nstatus: complete`;
    const response = await processOutputHook(input(large), {
      trigger_chars: 100, max_chars: 500,
    });
    expect(response).toMatchObject({ decision: 'block' });
    expect(String(response?.reason)).toContain('perplexity');
    expect(String(response?.reason).length).toBeLessThanOrEqual(500);
  });

  it('redacts secrets without persisting source output', async () => {
    const marker = 'API_KEY=private-hook-value';
    const response = await processOutputHook(input(`${marker}\nerror: authentication failed`), {
      trigger_chars: 1_000, max_chars: 500,
    });
    expect(String(response?.reason)).toContain('API_KEY=[REDACTED]');
    expect(String(response?.reason)).not.toContain('private-hook-value');
  });

  it('does not suppress later bounded status output', async () => {
    const options = { trigger_chars: 100, max_chars: 300 };
    await processOutputHook(input('x'.repeat(2_000)), options);
    expect(await processOutputHook(
      input('status: active\nmanifest: integer-centered-v1'),
      options,
    )).toBeUndefined();
  });
});

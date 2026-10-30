import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => vi.unstubAllEnvs());

describe('Codex output hook', () => {
  it('intercepts at 1500 characters and includes the header within the default budget', async () => {
    vi.stubEnv('SURF_RERANK_TRIGGER_CHARS', '');
    vi.stubEnv('SURF_RERANK_MAX_CHARS', '');
    expect(await processOutputHook(input('x'.repeat(1_499)))).toBeUndefined();
    const response = await processOutputHook(input('x'.repeat(1_500)));
    expect(response).toMatchObject({ continue: false });
    expect(response).not.toHaveProperty('decision');
    expect(String(response?.stopReason).length).toBeLessThanOrEqual(1_500);
  });

  it('permits a configured output override above 6000 characters', async () => {
    vi.stubEnv('SURF_RERANK_MAX_CHARS', '12000');
    const rows = Array.from({ length: 12 }, (_, id) => ({ failure: `record-${id} ${'x'.repeat(1_500)}` }));
    const response = await processOutputHook(input(JSON.stringify(rows)));
    expect(String(response?.stopReason).length).toBeGreaterThan(6_000);
    expect(String(response?.stopReason).length).toBeLessThanOrEqual(12_000);
  });

  it('passes a small safe result and reranks oversized output', async () => {
    expect(await processOutputHook(input('short result'), {
      trigger_chars: 100, max_chars: 500,
    })).toBeUndefined();

    const large = `${'still running\n\n'.repeat(80)}final perplexity: 8.42\nstatus: complete`;
    const response = await processOutputHook(input(large), {
      trigger_chars: 100, max_chars: 500,
    });
    expect(response).toMatchObject({ continue: false });
    expect(String(response?.stopReason)).toContain('perplexity');
    expect(String(response?.stopReason).length).toBeLessThanOrEqual(500);
  });

  it('redacts secrets without persisting source output', async () => {
    const marker = 'API_KEY=private-hook-value';
    const response = await processOutputHook(input(`${marker}\nerror: authentication failed`), {
      trigger_chars: 1_000, max_chars: 500,
    });
    expect(String(response?.stopReason)).toContain('API_KEY=[REDACTED]');
    expect(String(response?.stopReason)).not.toContain('private-hook-value');
  });

  it('does not suppress later bounded status output', async () => {
    const options = { trigger_chars: 100, max_chars: 300 };
    await processOutputHook(input('x'.repeat(2_000)), options);
    expect(await processOutputHook(
      input('status: active\nmanifest: integer-centered-v1'),
      options,
    )).toBeUndefined();
  });

  it('still intercepts an accidental giant dump without a configured hard output limit', async () => {
    const response = await processOutputHook(input(`${'still running\n'.repeat(100_000)}\nfinal perplexity: 8.42`));
    expect(response).toMatchObject({ continue: false });
    expect(String(response?.stopReason)).toContain('final perplexity: 8.42');
    expect(String(response?.stopReason)).toContain('Exit code: 0');
    expect(String(response?.stopReason).length).toBeLessThanOrEqual(3_000);
  });

  it('preserves the failed command exit status while compacting the output', async () => {
    const failed = input('failure details\n'.repeat(10_000));
    failed.tool_response.exit_code = 1;
    const response = await processOutputHook(failed);
    expect(response).toMatchObject({ continue: false });
    expect(response).not.toHaveProperty('decision');
    expect(String(response?.stopReason)).toContain('Exit code: 1');
  });
});

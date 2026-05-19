import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    constructor(public opts: { apiKey: string }) {}
    messages = { create: messagesCreate };
  },
}));

const input = {
  compressedHtml: '<html><body><div data-ved="x"><h3>r</h3></div></body></html>',
  brokenSelectors: { block: 'div.MjjYud', snippet: '.VwiC3b' },
  candidates: [
    { blockSelector: '[data-ved]', source: 'data-ved' as const, rationale: 'stable attr' },
  ],
};

describe('repairWithLLM real-path (SDK mocked, tool_use forced)', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.SURF_LLM_HEAL;
    delete process.env.ANTHROPIC_API_KEY;
    messagesCreate.mockReset();
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('skips SDK entirely when SURF_LLM_HEAL is not set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const { repairWithLLM } = await import('../src/heal/llm.js');
    await repairWithLLM(input);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('skips SDK when opted in but no key', async () => {
    process.env.SURF_LLM_HEAL = 'true';
    const { repairWithLLM } = await import('../src/heal/llm.js');
    await repairWithLLM(input);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('sends a tool_choice=tool request and parses the tool_use block', async () => {
    process.env.SURF_LLM_HEAL = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    messagesCreate.mockResolvedValue({
      content: [{
        type: 'tool_use',
        name: 'submit_selector_repair',
        input: {
          decision: 'approve_candidate',
          selector: '[data-ved]',
          rationale: 'stable attribute selector',
          confidence: 'high',
          expected_min_blocks: 8,
        },
      }],
    });
    const { repairWithLLM } = await import('../src/heal/llm.js');
    const out = await repairWithLLM(input);

    const call = messagesCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('submit_selector_repair');
    expect(call.tools[0].input_schema.required).toContain('decision');
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'submit_selector_repair' });
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    expect(out).toEqual({
      decision: 'approve_candidate',
      selector: '[data-ved]',
      rationale: 'stable attribute selector',
      confidence: 'high',
      expected_min_blocks: 8,
    });
  });

  it('handles tool_use mixed with text thinking blocks', async () => {
    process.env.SURF_LLM_HEAL = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    messagesCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me analyze...' },
        {
          type: 'tool_use',
          name: 'submit_selector_repair',
          input: {
            decision: 'propose_new',
            selector: 'div[data-hveid]',
            rationale: 'better than candidates',
            confidence: 'medium',
            expected_min_blocks: 6,
          },
        },
      ],
    });
    const { repairWithLLM } = await import('../src/heal/llm.js');
    const out = await repairWithLLM(input);
    expect(out.decision).toBe('propose_new');
    expect(out.selector).toBe('div[data-hveid]');
  });

  it('throws if the model returned no tool_use block', async () => {
    process.env.SURF_LLM_HEAL = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'I refuse to use the tool' }],
    });
    const { repairWithLLM } = await import('../src/heal/llm.js');
    await expect(repairWithLLM(input)).rejects.toThrow(/expected tool_use/);
  });
});

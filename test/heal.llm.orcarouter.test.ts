import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repairWithLLM } from '../src/heal/llm.js';

const input = {
  compressedHtml: '<html><body><div data-ved="x"><h3>r</h3></div></body></html>',
  brokenSelectors: { block: 'div.MjjYud', snippet: '.VwiC3b' },
  candidates: [
    { blockSelector: '[data-ved]', source: 'data-ved', rationale: 'stable attr' },
  ],
};

describe('repairWithLLM OrcaRouter provider', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.SURF_LLM_HEAL = 'true';
    process.env.SURF_LLM_PROVIDER = 'orcarouter';
    process.env.ORCAROUTER_API_KEY = 'test-orca-key';
    delete process.env.ORCA_KEY;
    delete process.env.SURF_LLM_MODEL;
  });

  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
  });

  it('sends an OpenAI-compatible named tool call and parses its arguments', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'submit_selector_repair',
                arguments: JSON.stringify({
                  decision: 'approve_candidate',
                  selector: '[data-ved]',
                  rationale: 'stable attribute selector',
                  confidence: 'high',
                  expected_min_blocks: 8,
                }),
              },
            }],
          },
        }],
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const output = await repairWithLLM(input);

    expect(output.selector).toBe('[data-ved]');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect(options.headers.authorization).toBe('Bearer test-orca-key');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('orcarouter/auto');
    expect(body.tools[0].function.name).toBe('submit_selector_repair');
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_selector_repair' },
    });
  });

  it('supports the documented model override and ORCA_KEY alias', async () => {
    delete process.env.ORCAROUTER_API_KEY;
    process.env.ORCA_KEY = 'test-orca-alias';
    process.env.SURF_LLM_MODEL = 'deepseek/deepseek-v4-flash-free';
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'submit_selector_repair',
                arguments: {
                  decision: 'propose_new',
                  selector: '[data-hveid]',
                  rationale: 'stable attribute',
                  confidence: 'medium',
                  expected_min_blocks: 5,
                },
              },
            }],
          },
        }],
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await repairWithLLM(input);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      authorization: 'Bearer test-orca-alias',
    });
    expect(body.model).toBe('deepseek/deepseek-v4-flash-free');
  });

  it('returns the upstream status without exposing the API key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid authentication: test-orca-key',
    })));

    const failure = repairWithLLM(input);
    await expect(failure).rejects.toThrow('invalid authentication: [redacted]');
    await expect(failure).rejects.not.toThrow('test-orca-key');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { repairWithLLM } from '../src/heal/llm.js';

const input = {
  compressedHtml: '<html></html>',
  brokenSelectors: { block: 'div.g', snippet: '.VwiC3b' },
  candidates: [{ blockSelector: '[data-ved]', source: 'data-ved' as const, rationale: 'r' }],
};

describe('repairWithLLM opt-in gate', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.SURF_LLM_HEAL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('returns mock when SURF_LLM_HEAL is unset (even with API key present)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key';
    const out = await repairWithLLM(input);
    expect(out.rationale).toMatch(/SURF_LLM_HEAL not enabled/);
    expect(out.selector).toBe('[data-ved]');
  });

  it('returns mock when SURF_LLM_HEAL=false', async () => {
    process.env.SURF_LLM_HEAL = 'false';
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key';
    const out = await repairWithLLM(input);
    expect(out.rationale).toMatch(/SURF_LLM_HEAL not enabled/);
  });

  it('returns mock when opted in but no API key', async () => {
    process.env.SURF_LLM_HEAL = 'true';
    const out = await repairWithLLM(input);
    expect(out.rationale).toMatch(/no API key/);
  });

  it('mock with no candidates falls back to data-ved anchor', async () => {
    const out = await repairWithLLM({ ...input, candidates: [] });
    expect(out.selector).toBe('[data-ved] h3');
    expect(out.decision).toBe('propose_new');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairWithLLM } from '../src/heal/llm.js';
import { savePkceCredential } from '../src/orcarouter/credentials.js';

const input = {
  compressedHtml: '<html><body><div data-ved="x"><h3>r</h3></div></body></html>',
  brokenSelectors: { block: 'div.MjjYud', snippet: '.VwiC3b' },
  candidates: [
    { blockSelector: '[data-ved]', source: 'data-ved', rationale: 'stable attr' },
  ],
};

const MODELS_PAYLOAD = {
  data: [
    { id: 'orcarouter/auto', supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text'] } },
    { id: 'openai/gpt-5.5', supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text', 'image'] } },
  ],
};

function modelDiscoveryResponse(): Response {
  return new Response(JSON.stringify(MODELS_PAYLOAD), { status: 200 });
}

function repairResponse(): Response {
  return new Response(JSON.stringify({
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
  }), { status: 200 });
}

/** Route the model-catalog call and the repair call to separate responses. */
function stubRoutes(repair: () => Response) {
  const fetchMock = vi.fn(async (url: string) => (
    String(url).includes('/models') ? modelDiscoveryResponse() : repair()
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('repairWithLLM OrcaRouter provider', () => {
  const original = { ...process.env };
  let profileRoot: string;

  beforeEach(() => {
    profileRoot = mkdtempSync(join(tmpdir(), 'orca-heal-'));
    process.env.SURF_PROFILE_ROOT = profileRoot;
    process.env.SURF_LLM_HEAL = 'true';
    process.env.SURF_LLM_PROVIDER = 'orcarouter';
    process.env.ORCAROUTER_API_KEY = 'test-orca-key';
    delete process.env.ORCA_KEY;
    delete process.env.SURF_LLM_MODEL;
  });

  afterEach(() => {
    process.env = { ...original };
    rmSync(profileRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('sends an OpenAI-compatible named tool call and parses its arguments', async () => {
    const fetchMock = stubRoutes(repairResponse);

    const output = await repairWithLLM(input);

    expect(output.selector).toBe('[data-ved]');
    const repairCall = fetchMock.mock.calls.find(([url]) => !String(url).includes('/models'))!;
    const [url, options] = repairCall as unknown as [string, RequestInit];
    expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer test-orca-key');
    const body = JSON.parse(String(options.body));
    // The default model comes from the discovered catalog, not a hardcoded name.
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
    const fetchMock = stubRoutes(repairResponse);

    await repairWithLLM(input);

    const repairCall = fetchMock.mock.calls.find(([url]) => !String(url).includes('/models'))!;
    const [, options] = repairCall as unknown as [string, RequestInit];
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer test-orca-alias');
    expect(JSON.parse(String(options.body)).model).toBe('deepseek/deepseek-v4-flash-free');
    // An explicit model override skips discovery entirely.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/models'))).toBe(false);
  });

  it('resolves a PKCE-issued key through the same path as a pasted key', async () => {
    delete process.env.ORCAROUTER_API_KEY;
    delete process.env.ORCA_KEY;
    savePkceCredential('sk-orca-from-connect', 'api', 'user-7', process.env);
    const fetchMock = stubRoutes(repairResponse);

    await repairWithLLM(input);

    const repairCall = fetchMock.mock.calls.find(([url]) => !String(url).includes('/models'))!;
    const [url, options] = repairCall as unknown as [string, RequestInit];
    // Same endpoint, same header shape: downstream cannot tell the sources apart.
    expect(url).toBe('https://api.orcarouter.ai/v1/chat/completions');
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer sk-orca-from-connect');
  });

  it('discovers the catalog on the inference origin with the same credential', async () => {
    const fetchMock = stubRoutes(repairResponse);
    await repairWithLLM(input);
    const [catalogUrl, catalogInit] = fetchMock.mock.calls.find(([url]) => String(url).includes('/models'))! as unknown as [string, RequestInit];
    expect(catalogUrl).toBe('https://api.orcarouter.ai/v1/models?capability=chat');
    expect((catalogInit.headers as Record<string, string>).authorization).toBe('Bearer test-orca-key');
    // Discovery never touches the auth origin.
    expect(catalogUrl).not.toContain('www.orcarouter.ai');
  });

  it('returns the upstream status without exposing the API key', async () => {
    stubRoutes(() => new Response('invalid authentication: test-orca-key', { status: 500 }));

    const failure = repairWithLLM(input);
    await expect(failure).rejects.toThrow('invalid authentication: [redacted]');
    await expect(failure).rejects.not.toThrow('test-orca-key');
  });

  it('treats a 401 as terminal reauthentication, not a refresh', async () => {
    const fetchMock = stubRoutes(() => new Response('key revoked', { status: 401 }));

    await expect(repairWithLLM(input)).rejects.toThrow(/401/);
    // No retry storm and no refresh attempt against any endpoint.
    expect(fetchMock.mock.calls.length).toBe(2);

    // The next call reports the terminal state instead of hitting the relay.
    const afterFailure = stubRoutes(repairResponse);
    await expect(repairWithLLM(input)).rejects.toThrow(/needs reauthentication/);
    expect(afterFailure).not.toHaveBeenCalled();
  });

  it('marks only the rejected generation so a re-login clears the state', async () => {
    // The PKCE credential is the active one, so the 401 applies to it.
    delete process.env.ORCAROUTER_API_KEY;
    savePkceCredential('sk-orca-old', 'api', 'user-7', process.env);
    stubRoutes(() => new Response('revoked', { status: 401 }));
    await expect(repairWithLLM(input)).rejects.toThrow(/401/);

    // The user reauthorizes; the new generation is not marked.
    savePkceCredential('sk-orca-new', 'api', 'user-7', process.env);
    const fetchMock = stubRoutes(repairResponse);
    await expect(repairWithLLM(input)).resolves.toMatchObject({ selector: '[data-ved]' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('falls back to the verified seed when catalog discovery is unavailable', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      String(url).includes('/models') ? (() => { throw new TypeError('fetch failed'); })() : repairResponse()
    ));
    vi.stubGlobal('fetch', fetchMock);

    const output = await repairWithLLM(input);
    expect(output.selector).toBe('[data-ved]');
    const repairCall = fetchMock.mock.calls.find(([url]) => !String(url).includes('/models'))!;
    expect(JSON.parse(String((repairCall as unknown as [string, RequestInit])[1].body)).model)
      .toBe('orcarouter/auto');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { resolveEndpoints } from '../src/orcarouter/endpoints.js';
import {
  defaultChatModel,
  discoverModels,
  filterByCapability,
  MODELS_MAX_ITEMS,
  parseCatalog,
  VERIFIED_SEED,
  type OrcaModel,
} from '../src/orcarouter/models.js';

const endpoints = resolveEndpoints({});
const AT = '2026-09-11T00:00:00.000Z';

/** A payload shaped like GET /v1/models, covering every capability. */
const LIVE_PAYLOAD = {
  data: [
    {
      id: 'openai/gpt-5.5',
      context_length: 400_000,
      reasoning: true,
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
      supported_endpoint_types: ['openai', 'openai-response'],
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'anthropic/claude-opus-4.8',
      context_length: 200_000,
      supported_endpoint_types: ['anthropic'],
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text'] },
    },
    // Declares no endpoint type at all: cannot be proven to speak chat.
    { id: 'mystery/undeclared-model' },
    // Image generation only: must never appear in a chat selector.
    {
      id: 'openai/gpt-image-1',
      supported_endpoint_types: ['image-generation'],
      architecture: { input_modalities: ['text'] },
    },
    {
      id: 'google/veo-3',
      supported_endpoint_types: ['openai-video'],
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'jina/jina-reranker-v3',
      supported_endpoint_types: ['jina-rerank'],
    },
    {
      id: 'openai/text-embedding-3-large',
      supported_endpoint_types: ['embeddings'],
    },
    {
      id: 'qwen/qwen3-vl-235b',
      supported_endpoint_types: ['openai'],
      architecture: { input_modalities: ['text', 'image'] },
    },
  ],
};

function liveModels(): OrcaModel[] {
  return parseCatalog(LIVE_PAYLOAD, AT);
}

describe('catalog parsing', () => {
  it('preserves the vendor/model namespace and bounds the accepted shape', () => {
    const models = liveModels();
    expect(models.map((m) => m.id)).toContain('openai/gpt-5.5');
    // Sorted, bounded, ids kept verbatim.
    expect(models.map((m) => m.id)).toEqual([...models.map((m) => m.id)].sort());
    expect(models.length).toBeLessThanOrEqual(MODELS_MAX_ITEMS);
  });

  it('preserves context, modality and reasoning metadata', () => {
    const gpt = liveModels().find((m) => m.id === 'openai/gpt-5.5');
    expect(gpt?.metadata.contextLength).toBe(400_000);
    expect(gpt?.metadata.inputModalities).toEqual(['text', 'image']);
    expect(gpt?.metadata.reasoning).toBe(true);
    expect(gpt?.metadata.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('drops records with no usable id and tolerates a malformed payload', () => {
    expect(parseCatalog({ data: [{ id: '' }, { id: 7 }, null, 'x'] }, AT)).toEqual([]);
    expect(parseCatalog({ data: 'nope' }, AT)).toEqual([]);
    expect(parseCatalog(null, AT)).toEqual([]);
    expect(parseCatalog({ data: [{ id: 'x'.repeat(500) }] }, AT)).toEqual([]);
  });
});

describe('capability filtering', () => {
  it('keeps only text chat models for the text selector', () => {
    const ids = filterByCapability(liveModels(), 'chat').map((m) => m.id);
    expect(ids).toContain('openai/gpt-5.5');
    expect(ids).toContain('anthropic/claude-opus-4.8');
    expect(ids).toContain('deepseek/deepseek-v4-pro');
    // Non-chat routes and undeclared capability never leak into chat.
    expect(ids).not.toContain('openai/gpt-image-1');
    expect(ids).not.toContain('google/veo-3');
    expect(ids).not.toContain('jina/jina-reranker-v3');
    expect(ids).not.toContain('openai/text-embedding-3-large');
    expect(ids).not.toContain('mystery/undeclared-model');
  });

  it('fails closed for multimodal: only models declaring the uploaded modality', () => {
    const ids = filterByCapability(liveModels(), 'chat', { inputModality: 'image' }).map((m) => m.id);
    expect(ids).toContain('openai/gpt-5.5');
    expect(ids).toContain('qwen/qwen3-vl-235b');
    // Declares text only: not eligible to receive an image attachment.
    expect(ids).not.toContain('deepseek/deepseek-v4-pro');
    // Undeclared capability is excluded rather than assumed.
    expect(ids).not.toContain('mystery/undeclared-model');
    // Non-chat image generators are not multimodal understanding models.
    expect(ids).not.toContain('openai/gpt-image-1');
  });

  it('requires an explicit audio or video declaration for those modalities', () => {
    expect(filterByCapability(liveModels(), 'chat', { inputModality: 'audio' })).toEqual([]);
    expect(filterByCapability(liveModels(), 'chat', { inputModality: 'video' })).toEqual([]);
  });

  it('routes each dedicated capability to its own endpoint type', () => {
    const models = liveModels();
    expect(filterByCapability(models, 'embedding').map((m) => m.id))
      .toEqual(['openai/text-embedding-3-large']);
    expect(filterByCapability(models, 'image').map((m) => m.id))
      .toEqual(['openai/gpt-image-1']);
    expect(filterByCapability(models, 'video').map((m) => m.id))
      .toEqual(['google/veo-3']);
    expect(filterByCapability(models, 'rerank').map((m) => m.id))
      .toEqual(['jina/jina-reranker-v3']);
  });

  it('never guesses a capability from a model name', () => {
    // A model literally named "...-embedding-..." that declares chat is a chat
    // model; a model named "gpt-4" that declares nothing is not offered at all.
    const models = parseCatalog({
      data: [
        { id: 'vendor/embedding-chat-model', supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text'] } },
        { id: 'vendor/gpt-4-turbo' },
      ],
    }, AT);
    expect(filterByCapability(models, 'chat').map((m) => m.id)).toEqual(['vendor/embedding-chat-model']);
    expect(filterByCapability(models, 'embedding')).toEqual([]);
  });
});

describe('live discovery', () => {
  it('fetches the configured catalog origin with the user key and treats success as authoritative', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(LIVE_PAYLOAD), { status: 200 }));
    const catalog = await discoverModels({
      endpoints,
      apiKey: 'sk-orca-live-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: AT,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.orcarouter.ai/v1/models?capability=chat');
    expect(String((init.headers as Record<string, string>).authorization)).toBe('Bearer sk-orca-live-key');

    expect(catalog.source).toBe('live');
    expect(catalog.degraded).toBe(false);
    expect(catalog.status).toBe('ok');
    // Live success is authoritative: no seed model is mixed in.
    const seedIds = new Set(VERIFIED_SEED.map((m) => m.id));
    const liveOnly = catalog.models.filter((m) => seedIds.has(m.id)).map((m) => m.id);
    expect(liveOnly.length).toBe(catalog.models.filter((m) => seedIds.has(m.id)).length);
    expect(catalog.models.every((m) => m.source === 'live')).toBe(true);
  });

  it('falls back to the verified seed with metadata intact when the network fails', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const catalog = await discoverModels({ endpoints, apiKey: 'sk-orca-live-key', fetchImpl: fetchMock as unknown as typeof fetch, now: AT });

    expect(catalog.source).toBe('seed');
    expect(catalog.degraded).toBe(true);
    expect(catalog.status).toBe('network_error');

    const gpt = catalog.models.find((m) => m.id === 'openai/gpt-5.5');
    expect(gpt?.metadata.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(gpt?.metadata.inputModalities).toEqual(['text', 'image']);
    expect(gpt?.metadata.contextLength).toBe(400_000);
    // The seed names are preserved verbatim.
    expect(catalog.models.map((m) => m.id)).toEqual(VERIFIED_SEED.map((m) => m.id));
  });

  it('marks a rejected credential instead of pretending the seed is live', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const catalog = await discoverModels({ endpoints, apiKey: 'sk-orca-revoked', fetchImpl: fetchMock as unknown as typeof fetch, now: AT });
    expect(catalog.status).toBe('unauthorized');
    expect(catalog.degraded).toBe(true);
    expect(catalog.reason).toMatch(/reauthentication/);
  });

  it('degrades on a timeout, a malformed body and an empty catalog', async () => {
    const timeout = vi.fn(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
    expect((await discoverModels({ endpoints, apiKey: 'k', fetchImpl: timeout as unknown as typeof fetch, now: AT })).status)
      .toBe('network_error');
    const malformed = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect((await discoverModels({ endpoints, apiKey: 'k', fetchImpl: malformed as unknown as typeof fetch, now: AT })).status)
      .toBe('malformed');
    const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect((await discoverModels({ endpoints, apiKey: 'k', fetchImpl: empty as unknown as typeof fetch, now: AT })).status)
      .toBe('malformed');
  });

  it('never sends a request without a credential', async () => {
    const fetchMock = vi.fn();
    const catalog = await discoverModels({ endpoints, fetchImpl: fetchMock as unknown as typeof fetch, now: AT });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(catalog.status).toBe('unauthorized');
    expect(catalog.degraded).toBe(true);
  });

  it('bounds an oversized response instead of buffering it', async () => {
    const huge = `{"data":[{"id":"a"},${'"x":1,'.repeat(300_000)}]}`;
    const fetchMock = vi.fn(async () => new Response(huge, { status: 200 }));
    const catalog = await discoverModels({ endpoints, apiKey: 'k', fetchImpl: fetchMock as unknown as typeof fetch, now: AT });
    expect(catalog.status).toBe('malformed');
  });

  it('picks an OrcaRouter model from the catalog rather than a hardcoded example', async () => {
    const live = await discoverModels({
      endpoints,
      apiKey: 'k',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(LIVE_PAYLOAD), { status: 200 })) as unknown as typeof fetch,
      now: AT,
    });
    // orcarouter/auto is not in the live payload, so the first proven chat model wins.
    expect(defaultChatModel(live)).toBe('anthropic/claude-opus-4.8');

    // With the gateway's auto-routing entry present, it is preferred.
    const withAuto = parseCatalog({
      data: [
        { id: 'vendor/z', supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text'] } },
        { id: 'orcarouter/auto', supported_endpoint_types: ['openai'], architecture: { input_modalities: ['text'] } },
      ],
    }, AT);
    expect(defaultChatModel({ models: withAuto, source: 'live', degraded: false, fetchedAt: AT, status: 'ok' }))
      .toBe('orcarouter/auto');
  });

  it('keeps the seed default usable while degraded', () => {
    const degraded = {
      models: VERIFIED_SEED,
      source: 'seed' as const,
      degraded: true,
      fetchedAt: AT,
      status: 'network_error' as const,
    };
    expect(defaultChatModel(degraded)).toBe('orcarouter/auto');
  });
});

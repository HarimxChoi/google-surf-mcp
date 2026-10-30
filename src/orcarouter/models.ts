// OrcaRouter model catalog.
//
// The single source of truth for the model selector is `GET {apiBase}/v1/models`
// under the configured origin, fetched with the user's own key so the list is
// what that workspace can actually call. A small verified seed keeps a fresh
// installation usable during an outage; when live discovery succeeds its result
// is authoritative and the seed is not mixed into it.

import type { OrcaEndpoints } from './endpoints.js';
import { redactSecrets } from './credentials.js';

export type OrcaCapability = 'chat' | 'embedding' | 'image' | 'video' | 'rerank';

/** Endpoint types that mean "this model answers a text chat completion". */
const CHAT_ENDPOINT_TYPES = ['openai', 'anthropic', 'gemini', 'openai-response'] as const;
/** Endpoint types that serve a dedicated non-chat modality. */
const DEDICATED_ENDPOINT_TYPES = ['image-generation', 'openai-video', 'jina-rerank', 'embeddings'] as const;

export const MODELS_TIMEOUT_MS = 10_000;
export const MODELS_MAX_BYTES = 2_000_000;
export const MODELS_MAX_ITEMS = 500;
const MODELS_MAX_ID_LENGTH = 200;

export interface OrcaModelMetadata {
  contextLength?: number;
  /** Declared input modalities. Empty means "not declared", which fails closed. */
  inputModalities: string[];
  supportedEndpointTypes: string[];
  reasoning: boolean;
  reasoningEfforts: string[];
}

export interface OrcaModel {
  id: string;
  metadata: OrcaModelMetadata;
  source: 'live' | 'seed';
}

export interface OrcaCatalog {
  models: OrcaModel[];
  source: 'live' | 'seed';
  /** True when live discovery failed and a fallback catalog is being served. */
  degraded: boolean;
  reason?: string;
  fetchedAt: string;
}

/**
 * Verified cold-start fallback. Not a hand-written sample of the live catalog:
 * it exists so `SURF_LLM_PROVIDER=orcarouter` still resolves a model when the
 * catalog endpoint is slow or unreachable, and it is only ever served with the
 * `degraded` flag set.
 */
export const VERIFIED_SEED: OrcaModel[] = [
  {
    id: 'openai/gpt-5.5',
    source: 'seed',
    metadata: {
      contextLength: 400_000,
      inputModalities: ['text', 'image'],
      supportedEndpointTypes: ['openai', 'openai-response'],
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
  },
  {
    id: 'anthropic/claude-opus-4.8',
    source: 'seed',
    metadata: {
      contextLength: 200_000,
      inputModalities: ['text', 'image'],
      supportedEndpointTypes: ['anthropic', 'openai'],
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'google/gemini-3.5-flash',
    source: 'seed',
    metadata: {
      contextLength: 1_000_000,
      inputModalities: ['text', 'image', 'audio', 'video'],
      supportedEndpointTypes: ['gemini', 'openai'],
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    source: 'seed',
    metadata: {
      contextLength: 128_000,
      inputModalities: ['text'],
      supportedEndpointTypes: ['openai'],
      reasoning: true,
      reasoningEfforts: ['low', 'medium', 'high'],
    },
  },
  {
    id: 'orcarouter/auto',
    source: 'seed',
    metadata: {
      contextLength: 200_000,
      inputModalities: ['text'],
      supportedEndpointTypes: ['openai'],
      reasoning: false,
      reasoningEfforts: [],
    },
  },
];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function parseMetadata(record: Record<string, unknown>): OrcaModelMetadata {
  const architecture = (record.architecture ?? {}) as Record<string, unknown>;
  const modalities = asStringArray(architecture.input_modalities ?? record.input_modalities);
  const endpointTypes = asStringArray(
    record.supported_endpoint_types ?? architecture.supported_endpoint_types,
  );
  const rawEfforts = asStringArray(
    record.reasoning_efforts ?? (record.reasoning as Record<string, unknown> | undefined)?.efforts,
  );
  const contextLength = Number(record.context_length ?? record.context_window);

  return {
    contextLength: Number.isFinite(contextLength) && contextLength > 0 ? contextLength : undefined,
    inputModalities: modalities.map((m) => m.toLowerCase()),
    supportedEndpointTypes: endpointTypes.map((t) => t.toLowerCase()),
    reasoning: record.reasoning === true || rawEfforts.length > 0,
    reasoningEfforts: rawEfforts,
  };
}

/**
 * Parse a `/v1/models` payload defensively: bounded item count, bounded id
 * length, unknown shapes dropped rather than trusted.
 */
export function parseCatalog(payload: unknown, fetchedAt: string): OrcaModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: OrcaModel[] = [];
  for (const entry of data.slice(0, MODELS_MAX_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > MODELS_MAX_ID_LENGTH) continue;
    models.push({ id, metadata: parseMetadata(record), source: 'live' });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function hasAnyEndpointType(metadata: OrcaModelMetadata, types: readonly string[]): boolean {
  return metadata.supportedEndpointTypes.some((type) => types.includes(type));
}

// A model with no declared endpoint types cannot be proven to speak any chat
// wire format, so it fails closed rather than being offered on a guess.
function isTextChatModel(model: OrcaModel): boolean {
  const { supportedEndpointTypes } = model.metadata;
  if (supportedEndpointTypes.length === 0) return false;
  if (!hasAnyEndpointType(model.metadata, CHAT_ENDPOINT_TYPES)) return false;
  // A model whose only declared route is a dedicated non-chat modality is not
  // a text chat model, even if it also exposes an OpenAI-shaped surface.
  const onlyDedicated = supportedEndpointTypes.every((type) =>
    (DEDICATED_ENDPOINT_TYPES as readonly string[]).includes(type));
  return !onlyDedicated;
}

/**
 * Filter the catalog for one entry point. Every capability is derived from
 * declared catalog metadata; nothing is inferred from the model name.
 */
export function filterByCapability(
  models: readonly OrcaModel[],
  capability: OrcaCapability,
  options: { inputModality?: string } = {},
): OrcaModel[] {
  switch (capability) {
    case 'chat': {
      const chat = models.filter(isTextChatModel);
      const modality = options.inputModality;
      if (!modality || modality === 'text') return chat;
      // Multimodal understanding: chat first, then the declared input modality
      // must actually include what this entry point uploads. Undeclared fails
      // closed and is never mixed into a multimodal selector.
      const wanted = modality.toLowerCase();
      return chat.filter((model) => model.metadata.inputModalities.includes(wanted));
    }
    case 'embedding':
      return models.filter((model) => hasAnyEndpointType(model.metadata, ['embeddings']));
    case 'image':
      return models.filter((model) => hasAnyEndpointType(model.metadata, ['image-generation']));
    case 'video':
      return models.filter((model) => hasAnyEndpointType(model.metadata, ['openai-video']));
    case 'rerank':
      return models.filter((model) => hasAnyEndpointType(model.metadata, ['jina-rerank']));
    default:
      return [];
  }
}

export interface DiscoveryOptions {
  endpoints: OrcaEndpoints;
  apiKey?: string;
  /**
   * Catalog slice to request. Chat, embedding and image have documented
   * `?capability=` values; video and rerank are matched strictly against
   * endpoint type instead, so they request the unfiltered catalog.
   */
  capability?: OrcaCapability;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: string;
}

/** Capabilities the endpoint accepts as a `?capability=` value. */
const QUERYABLE_CAPABILITIES: readonly OrcaCapability[] = ['chat', 'embedding', 'image'];

export function catalogUrl(endpoints: OrcaEndpoints, capability: OrcaCapability = 'chat'): string {
  return QUERYABLE_CAPABILITIES.includes(capability)
    ? `${endpoints.modelsUrl}?capability=${capability}`
    : endpoints.modelsUrl;
}

export interface DiscoveryResult extends OrcaCatalog {
  /** Set when the live catalog could not be used, for the UI's degraded hint. */
  status: 'ok' | 'unauthorized' | 'network_error' | 'malformed';
}

function seedCatalog(reason: string, status: DiscoveryResult['status'], now: string): DiscoveryResult {
  return {
    models: VERIFIED_SEED.map((model) => ({ ...model, metadata: { ...model.metadata } })),
    source: 'seed',
    degraded: true,
    reason,
    fetchedAt: now,
    status,
  };
}

/**
 * Live discovery. The request is bounded in time and bytes, and a failure
 * degrades to the verified seed instead of leaving the provider with no models.
 */
export async function discoverModels(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const now = options.now ?? new Date().toISOString();
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return seedCatalog('no OrcaRouter credential is configured', 'unauthorized', now);

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = catalogUrl(options.endpoints, options.capability ?? 'chat');

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    return seedCatalog(`model discovery failed: ${name === 'TimeoutError' ? 'timeout' : 'network error'}`, 'network_error', now);
  }

  if (response.status === 401 || response.status === 403) {
    return seedCatalog('model discovery was rejected: the credential needs reauthentication', 'unauthorized', now);
  }
  if (!response.ok) {
    return seedCatalog(`model discovery failed with status ${response.status}`, 'network_error', now);
  }

  const body = await readBounded(response);
  if (body === null) return seedCatalog('model discovery response exceeded the size bound', 'malformed', now);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return seedCatalog('model discovery returned a malformed payload', 'malformed', now);
  }

  const models = parseCatalog(payload, now);
  if (models.length === 0) return seedCatalog('model discovery returned an empty catalog', 'malformed', now);

  // Live success is authoritative: the seed is not merged into it.
  return { models, source: 'live', degraded: false, fetchedAt: now, status: 'ok' };
}

async function readBounded(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => '');
  if (text.length > MODELS_MAX_BYTES) return null;
  return text;
}

export function formatCatalogError(error: unknown, apiKey?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, [apiKey]);
}

/**
 * Default model for a text entry point when nothing is configured. The
 * gateway's own auto-routing entry is preferred when the catalog offers it,
 * otherwise the first model the catalog proves is a text chat model. The seed
 * only answers when discovery has degraded.
 */
export function defaultChatModel(catalog: OrcaCatalog): string {
  const chat = filterByCapability(catalog.models, 'chat');
  const auto = chat.find((model) => model.id === 'orcarouter/auto');
  return (auto ?? chat[0] ?? catalog.models[0])?.id ?? 'orcarouter/auto';
}

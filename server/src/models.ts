import { config } from './config.js';
import {
  CUSTOM_MODEL_ID_PATTERN,
  type LlmProvider,
  type ModelInfo,
  type ModelsResponse,
  type ProviderDiscovery,
} from '../../shared/apiTypes.js';

export type { ModelInfo };

export const PROVIDER_BASE_URLS: Record<LlmProvider, string> = {
  openrouter: config.openRouterBaseUrl,
  groq: config.groqBaseUrl,
};

const PROVIDER_NAME: Record<LlmProvider, string> = { groq: 'Groq', openrouter: 'OpenRouter' };

/** How long a discovered model list is reused before the provider is asked again. */
export const CATALOG_TTL_MS = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 6000;
/** `?refresh=true` is ignored if the last fetch is younger than this (protects provider rate limits). */
const MIN_REFRESH_INTERVAL_MS = 10_000;

/** OpenRouter's auto-router: picks an available free model per request. Always listed first. */
export const OPENROUTER_AUTO_FREE = 'openrouter/free';

/**
 * Curated fallback lists (free models verified live in Nov 2026), used only when
 * discovery fails. Override with GROQ_MODELS / OPENROUTER_MODELS in server/.env.
 */
const CURATED: Record<LlmProvider, ReadonlyArray<string>> = {
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'allam-2-7b'],
  openrouter: [
    OPENROUTER_AUTO_FREE,
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'recursive/flint-v1.0:free',
  ],
};

/** Groq ids that are not chat models (speech, TTS, guard/safety classifiers). */
const GROQ_EXCLUDE = /whisper|orpheus|prompt-guard|safeguard|llama-guard|playai|tts/i;

const OFFLINE_MODELS: ReadonlyArray<ModelInfo> = [
  {
    id: 'offline:heuristic',
    provider: 'offline',
    model: '',
    label: 'Heuristic Shaman',
    available: true,
    description: 'Built-in bot: maximises mobility and centre control. No API key needed.',
    source: 'builtin',
  },
  {
    id: 'offline:random',
    provider: 'offline',
    model: '',
    label: 'Random Spirit',
    available: true,
    description: 'Built-in bot: picks a random legal move. No API key needed.',
    source: 'builtin',
  },
];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface DiscoveredModel {
  model: string;
  label: string;
  contextLength: number | null;
  /** OpenRouter `supported_parameters` (null = unknown, e.g. Groq). */
  supportedParameters: ReadonlyArray<string> | null;
  /** OpenRouter `reasoning.mandatory`: reasoning cannot be disabled, only capped. */
  reasoningMandatory?: boolean;
}

interface ProviderState {
  models: DiscoveredModel[] | null;
  fetchedAt: number | null;
  error: string | null;
  inflight: Promise<void> | null;
}

const state: Record<LlmProvider, ProviderState> = {
  groq: { models: null, fetchedAt: null, error: null, inflight: null },
  openrouter: { models: null, fetchedAt: null, error: null, inflight: null },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

function apiKey(provider: LlmProvider): string | null {
  return provider === 'groq' ? config.groqApiKey : config.openRouterApiKey;
}

/** Text-in / text-out only (drops audio, image-generation and music models). */
function isTextChat(arch: unknown): boolean {
  if (!isObj(arch)) return true;
  const out = strings(arch.output_modalities);
  const input = strings(arch.input_modalities);
  if (out && (out.length !== 1 || out[0] !== 'text')) return false;
  if (input && !input.includes('text')) return false;
  return true;
}

/** Groq: every active chat/reasoning model (excludes whisper, orpheus, prompt-guard, safeguard...). */
export function filterGroqModels(payload: unknown): DiscoveredModel[] {
  const data = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
  const out: DiscoveredModel[] = [];
  for (const m of data as unknown[]) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id || m.active === false || GROQ_EXCLUDE.test(id)) continue;
    if (!isTextChat({ input_modalities: m.input_modalities, output_modalities: m.output_modalities })) continue;
    out.push({ model: id, label: str(m.name) ?? id, contextLength: num(m.context_window) ?? num(m.context_length), supportedParameters: null });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/** OpenRouter: zero-priced (or `:free`) text chat models; `openrouter/free` first. */
export function filterOpenRouterModels(payload: unknown, now = Date.now()): DiscoveredModel[] {
  const data = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
  const out: DiscoveredModel[] = [];
  for (const m of data as unknown[]) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id) continue;
    const pricing = isObj(m.pricing) ? m.pricing : {};
    const free = (pricing.prompt === '0' && pricing.completion === '0') || id.endsWith(':free');
    if (!free || !isTextChat(m.architecture)) continue;
    const expires = str(m.expiration_date);
    if (expires && Date.parse(expires) < now) continue;
    out.push({
      model: id,
      label: (str(m.name) ?? id).replace(/\s*\(free\)\s*$/i, ''),
      contextLength: num(m.context_length),
      supportedParameters: strings(m.supported_parameters),
      reasoningMandatory: isObj(m.reasoning) && m.reasoning.mandatory === true,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  const autoIndex = out.findIndex((m) => m.model === OPENROUTER_AUTO_FREE);
  const auto = autoIndex >= 0 ? out.splice(autoIndex, 1)[0]! : null;
  return [
    auto ?? { model: OPENROUTER_AUTO_FREE, label: 'Free Models Router', contextLength: null, supportedParameters: null },
    ...out,
  ];
}

async function discover(provider: LlmProvider): Promise<void> {
  const key = apiKey(provider);
  if (!key) return;
  const p = state[provider];
  try {
    const res = await fetch(`${PROVIDER_BASE_URLS[provider]}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: unknown = await res.json();
    const models = provider === 'groq' ? filterGroqModels(payload) : filterOpenRouterModels(payload);
    if (models.length === 0) throw new Error('no free chat models in the response');
    p.models = models;
    p.fetchedAt = Date.now();
    p.error = null;
  } catch (err) {
    // Keep the last good list (if any); otherwise the curated list is served.
    p.error = err instanceof Error ? (err.name === 'TimeoutError' ? 'discovery timed out' : err.message.slice(0, 160)) : 'discovery failed';
    p.fetchedAt = p.fetchedAt ?? null;
    console.warn(`[models] ${PROVIDER_NAME[provider]} discovery failed: ${p.error}`);
  }
}

async function ensureFresh(provider: LlmProvider, refresh: boolean): Promise<void> {
  if (!apiKey(provider)) return;
  const p = state[provider];
  const age = p.fetchedAt === null ? Infinity : Date.now() - p.fetchedAt;
  const lastAttemptFailed = p.error !== null;
  const stale = age > CATALOG_TTL_MS || (refresh && age > MIN_REFRESH_INTERVAL_MS) || (lastAttemptFailed && refresh);
  if (!stale && p.models) return;
  if (!p.inflight) p.inflight = discover(provider).finally(() => (p.inflight = null));
  await p.inflight;
}

function curated(provider: LlmProvider): DiscoveredModel[] {
  const override = provider === 'groq' ? config.groqModels : config.openRouterModels;
  return (override ?? CURATED[provider]).map((model) => ({ model, label: prettify(model), contextLength: null, supportedParameters: null }));
}

function prettify(model: string): string {
  if (model === OPENROUTER_AUTO_FREE) return 'Free Models Router';
  return model.split('/').pop()!.replace(/:free$/, '');
}

function toInfo(provider: LlmProvider, d: DiscoveredModel, source: 'live' | 'curated'): ModelInfo {
  const available = apiKey(provider) !== null;
  const auto = d.model === OPENROUTER_AUTO_FREE;
  return {
    id: `${provider}:${d.model}`,
    provider,
    model: d.model,
    label: auto ? 'Free Models Router (auto)' : d.label,
    available,
    description: !available
      ? `Set ${provider === 'groq' ? 'GROQ_API_KEY' : 'OPENROUTER_API_KEY'} in server/.env to enable.`
      : auto
        ? 'OpenRouter picks any available free model for each request.'
        : `${PROVIDER_NAME[provider]} free tier: ${d.model}${source === 'curated' ? ' (curated list; live discovery unavailable)' : ''}`,
    source,
    contextLength: d.contextLength,
  };
}

function providerModels(provider: LlmProvider): { list: ModelInfo[]; discovery: ProviderDiscovery } {
  const p = state[provider];
  const live = p.models !== null;
  const list = (live ? p.models! : curated(provider)).map((d) => toInfo(provider, d, live ? 'live' : 'curated'));
  const status: ProviderDiscovery['status'] = !apiKey(provider) ? 'no-key' : live ? 'live' : 'fallback';
  return {
    list,
    discovery: { status, fetchedAt: p.fetchedAt === null ? null : new Date(p.fetchedAt).toISOString(), error: p.error, count: list.length },
  };
}

/** Full catalog for `GET /api/models`: offline bots, then Groq, then OpenRouter. */
export async function getModelCatalog(options: { refresh?: boolean } = {}): Promise<ModelsResponse> {
  const refresh = options.refresh === true;
  await Promise.all([ensureFresh('groq', refresh), ensureFresh('openrouter', refresh)]);
  const groq = providerModels('groq');
  const openrouter = providerModels('openrouter');
  return {
    models: [...OFFLINE_MODELS, ...groq.list, ...openrouter.list],
    providers: { offline: true, groq: config.groqApiKey !== null, openrouter: config.openRouterApiKey !== null },
    discovery: { groq: groq.discovery, openrouter: openrouter.discovery },
  };
}

/** Models known right now (cached discovery or curated lists), without network access. */
export function listModels(): ModelInfo[] {
  return [...OFFLINE_MODELS, ...providerModels('groq').list, ...providerModels('openrouter').list];
}

/** Request capabilities from discovery: OpenRouter `supported_parameters` (null = unknown) and mandatory reasoning. */
export function modelCapabilities(model: ModelInfo): { supportedParameters: ReadonlyArray<string> | null; reasoningMandatory: boolean } {
  const found = model.provider === 'offline' ? undefined : state[model.provider].models?.find((m) => m.model === model.model);
  return { supportedParameters: found?.supportedParameters ?? null, reasoningMandatory: found?.reasoningMandatory === true };
}

/**
 * Resolves a model id. Ids not in the catalog are accepted when they match
 * `groq:<model>` / `openrouter:<model>` (custom ids for newly released models).
 */
export function resolveModel(id: string): ModelInfo | null {
  const known = listModels().find((m) => m.id === id);
  if (known) return known;
  if (!CUSTOM_MODEL_ID_PATTERN.test(id)) return null;
  const sep = id.indexOf(':');
  const provider = id.slice(0, sep) as LlmProvider;
  const model = id.slice(sep + 1);
  const available = apiKey(provider) !== null;
  return {
    id,
    provider,
    model,
    label: `${prettify(model)} (custom)`,
    available,
    description: `Custom ${PROVIDER_NAME[provider]} model id.`,
    source: 'custom',
    contextLength: null,
  };
}

/** Test hook: forget discovered lists. */
export function resetModelCatalog(): void {
  for (const p of Object.values(state)) {
    p.models = null;
    p.fetchedAt = null;
    p.error = null;
  }
}

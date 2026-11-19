import { config } from './config.js';

import type { AiProvider as Provider, ModelInfo } from '../../shared/apiTypes.js';

export type { ModelInfo };

export const PROVIDER_BASE_URLS: Record<Exclude<Provider, 'offline'>, string> = {
  openrouter: config.openRouterBaseUrl,
  groq: config.groqBaseUrl,
};

const DEFAULT_OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'deepseek/deepseek-r1:free',
  'google/gemma-2-9b-it:free',
];

const DEFAULT_GROQ_MODELS = ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'];

const PRETTY: Record<string, string> = {
  'meta-llama/llama-3.3-70b-instruct:free': 'Llama 3.3 70B',
  'qwen/qwen-2.5-72b-instruct:free': 'Qwen 2.5 72B',
  'deepseek/deepseek-r1:free': 'DeepSeek R1',
  'google/gemma-2-9b-it:free': 'Gemma 2 9B',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B',
  'mixtral-8x7b-32768': 'Mixtral 8x7B',
};

function pretty(model: string): string {
  return PRETTY[model] ?? model.split('/').pop()!.replace(/:free$/, '');
}

export function listModels(): ModelInfo[] {
  const offline: ModelInfo[] = [
    {
      id: 'offline:heuristic',
      provider: 'offline',
      model: '',
      label: 'Heuristic Shaman',
      available: true,
      description: 'Built-in bot: maximises mobility and centre control. No API key needed.',
    },
    {
      id: 'offline:random',
      provider: 'offline',
      model: '',
      label: 'Random Spirit',
      available: true,
      description: 'Built-in bot: picks a random legal move. No API key needed.',
    },
  ];
  const openrouter = (config.openRouterModels ?? DEFAULT_OPENROUTER_MODELS).map(
    (model): ModelInfo => ({
      id: `openrouter:${model}`,
      provider: 'openrouter',
      model,
      label: `${pretty(model)} (OpenRouter)`,
      available: config.openRouterApiKey !== null,
      description: config.openRouterApiKey ? `OpenRouter free tier: ${model}` : 'Set OPENROUTER_API_KEY in server/.env to enable.',
    }),
  );
  const groq = (config.groqModels ?? DEFAULT_GROQ_MODELS).map(
    (model): ModelInfo => ({
      id: `groq:${model}`,
      provider: 'groq',
      model,
      label: `${pretty(model)} (Groq)`,
      available: config.groqApiKey !== null,
      description: config.groqApiKey ? `Groq free tier: ${model}` : 'Set GROQ_API_KEY in server/.env to enable.',
    }),
  );
  return [...offline, ...openrouter, ...groq];
}

/**
 * Resolves a model id. Unknown ids of the form `openrouter:<model>` / `groq:<model>`
 * are accepted too, so new free models can be tried without a code change.
 */
export function resolveModel(id: string): ModelInfo | null {
  const known = listModels().find((m) => m.id === id);
  if (known) return known;
  const match = /^(openrouter|groq):(.{1,120})$/.exec(id);
  if (!match) return null;
  const provider = match[1] as 'openrouter' | 'groq';
  const model = match[2]!;
  const available = provider === 'openrouter' ? config.openRouterApiKey !== null : config.groqApiKey !== null;
  return { id, provider, model, label: `${pretty(model)} (${provider === 'groq' ? 'Groq' : 'OpenRouter'})`, available, description: '' };
}

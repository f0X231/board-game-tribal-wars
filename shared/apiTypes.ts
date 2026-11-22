/**
 * HTTP contract between /server (AI Arena API) and /client. Types only.
 */
import type { GameState, MoveAction, Position } from './gameEngine.ts';

/** `research` = the 7 deep-search bots from the Amazons literature (server-only, CPU search). */
export type AiProvider = 'offline' | 'research' | 'openrouter' | 'groq';

export interface ModelInfo {
  /** Stable id, e.g. `offline:heuristic`, `groq:llama-3.3-70b-versatile`, `openrouter:<model>:free`. */
  id: string;
  provider: AiProvider;
  /** Model name sent to the provider API (empty for offline bots). */
  model: string;
  label: string;
  /** True if the model can actually be called (offline bots, or provider key configured on the server). */
  available: boolean;
  description: string;
  /** `live` = discovered from the provider's /models endpoint, `curated` = built-in fallback list, `custom` = user-typed id. */
  source?: 'builtin' | 'research' | 'live' | 'curated' | 'custom';
  /** Context window in tokens, when the provider reports it. */
  contextLength?: number | null;
  /** Research bots: the paper the algorithm follows, e.g. `Hensgens 2001`. */
  paper?: string;
  /** Research bots: per-turn thinking budget in ms (server `BOT_TIME_BUDGET_MS`). */
  budgetMs?: number;
}

export type LlmProvider = Exclude<AiProvider, 'offline' | 'research'>;

/** How a provider's model list was obtained. */
export interface ProviderDiscovery {
  /** `live` = fetched from the provider, `fallback` = discovery failed (curated list), `no-key` = provider disabled. */
  status: 'live' | 'fallback' | 'no-key';
  /** ISO time of the last successful fetch (null if never). */
  fetchedAt: string | null;
  error: string | null;
  count: number;
}

/** `GET /api/models[?refresh=true]` */
export interface ModelsResponse {
  models: ModelInfo[];
  providers: Record<AiProvider, boolean>;
  discovery?: Record<LlmProvider, ProviderDiscovery>;
}

/** Custom model ids: `groq:<model>` or `openrouter:<vendor/model[:tag]>`. */
export const CUSTOM_MODEL_ID_PATTERN = /^(groq|openrouter):[A-Za-z0-9][A-Za-z0-9._\-/:]{0,119}$/;

/** Research bot ids are `research:<name>`. */
export const isResearchModelId = (id: string): boolean => id.startsWith('research:');

/** `POST /api/ai-turn` request body. */
export interface AiTurnRequest {
  state: GameState;
  modelId: string;
}

/** What was decided, and by which bot (e.g. `offline:heuristic` after a fallback). */
export type AiDecision =
  | { kind: 'placement'; placement: Position; reasoning: string; modelUsed: string }
  | { kind: 'move'; move: MoveAction; reasoning: string; modelUsed: string };

/** `POST /api/ai-turn` response body. */
export type AiTurnResponse = AiDecision & {
  modelRequested: string;
  /** True if the requested model failed (no key, timeout, bad JSON...) and the heuristic decided instead. */
  fallback: boolean;
  latencyMs: number;
};

/** Error body for non-2xx responses. */
export interface ApiError {
  error: string;
}

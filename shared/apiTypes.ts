/**
 * HTTP contract between /server (AI Arena API) and /client. Types only.
 */
import type { GameState, MoveAction, Position } from './gameEngine.ts';

export type AiProvider = 'offline' | 'openrouter' | 'groq';

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
}

/** `GET /api/models` */
export interface ModelsResponse {
  models: ModelInfo[];
  providers: Record<AiProvider, boolean>;
}

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

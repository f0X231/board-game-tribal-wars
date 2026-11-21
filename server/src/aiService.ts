import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
  getValidActions,
  getValidPlacements,
  validateAction,
  validatePlacement,
  type GameState,
  type MoveAction,
  type PlayerId,
  type Position,
} from '../../shared/gameEngine.js';
import {
  explainAction,
  explainPlacement,
  heuristicAction,
  heuristicPlacement,
  randomAction,
  randomPlacement,
  rankActions,
  rankPlacements,
} from '../../shared/aiBots.js';
import { config } from './config.js';
import { PROVIDER_BASE_URLS, modelCapabilities, resolveModel, type ModelInfo } from './models.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type { AiDecision, AiTurnResponse as AiTurnResult } from '../../shared/apiTypes.js';
import type { AiDecision, AiTurnResponse as AiTurnResult } from '../../shared/apiTypes.js';

export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** How many engine-ranked candidates the LLM may choose from. */
const MAX_ACTION_CHOICES = 20;
const MAX_PLACEMENT_CHOICES = 15;

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

const TRIBE: Record<PlayerId, string> = { P1: 'Aztec', P2: 'Maya', P3: 'Eagle', P4: 'Big Bear' };
const coord = (p: Position) => `${String.fromCharCode(65 + p.col)}${p.row + 1}`;

export function renderBoard(state: GameState): string {
  const header = '    ' + state.board[0]!.map((_, c) => String.fromCharCode(65 + c)).join(' ');
  const rows = state.board.map(
    (row, r) =>
      `${String(r + 1).padStart(2, ' ')}  ` +
      row.map((cell) => (cell === 'EMPTY' ? '.' : cell === 'FIRE' ? '#' : cell.slice(1))).join(' '),
  );
  return [header, ...rows].join('\n');
}

const SYSTEM_PROMPT = `You are an expert player of "Tribal Wars", a turn-based territory game on a square grid.
Rules:
- Each turn a player MOVES one of their totems like a chess queen (any distance orthogonally/diagonally, never through or onto totems or fire).
- The square the totem left becomes permanent FIRE.
- From its new square the totem then SHOOTS a fire arrow like a queen move; the square where the arrow lands becomes permanent FIRE.
- Fire and totems block movement and arrows forever.
- A tribe that cannot complete a move AND a shot at the start of its turn is eliminated. Last tribe standing wins.
Strategy: keep your totems mobile (many open queen lines), restrict opponents' space, wall off territory, avoid getting boxed in.
You will be given a numbered list of LEGAL options computed by the game engine. You MUST pick one of them by its index.
Reply with ONLY a JSON object, no markdown.`;

function legend(state: GameState): string {
  return state.players.map((p) => `${p.slice(1)} = ${TRIBE[p]}${state.eliminated.includes(p) ? ' (eliminated)' : ''}`).join(', ');
}

function battlePrompt(state: GameState, choices: MoveAction[]): string {
  const me = state.currentPlayer;
  const lines = choices.map(
    (a, i) => `${i}: move ${coord(a.from)} -> ${coord(a.to)}, shoot arrow at ${coord(a.shoot)}`,
  );
  return `You are ${TRIBE[me]} (pieces marked "${me.slice(1)}"). Turn ${state.turnNumber + 1}, battle phase.
Board (rows 1-${state.boardSize} top to bottom, columns A-${String.fromCharCode(64 + state.boardSize)}; "." empty, "#" fire, digits = tribes: ${legend(state)}):
${renderBoard(state)}

Legal options (pre-screened by the engine, roughly best-first; you may choose any):
${lines.join('\n')}

Respond with exactly: {"actionIndex": <integer 0-${choices.length - 1}>, "reasoning": "<one or two short sentences>"}`;
}

function placementPrompt(state: GameState, choices: Position[]): string {
  const me = state.currentPlayer;
  const left = state.placementOrder.slice(state.placementIndex).filter((p) => p === me).length;
  return `You are ${TRIBE[me]} (pieces marked "${me.slice(1)}"). Placement phase (snake draft): you are placing a totem, ${left} left including this one.
The player who places the very last totem moves first in battle.
Board (rows 1-${state.boardSize} top to bottom, columns A-${String.fromCharCode(64 + state.boardSize)}; "." empty, digits = tribes: ${legend(state)}):
${renderBoard(state)}

Candidate squares (pre-screened by the engine; you may choose any):
${choices.map((p, i) => `${i}: ${coord(p)}`).join('\n')}

Respond with exactly: {"placementIndex": <integer 0-${choices.length - 1}>, "reasoning": "<one or two short sentences>"}`;
}

// ---------------------------------------------------------------------------
// LLM call + parsing
// ---------------------------------------------------------------------------

const clients = new Map<string, OpenAI>();
function clientFor(model: ModelInfo): OpenAI | null {
  if (model.provider === 'offline') return null;
  const apiKey = model.provider === 'openrouter' ? config.openRouterApiKey : config.groqApiKey;
  if (!apiKey) return null;
  let c = clients.get(model.provider);
  if (!c) {
    c = new OpenAI({
      apiKey,
      baseURL: PROVIDER_BASE_URLS[model.provider],
      timeout: config.llmTimeoutMs,
      maxRetries: 0,
      defaultHeaders: model.provider === 'openrouter' ? { 'X-Title': 'Tribal Wars AI Arena' } : {},
    });
    clients.set(model.provider, c);
  }
  return c;
}

class FallbackReason extends Error {}

/** Extracts `{ <indexKey>: n, reasoning }` from a possibly messy LLM reply. */
export function parseChoice(raw: string, indexKey: 'actionIndex' | 'placementIndex', count: number): { index: number; reasoning: string } {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const candidates = cleaned.match(/\{[^{}]*\}/g) ?? [];
  for (const text of candidates.reverse()) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const rawIndex = rec[indexKey] ?? rec.index ?? rec.actionIndex ?? rec.placementIndex;
    const index = typeof rawIndex === 'string' ? Number(rawIndex) : rawIndex;
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= count) throw new FallbackReason(`index ${index} out of range 0-${count - 1}`);
    const reasoning = typeof rec.reasoning === 'string' ? rec.reasoning.trim().slice(0, 400) : '';
    return { index, reasoning: reasoning || 'No reasoning given.' };
  }
  throw new FallbackReason('reply was not valid JSON with an index');
}

/** OpenRouter's unified reasoning control (ignored by models without reasoning). */
interface OpenRouterReasoning {
  enabled?: boolean;
  max_tokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

/** Optional request parameters; a profile that a model rejects (HTTP 400) is skipped next time. */
type RequestProfile = { name: string; temperature?: number; reasoning_effort?: 'none' | 'low'; reasoning?: OpenRouterReasoning };

/**
 * Ordered request profiles, most efficient first. Free reasoning models otherwise
 * spend the whole token budget thinking and return empty content, so reasoning is
 * disabled or capped where the model allows it. The last profile is always bare
 * (model + messages + max_tokens): no `response_format`, nothing model-specific.
 */
export function requestProfiles(model: ModelInfo): RequestProfile[] {
  const bare: RequestProfile = { name: 'bare' };
  if (model.provider === 'groq') {
    if (/gpt-oss/i.test(model.model)) return [{ name: 'effort-low', temperature: 0.4, reasoning_effort: 'low' }, { name: 'temp', temperature: 0.4 }, bare];
    if (/qwen3|qwq|deepseek-r1/i.test(model.model)) return [{ name: 'effort-none', temperature: 0.4, reasoning_effort: 'none' }, { name: 'temp', temperature: 0.4 }, bare];
    return [{ name: 'temp', temperature: 0.4 }, bare];
  }
  const { supportedParameters: params, reasoningMandatory } = modelCapabilities(model); // params null = unknown
  const temp = params === null || params.includes('temperature') ? { temperature: 0.4 } : {};
  const reasoning = params === null || params.includes('reasoning');
  if (!reasoning) return [{ name: 'temp', ...temp }, bare];
  const capped: RequestProfile = { name: 'reasoning-capped', ...temp, reasoning: { max_tokens: 512 } };
  return reasoningMandatory ? [capped, bare] : [{ name: 'reasoning-off', ...temp, reasoning: { enabled: false } }, capped, bare];
}

/** Index of the first profile known to work for a model (learned from 400 responses). */
const profileMemory = new Map<string, number>();

/** Reasoning-capable chat message: some providers return the answer only in `reasoning`. */
interface ReasoningMessage {
  content?: string | null;
  reasoning?: unknown;
  reasoning_content?: unknown;
}

function describeApiError(model: ModelInfo, err: InstanceType<typeof APIError>): string {
  const detail = err.message.replace(/^\d{3}\s*/, '').slice(0, 100);
  if (err.status === 404) return `${model.provider} API error 404: model not found or retired (refresh the model list)`;
  return `${model.provider} API error ${err.status ?? ''}${detail ? `: ${detail}` : ''}`.trim();
}

async function askLlm(model: ModelInfo, prompt: string): Promise<string> {
  const client = clientFor(model);
  if (!client) throw new FallbackReason(`no API key configured for ${model.provider}`);
  const profiles = requestProfiles(model);
  const deadline = Date.now() + config.llmTimeoutMs;
  let i = Math.min(profileMemory.get(model.id) ?? 0, profiles.length - 1);
  let retried429 = false;

  for (;;) {
    const { name: _name, ...extra } = profiles[i]!;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FallbackReason(`timed out after ${Math.round(config.llmTimeoutMs / 1000)}s`);
    const body: ChatCompletionCreateParamsNonStreaming & { reasoning?: OpenRouterReasoning } = {
      model: model.model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      ...extra,
    };
    try {
      const completion = await client.chat.completions.create(body, { timeout: remaining, signal: AbortSignal.timeout(remaining + 500) });
      profileMemory.set(model.id, i);
      const message: ReasoningMessage = completion.choices[0]?.message ?? {};
      const content = message.content?.trim();
      if (content) return content;
      // Reasoning models sometimes put the final JSON only in the reasoning trace.
      const trace = [message.reasoning, message.reasoning_content].find((t): t is string => typeof t === 'string' && t.includes('{'));
      if (trace) return trace;
      throw new FallbackReason(completion.choices[0]?.finish_reason === 'length' ? 'reply cut off (token limit)' : 'empty reply');
    } catch (err) {
      if (err instanceof FallbackReason) throw err;
      if (err instanceof APIConnectionTimeoutError || (err instanceof Error && err.name === 'TimeoutError')) {
        throw new FallbackReason(`timed out after ${Math.round(config.llmTimeoutMs / 1000)}s`);
      }
      // 400/422 = a parameter this model does not accept: retry with the next, simpler profile.
      if (err instanceof APIError && (err.status === 400 || err.status === 422) && i < profiles.length - 1) {
        i++;
        continue;
      }
      // Free tiers are often briefly rate-limited upstream: one short retry if time allows.
      if (err instanceof APIError && err.status === 429 && !retried429 && deadline - Date.now() > 4000) {
        retried429 = true;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (err instanceof APIError) throw new FallbackReason(describeApiError(model, err));
      throw new FallbackReason(err instanceof Error ? err.message.slice(0, 120) : 'unknown error');
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function offlineTurn(state: GameState, botId: 'offline:heuristic' | 'offline:random'): AiDecision {
  if (state.phase === 'PLACEMENT') {
    const placement = botId === 'offline:random' ? randomPlacement(state, Math.random) : heuristicPlacement(state);
    if (!placement) throw new AiRequestError('No legal placement available.', 422);
    const reasoning = botId === 'offline:random' ? `Let the spirits decide: ${coord(placement)}.` : explainPlacement(state, placement);
    return { kind: 'placement', placement, reasoning, modelUsed: botId };
  }
  const move = botId === 'offline:random' ? randomAction(state, Math.random) : heuristicAction(state);
  if (!move) throw new AiRequestError('Current player has no legal action.', 422);
  const reasoning = botId === 'offline:random' ? 'Let the spirits decide.' : explainAction(state, move);
  return { kind: 'move', move, reasoning, modelUsed: botId };
}

/**
 * Decides one AI turn (placement or battle move) for `state.currentPlayer`.
 * LLMs only ever choose an index from engine-generated legal options; any failure
 * (missing key, timeout, bad JSON, bad index) falls back to `offline:heuristic`.
 */
export async function chooseAiTurn(state: GameState, modelId: string): Promise<AiTurnResult> {
  const started = Date.now();
  if (state.status !== 'PLAYING') throw new AiRequestError('The match is already finished.', 409);
  const model = resolveModel(modelId);
  if (!model) throw new AiRequestError(`Unknown model "${modelId}".`, 400);

  const done = (r: AiDecision, fallback: boolean): AiTurnResult =>
    ({ ...r, modelRequested: modelId, fallback, latencyMs: Date.now() - started });

  if (model.provider === 'offline') {
    return done(offlineTurn(state, model.id === 'offline:random' ? 'offline:random' : 'offline:heuristic'), false);
  }

  try {
    if (state.phase === 'PLACEMENT') {
      const choices = rankPlacements(state).slice(0, MAX_PLACEMENT_CHOICES).map((s) => s.choice);
      if (choices.length === 0) throw new AiRequestError('No legal placement available.', 422);
      const reply = await askLlm(model, placementPrompt(state, choices));
      const { index, reasoning } = parseChoice(reply, 'placementIndex', choices.length);
      const placement = choices[index]!;
      if (validatePlacement(state, placement) !== null) throw new FallbackReason('chosen square was not legal');
      return done({ kind: 'placement', placement, reasoning, modelUsed: model.id }, false);
    }
    const choices = rankActions(state).slice(0, MAX_ACTION_CHOICES).map((s) => s.choice);
    if (choices.length === 0) throw new AiRequestError('Current player has no legal action.', 422);
    const reply = await askLlm(model, battlePrompt(state, choices));
    const { index, reasoning } = parseChoice(reply, 'actionIndex', choices.length);
    const move = choices[index]!;
    if (validateAction(state, move) !== null) throw new FallbackReason('chosen action was not legal');
    return done({ kind: 'move', move, reasoning, modelUsed: model.id }, false);
  } catch (err) {
    if (!(err instanceof FallbackReason)) throw err;
    const fb = offlineTurn(state, 'offline:heuristic');
    return done({ ...fb, reasoning: `(Fallback: ${model.label} ${err.message}) ${fb.reasoning}` }, true);
  }
}

/** Sanity helper for tests: total legal options in the current phase. */
export function countOptions(state: GameState): number {
  return state.phase === 'PLACEMENT' ? getValidPlacements(state).length : getValidActions(state).length;
}

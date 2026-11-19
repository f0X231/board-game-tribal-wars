---
name: ai-arena
description: Integration with free open-source LLM APIs (OpenRouter, Groq), offline bots, prompt formatting, legal move/placement selection with fallback, the /api/models and /api/ai-turn endpoints, and AI-vs-AI spectator pacing in /client.
---

# Tribal Wars - AI Arena & Open Source LLM Integration

When building or debugging AI bots, follow these patterns. Code map:
- `/shared/aiBots.ts` — pure, deterministic heuristics (`rankActions`, `rankPlacements`, `heuristicAction`, `heuristicPlacement`, `randomAction(state, random)`, `explain*`). Used by the server and as the browser's emergency fallback.
- `/shared/apiTypes.ts` — HTTP contract (`ModelInfo`, `ModelsResponse`, `AiTurnRequest`, `AiDecision`, `AiTurnResponse`). Import these on both sides; never redeclare them.
- `/server/src/config.ts` (env), `models.ts` (catalog), `aiService.ts` (bots + LLM + fallback), `stateValidation.ts` (strict `GameState` parsing), `index.ts` (Express app).
- `/server/tests/aiService.test.ts` — `npm test`; uses a local fake OpenAI-compatible server (good JSON, `<think>` + fenced JSON, garbage, out-of-range index, slow > timeout, HTTP 429).
- `/client/src/lib/api.ts`, `matchConfig.ts`, `useLocalMatch.ts` — AI seats, auto turns, pause, reasoning log.

## 1. Providers & Models
- Use the `openai` SDK (v7) with custom `baseURL`, `maxRetries: 0`, `timeout: LLM_TIMEOUT_MS` (default 10 000):
  - **OpenRouter**: `https://openrouter.ai/api/v1` — defaults `meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen-2.5-72b-instruct:free`, `deepseek/deepseek-r1:free`, `google/gemma-2-9b-it:free`.
  - **Groq**: `https://api.groq.com/openai/v1` — defaults `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`.
  - Free-tier catalogs change often: override with `OPENROUTER_MODELS` / `GROQ_MODELS` (comma-separated) in `/server/.env`. Base URLs can be overridden with `OPENROUTER_BASE_URL` / `GROQ_BASE_URL` (proxies, tests).
- Model ids are `offline:heuristic`, `offline:random`, `openrouter:<model>`, `groq:<model>`. Unknown `openrouter:`/`groq:` ids are accepted (`resolveModel`) so new free models can be tried without code changes.
- **Offline bots** need no key: `offline:heuristic` (mobility difference, trapped-piece penalties, eliminations, centre control; two-stage beam search ~35ms on 12x12 x 4 tribes; beats random ~19/20) and `offline:random`.
- Keys live only in `/server/.env` (`OPENROUTER_API_KEY`, `GROQ_API_KEY`; see `/server/.env.example`). Never send keys or provider calls from `/client`.

## 2. Anti-Hallucination Selection (Critical)
- **Never** let an LLM produce raw coordinates. The engine generates every option:
  - `PLAYING`: `rankActions(state)` → top **20** legal `MoveAction`s, listed as `i: move C3 -> F6, shoot arrow at F2`. Reply `{"actionIndex": n, "reasoning": "..."}`.
  - `PLACEMENT`: `rankPlacements(state)` → top **15** empty squares, listed as `i: D4`. Reply `{"placementIndex": n, "reasoning": "..."}`.
  - A shortlist is required because a 12x12 battle has thousands of legal actions; every listed option is still engine-legal.
- The prompt includes the rules, an ASCII board (`.` empty, `#` fire, digits = tribes; columns A.., rows 1..), and the tribe legend.
- `parseChoice` strips `<think>…</think>` and code fences, takes the last JSON object with an integer index, and rejects out-of-range indexes. The chosen option is re-validated with the engine before returning.

## 3. Fallback Safety
- Missing key, timeout, HTTP error, empty reply, invalid JSON, bad index, or illegal choice → decide with `offline:heuristic`, set `fallback: true`, `modelUsed: 'offline:heuristic'`, and prefix the reasoning with `(Fallback: <model> <reason>)`.
- The client re-validates every AI decision with the engine (`tryPlacePiece` / `tryApplyAction`). If the server is unreachable, the browser computes the turn with `/shared/aiBots.ts` and logs `(Fallback: … decided in browser)`. A match never stalls.

## 4. API Endpoints (`/server`, default port 4000)
- `GET /api/health` → `{ ok: true }`.
- `GET /api/models` → `ModelsResponse` (`available: false` when the provider key is missing; `providers` flags).
- `POST /api/ai-turn` with `{ state, modelId }` → `AiTurnResponse`: `{ kind: 'placement', placement } | { kind: 'move', move }` plus `reasoning`, `modelUsed`, `modelRequested`, `fallback`, `latencyMs`. Errors: 400 (bad body/state/unknown model), 409 (match finished), 422 (no legal option).
- Security: CORS limited to `CLIENT_ORIGIN` (default `http://localhost:3000`), JSON body limit 64kb, strict state validation, `x-powered-by` disabled.

## 5. Client AI Seats & Spectator Mode
- Lobby: each seat (`P1`–`P4`) is **Human** or a model from `/api/models` (unavailable ones disabled, "needs API key"). If the server is down, only the offline bots are offered and run in the browser. All-AI seats = spectator mode.
- AI turn speed: `0.5s`, `1.2s`, `2.5s` (`MatchConfig.aiDelayMs`). Each AI turn takes at least this long (request time counts toward it).
- `useLocalMatch` runs AI turns in an effect keyed on the current `GameState`; stale results are dropped (reducer checks `expected === state.game`) and in-flight requests are aborted on pause/reset/unmount.
- **Pause / Resume AI** button whenever an AI seat exists. Human input is ignored on AI turns.
- Battle Log shows the action line followed by `🤖 <model>: "<reasoning>"` with a `fallback` badge when applicable.
- Pacing is client-side because matches are simulated locally; for Phase 4 online rooms, apply the same delay on the server before broadcasting the new `GameState`.

## 6. Verification
- `/server`: `npx tsc --noEmit`, `npm test`, `npm run build` (emits `dist/server` + `dist/shared`; `npm start`).
- `/shared` imports between its own files use `.ts` extensions (Turbopack can't map `.js` → `.ts`); `rewriteRelativeImportExtensions` rewrites them on emit.

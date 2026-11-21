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

## 1. Providers & Models (live discovery)
- Free-tier catalogs change constantly (e.g. Groq retired `llama-3.3-70b-versatile` / `mixtral-8x7b-32768` → 404). **Never hard-code model lists**: `/server/src/models.ts` discovers them live.
  - **Groq** `GET https://api.groq.com/openai/v1/models`: keep `active` text models; drop `whisper`, `orpheus`, `prompt-guard`, `safeguard`, `llama-guard`, `tts`.
  - **OpenRouter** `GET https://openrouter.ai/api/v1/models`: keep `pricing.prompt === "0" && pricing.completion === "0"` (or `:free`), text-in/text-out only, not expired; `openrouter/free` (auto-router) always first. Stores `supported_parameters` and `reasoning.mandatory` per model.
  - Cached 15 min in memory; `GET /api/models?refresh=true` forces a reload (min 10s apart). On failure the last good list, else a curated Nov-2026 list (override with `GROQ_MODELS` / `OPENROUTER_MODELS`), is served with `discovery.<provider>.status = 'fallback'`.
- Model ids: `offline:heuristic`, `offline:random`, `groq:<model>`, `openrouter:<model>`. Any id matching `CUSTOM_MODEL_ID_PATTERN` (`/shared/apiTypes.ts`) is accepted as a custom model (Lobby "Custom Model ID").
- Requests (`askLlm` in `aiService.ts`, `openai` SDK v7, `maxRetries: 0`, total budget `LLM_TIMEOUT_MS` = 10s): **no `response_format`**; JSON is extracted from the text by regex (`parseChoice`), falling back to the `reasoning` field when `content` is empty.
  - Ordered request profiles; an HTTP 400/422 moves to the next, simpler profile and the working one is remembered per model:
    - Groq gpt-oss → `reasoning_effort: 'low'`; qwen3 → `'none'`; others → temperature only; last = bare.
    - OpenRouter → `reasoning: {enabled: false}` (skipped if mandatory) → `reasoning: {max_tokens: 512}` → bare. Without these, free reasoning models burn `max_tokens` thinking and return empty content.
  - One 1.5s retry on HTTP 429 (free tiers are often rate-limited upstream) if the budget allows. 404 = retired model ("refresh the model list").
- **Offline bots** need no key: `offline:heuristic` and `offline:random`.
- Keys live only in `/server/.env` (`OPENROUTER_API_KEY`, `GROQ_API_KEY`). Never call providers from `/client`.

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
- `GET /api/models[?refresh=true]` → `ModelsResponse` (offline → Groq → OpenRouter; `available: false` when the key is missing; `discovery` per provider: `live | fallback | no-key`, `fetchedAt`, `error`, `count`).
- `POST /api/ai-turn` with `{ state, modelId }` → `AiTurnResponse`: `{ kind: 'placement', placement } | { kind: 'move', move }` plus `reasoning`, `modelUsed`, `modelRequested`, `fallback`, `latencyMs`. Errors: 400 (bad body/state/unknown model), 409 (match finished), 422 (no legal option).
- Security: CORS limited to `CLIENT_ORIGIN` (default `http://localhost:3000`), JSON body limit 64kb, strict state validation, `x-powered-by` disabled.

## 5. Client AI Seats & Spectator Mode
- Lobby: each seat (`P1`–`P4`) is **Human** or a model from `/api/models`, grouped *Built-in Offline Bots* / *Groq (Live Free Models)* / *OpenRouter (Live Free Models)*; **⟳ Refresh Models** re-discovers; **✎ Custom model ID…** takes any `groq:`/`openrouter:` id. If the server is down, only the offline bots are offered and run in the browser. All-AI seats = spectator mode.
- AI turn speed: `0.5s`, `1.2s`, `2.5s` (`MatchConfig.aiDelayMs`). Each AI turn takes at least this long (request time counts toward it).
- `useLocalMatch` runs AI turns in an effect keyed on the current `GameState`; stale results are dropped (reducer checks `expected === state.game`) and in-flight requests are aborted on pause/reset/unmount.
- **Pause / Resume AI** button whenever an AI seat exists. Human input is ignored on AI turns.
- Battle Log shows the action line followed by `🤖 <model>: "<reasoning>"` with a `fallback` badge when applicable.
- Pacing is client-side because matches are simulated locally; for Phase 4 online rooms, apply the same delay on the server before broadcasting the new `GameState`.

## 6. Verification
- `/server`: `npx tsc --noEmit`, `npm test`, `npm run build` (emits `dist/server` + `dist/shared`; `npm start`).
- `/shared` imports between its own files use `.ts` extensions (Turbopack can't map `.js` → `.ts`); `rewriteRelativeImportExtensions` rewrites them on emit.

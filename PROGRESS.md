# PROGRESS.md - Tribal Wars Development Tracker

> **Note for AI Assistants:** Always read this file at the start of a session to understand the current project status. After completing any task or feature, update the checkboxes (`[x]`) and log any architectural decisions or known issues below.

---

## Phase 1: Project Setup & Core Engine (`/shared`)
- [x] Initialize monorepo folder structure (`/client`, `/server`, `/shared`)
- [x] Create `CLAUDE.md`, `.gitignore`, and `.claude/skills/` guidelines
- [x] Implement core game rules and types in `/shared/gameEngine.ts`
  - [x] Board sizes (`6x6`, `10x10`, `12x12`) & piece count validation (`2-4` or `4-6`)
  - [x] Queen movement & unobstructed pathfinding
  - [x] Atomic turn execution (Move -> Leave permanent fire trail -> Shoot fire arrow)
  - [x] Player elimination & last-player-standing win condition
- [x] Write unit tests to verify edge cases (e.g., player can move but has no valid shot)
- [x] Full-match simulation (`/shared/simulateMatch.ts`): 50 random matches across all 9 board/player configs + 4 critical edge cases + ASCII replay — all passing

## Phase 2: Local Playable Board UI (`/client`)
- [x] Upgrade engine to **Snake Draft placement** (`phase: 'PLACEMENT' | 'PLAYING'`, `placePiece`, `placementMode: 'MANUAL' | 'RANDOM'`, last placer moves first)
- [x] Aztec tribal art direction (stone frame, carved ochre/obsidian tiles, 4 tribe totems, animated ember fire tokens)
- [x] Build Match Setup Lobby (select board size, 2-4 players, pieces per player, placement mode) — parchment scroll style
- [x] Build responsive CSS Grid board component (`6x6`, `10x10`, `12x12`)
- [x] Implement placement UX + 3-step interactive turn UX (`SELECT_PIECE` -> `SELECT_MOVE` -> `SELECT_SHOOT`, Cancel Move)
- [x] HUD: phase badge, active tribe banner, tribe roster, battle log, Reset / Back to Lobby, Victory modal
- [x] Add visual distinction for P1–P4 pieces and permanent fire tiles
- [x] Test full local pass-and-play match from start to finish

## Phase 3: AI Arena & Free Open-Source Models (`/server`)
- [x] Set up Express + TypeScript server entry point and `.env.example` (`/server/src/index.ts`, ESM, `npm run dev|build|start|test`)
- [x] Integrate OpenAI SDK configured for OpenRouter (`:free` models) and Groq (overridable model lists via env)
- [x] Built-in offline bots (`offline:heuristic` mobility/centre bot, `offline:random`) in `/shared/aiBots.ts` — work without API keys
- [x] Build anti-hallucination prompt formatter (engine-ranked shortlist of legal actions/placements → LLM returns `actionIndex`/`placementIndex`)
- [x] Both phases supported (`PLACEMENT` snake draft + `PLAYING` battle)
- [x] Implement fallback move logic (missing key, >10s timeout, invalid JSON, bad index, HTTP error → `offline:heuristic` with `(Fallback)` note; browser-side fallback if server is down)
- [x] API: `GET /api/models`, `POST /api/ai-turn`, `GET /api/health` with strict `GameState` validation
- [x] Lobby seat configuration (Human / AI model per tribe) + AI turn speed (0.5s / 1.2s / 2.5s)
- [x] Build AI vs AI Spectator Mode with turn delay, Pause/Resume AI, and live reasoning log UI
- [x] Tests: `/server/tests/aiService.test.ts` (17 tests incl. fake LLM provider) + headless-browser E2E (spectator, human vs AI, pause, server-down fallback)

## Phase 3.5: Research Telemetry, Voronoi Analytics & Match Recording
- [x] Persistent piece ids in `GameState.pieces` (`P1_1`, `P2_3`, ... kept in deployment order, follow moves; `getPieceIdAt`, `assignPieceIds`) — all existing tests unchanged
- [x] `/shared/telemetry.ts`: Queen-move & King-move Voronoi (multi-source BFS), contested / neutral squares, exclusive safe regions (connected components), active vs trapped pieces, exact legal move-arrow counts, opponents' mobility delta, algebraic notation (`a1`–`l12`), distances/directions, fire coverage, board snapshots
- [x] Deterministic replay (`replayDecisions`, `rebuildMatchTelemetry`), RANDOM spawn recovery (`spawnDecisions`), fixed-column CSV export (`matchToCsv`, formula-injection safe)
- [x] `/server/src/matchRecorder.ts` file archive (`server/data/matches/<matchId>.json`, gitignored, never overwrites)
- [x] API: `POST /api/matches` (server replays decisions and recomputes every metric), `GET /api/matches`, `GET /api/matches/:id/export?format=json|csv`
- [x] Headless batch runner `npm run experiment -- --models a,b --games N` (seat rotation, seeded RANDOM spawns, rate-limit pause, results table)
- [x] Client: per-decision `thinkTimeMs`, live telemetry on every placement/turn, auto-submit on victory, Post-Match Analytics + "Export Research JSON" / "Export CSV" in the Victory modal (works offline)
- [x] Tests: shared 34 + telemetry 10 + simulation 50/50; server 17 + matches 9 (incl. real HTTP); headless-browser E2E (AI vs AI draft, RANDOM spawn, human vs AI, server down)

## Phase 3.6: Live Free-Model Discovery & Request Compatibility
- [x] `GET /api/models[?refresh=true]`: live discovery from Groq `/models` (active chat models; no whisper/orpheus/prompt-guard/safeguard) and OpenRouter `/models` (zero-priced or `:free`, text-only, `openrouter/free` first); 15-min cache, curated Nov-2026 fallback list, per-provider `discovery` status
- [x] Request compatibility: never sends `response_format`; regex JSON extraction (also from `reasoning` when `content` is empty); per-model request profiles with automatic downgrade on HTTP 400/422 (Groq `reasoning_effort` low/none, OpenRouter reasoning off → capped 512 → bare, using `supported_parameters` + `reasoning.mandatory`); one retry on 429
- [x] Lobby: models grouped *Built-in Offline Bots* / *Groq (Live Free Models)* / *OpenRouter (Live Free Models)*, **⟳ Refresh Models**, **✎ Custom model ID** per seat
- [x] Verified live (Nov 21): all 4 Groq models + 7/12 OpenRouter models answered a battle turn with zero 400/404 (rest: upstream 429 rate limits, 1 timeout, 1 token-limit); 2 one-game experiments Groq vs OpenRouter → 32/33 LLM decisions without fallback; browser match gpt-oss-20b (custom id) vs Nemotron 3.5 Super VL → 17/17 without fallback

## Phase 3.7: Deep-Search Research Bots (7 Papers)
- [x] Shared high-performance core `/server/src/bots/evalUtils.ts`: flat `Uint8Array` board, precomputed Queen-ray tables, incremental Zobrist hashing, allocation-free make/unmake (trail + arrow fire), multi-source Queen/King BFS (`Uint8Array`/`Int16Array`), territory features (t1, t2, c1, c2, w, mobility), 8-connected regions, plodding fill bounds, single-agent endgame filling, `Clock` deadlines
- [x] Search engines `/server/src/bots/search.ts`: anytime iterative-deepening paranoid alpha-beta for 2–4 tribes (TT, aspiration windows, NegaScout/PVS, killers; verified equal to brute-force minimax) + Move-Group UCT MCTS
- [x] 7 bots, each with its own PLACEMENT (snake-draft search) and PLAYING strategy and search stats in `reasoning`: `research:anky-rel-territory`, `research:mg-peo-mcts`, `research:cgt-subgame`, `research:amazong-guard`, `research:tas-move-cat`, `research:arrow-lsg`, `research:tds-endgame`
- [x] Thinking budget `BOT_TIME_BUDGET_MS` (default 3500, 100–5000) and a hard 5000 ms ceiling per turn; worker-thread pool (`runner.ts`) keeps the API responsive, with in-process fallback if workers cannot start
- [x] `GET /api/models` group "Research Algorithms (7 Papers)"; Lobby group + 🔬 icon; HUD "Thinking deeply (3–5s)…" indicator; stats in the Battle Log and `MatchTelemetry` reasoning
- [x] `npm run experiment`: `--bot-budget-ms` (default 3500), `--jsonl` / `--csv` tournament exports, "max think ms" column
- [x] Tests `server/tests/researchBots.test.ts` (23): engine parity, board restore after a deadline, alpha-beta vs minimax, all 7 bots × {6,10,12} × {2,4} tribes × both phases, worker path at 3500 ms and 5000 ms under the 5 s ceiling, 4 complete bot-vs-bot matches
- [x] Verified: 10x10 tournament arrow-lsg vs mg-peo-mcts at 1500 ms (2 games, 0% fallback, max 1358 ms/turn, JSONL + CSV export); default-budget game at 3500 ms (max 3196 ms/turn); live `/api/ai-turn` on 12x12/4p in 3.3 s with `/api/health` answering in 3 ms meanwhile

## Phase 4: Online Multiplayer (`/server` & `/client`)
- [ ] Implement Socket.IO Room Manager (`create_room`, `join_room`, `start_game`)
- [ ] Enforce server-authoritative move validation using `/shared/gameEngine.ts`
- [ ] Handle player disconnections and turn timers
- [ ] Add animations for movement trails, fire arrow trajectories, and elimination alerts

---

## Current Focus
- **Completed:** Phase 3.7 — 7 deep-search research bots (Amazons papers adapted to Tribal Wars) with a 3–5 s anytime budget, worker threads, Lobby group, HUD indicator, experiment `--bot-budget-ms` / `--jsonl` / `--csv`. Tests: server 23 + 9 + 23, shared 34 + 10; `tsc --noEmit` and builds clean in all packages.
- **Previously completed:** Phase 3.6 — Live free-model discovery (Groq + OpenRouter), adaptive request profiles (no more 400/404 from retired models or unsupported params), Lobby Refresh Models + Custom Model ID. Server tests 23 + 9.
- **Previously completed:** Phase 3.5 — Research telemetry. Piece ids, Voronoi/mobility analytics in `/shared/telemetry.ts`, match archive + JSON/CSV export endpoints, `npm run experiment`, client auto-save and Victory-modal analytics/exports. `tsc --noEmit` clean and builds pass in all packages; tests: shared 34 + telemetry 10 + simulation 50/50, server 17 + 9.
- **Previously completed:** Phase 3 — AI Arena. `/server` Express API with offline bots + OpenRouter/Groq LLMs and fallback; `/client` AI seats, spectator pacing, Pause/Resume, reasoning log. `tsc --noEmit` clean in `/shared`, `/server`, `/client`; `npm run build` passes in `/server` and `/client`; tests: shared 31 + simulation 50/50, server 17.
- **Next Immediate Task:** Phase 4 — Socket.IO room manager (`create_room`, `join_room`, `start_game`) with server-authoritative validation (`multiplayer-sync` skill).
- **Known limits (research bots):** depth reached at 3.5 s is about 4–5 plies on 12x12/4 tribes and deeper on 6x6; search is selective (top-K / 50% pruning), so a reported "WIN"/"LOSS" is a proof only within the pruned tree. Multi-tribe search is paranoid (all opponents minimise our score). A turn uses ~92% of the budget (safety margin for the 5 s ceiling).
- **Known limits:** OpenRouter free models are frequently rate-limited upstream (HTTP 429) and some mandatory-reasoning models exceed the 10s budget (`LLM_TIMEOUT_MS`); those turns fall back to `offline:heuristic` and are flagged `fallback` in telemetry.

## Decisions & Notes Log
- **2026-11-19:** Project initialized as **Tribal Wars**. Decided on Full-Stack TypeScript (`Next.js` client, `Node.js/Express/Socket.IO` server, pure TS `shared` engine) and OpenAI-compatible free LLM APIs (OpenRouter/Groq).
- **2026-11-19:** Core engine implemented. Public API: `createGame(config, random?)`, `createStateFromBoard`, `getValidActions`, `validateAction`/`isValidAction`, `applyAction` (throws `GameRuleError`), `tryApplyAction`, `hasValidAction`. `Math.random` is used only in `createGame` (injectable RNG for reproducible setups); initial placement is random over the whole board and retried until every player has a legal turn.
- **2026-11-19:** Elimination semantics: after each turn, every *opponent* of the mover who cannot complete move+shot is eliminated (fire is permanent and vacated squares become fire, so "stuck" is permanent; this matches "eliminated at start of their turn"). The mover is evaluated at their own next turn, so a mover who traps everyone else wins even if they are now stuck too (no draws).
- **2026-11-19:** `shared/package.json` switched to `"type": "module"` (required by the tsconfig's `verbatimModuleSyntax` + `nodenext`). Relative imports in `/shared` use `.js` extensions. Tests run with `npm test` in `/shared` (`npx tsx`); `tsx` is not a dependency of `/shared` (it is already in `/server` devDependencies).
- **2026-11-19:** Phase 1 verification: `npm run simulate` in `/shared` runs seeded (reproducible) matches and checks per-turn invariants (fire +2/turn, fire never disappears, piece counts constant, eliminated players truly stuck, current player always has a legal action). No engine changes were required.
- **2026-11-19:** **Snake Draft placement** added to match the official rulebook. `GameState` gained `phase`, `placementOrder`, `placementIndex`; `createGame` now defaults to `placementMode: 'MANUAL'` (empty board). `status` (`PLAYING`/`FINISHED`) still means "match running vs. over" and is independent of `phase`. If a totem is boxed in by the draft, that player is eliminated as the battle starts and the turn passes clockwise.
- **2026-11-19:** `/client` imports the engine via the `@shared/*` tsconfig path alias; `next.config.ts` sets `turbopack.root` to the repo root so Turbopack can resolve `../shared`. No new npm dependencies (font: Cinzel via `next/font/google`).
- **2026-11-19:** UI structure: `useLocalMatch` (reducer: engine state + turn step + battle log) → `MatchScreen` (`Board`, `Hud`, `VictoryModal`); SVG art (totems, fire tokens, torches, spears) lives in `components/art.tsx` with shared gradients in a single hidden `<defs>`.
- **2026-11-19:** Phase 3 AI Arena. LLMs choose an index from an engine-ranked shortlist (top 20 actions / top 15 placements) because 12x12 boards have thousands of legal actions. Heuristic bots live in `/shared/aiBots.ts` so the server and the browser fallback share them. API contract types live in `/shared/apiTypes.ts`.
- **2026-11-19:** AI turn pacing is client-side for local matches (`MatchConfig.aiDelayMs`); CLAUDE.md's server-side delay applies to Phase 4 online rooms. Client API base URL: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`); server CORS: `CLIENT_ORIGIN` (default `http://localhost:3000`).
- **2026-11-19:** `/server` switched to `"type": "module"`; `tsc` builds with `rootDir: ".."` into `dist/server` + `dist/shared`. Inside `/shared`, cross-file imports use `.ts` extensions (Turbopack can't resolve `.js` → `.ts`), with `rewriteRelativeImportExtensions` in the shared/server tsconfigs and `allowImportingTsExtensions` in the client tsconfig.
- **2026-11-21:** Research telemetry. `GameState` gained `pieces` (persistent ids, deployment order, so a `RANDOM` spawn can be replayed). Metrics are computed only in `/shared/telemetry.ts`; the server never trusts client numbers — `POST /api/matches` replays the submitted decisions through the engine and rebuilds the whole log (illegal/unfinished logs → 400, duplicate id → 409). Server copy and client export are byte-identical JSON.
- **2026-11-21:** Metric definitions: Voronoi sources are the totems of *active* tribes (eliminated tribes own nothing); exclusive regions use 8-connected empty components bordered by exactly one active tribe; legal action counts are exact move-arrow pairs (Σ over destinations of their Queen rays — verified against brute force); `opponentsMobilityDelta = after − before` (negative = options taken away). Directions use algebraic notation: `N` = higher rank (row + 1). `thinkTimeMs`: human = time since the decision became available; AI = request/compute latency without spectator pacing; `null` for random spawns.
- **2026-11-21:** Match archive path: `MATCH_DATA_DIR` (default `server/data/matches`, gitignored). `/api/matches*` accepts JSON bodies up to 8 MB; other routes keep the 64 KB limit.
- **2026-11-21:** Groq retired `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` and `mixtral-8x7b-32768` (cause of the 404/400 fallbacks in early research logs). Model lists are now discovered live; `GROQ_MODELS` / `OPENROUTER_MODELS` only override the curated fallback. Root cause of most "empty reply" failures was free reasoning models spending the whole `max_tokens` budget on reasoning, not `response_format` (which was never sent) — fixed with per-model reasoning controls (`max_tokens` raised to 2048).
- **2026-11-22:** Research bots run server-side only (no client copy): CPU search for 3–5 s would freeze the browser, and the client falls back to `offline:heuristic` if the server is unreachable. Adaptations to Tribal Wars: a turn burns two squares (vacated square + arrow), so territory "turn" values are ⌊squares / 2⌋; a blocker leaving its territory seals it with fire, so blocker territories are discounted rather than lost; 3–4 tribes use paranoid search against the union of opponents. Placement uses up to 50% of the budget (a draft has up to 24 picks). No new dependencies (`node:worker_threads` only).

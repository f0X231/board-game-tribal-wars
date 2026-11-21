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

## Phase 4: Online Multiplayer (`/server` & `/client`)
- [ ] Implement Socket.IO Room Manager (`create_room`, `join_room`, `start_game`)
- [ ] Enforce server-authoritative move validation using `/shared/gameEngine.ts`
- [ ] Handle player disconnections and turn timers
- [ ] Add animations for movement trails, fire arrow trajectories, and elimination alerts

---

## Current Focus
- **Completed:** Phase 3.5 — Research telemetry. Piece ids, Voronoi/mobility analytics in `/shared/telemetry.ts`, match archive + JSON/CSV export endpoints, `npm run experiment`, client auto-save and Victory-modal analytics/exports. `tsc --noEmit` clean and builds pass in all packages; tests: shared 34 + telemetry 10 + simulation 50/50, server 17 + 9.
- **Previously completed:** Phase 3 — AI Arena. `/server` Express API with offline bots + OpenRouter/Groq LLMs and fallback; `/client` AI seats, spectator pacing, Pause/Resume, reasoning log. `tsc --noEmit` clean in `/shared`, `/server`, `/client`; `npm run build` passes in `/server` and `/client`; tests: shared 31 + simulation 50/50, server 17.
- **Next Immediate Task:** Phase 4 — Socket.IO room manager (`create_room`, `join_room`, `start_game`) with server-authoritative validation (`multiplayer-sync` skill).
- **Not yet verified:** real OpenRouter/Groq calls (no API keys on this machine); the LLM path is covered by a fake OpenAI-compatible server in tests. Default free model names may be retired by providers — override with `OPENROUTER_MODELS` / `GROQ_MODELS`.

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

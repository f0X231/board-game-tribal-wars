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
- [ ] Set up Express + TypeScript server entry point and `.env.example`
- [ ] Integrate OpenAI SDK configured for OpenRouter (`:free` models) and Groq
- [ ] Build anti-hallucination prompt formatter (send `validActions` list to LLM, parse chosen `actionIndex`)
- [ ] Implement fallback move logic in case of API timeout or malformed response
- [ ] Build AI vs AI Spectator Mode with configurable turn delay (1s–2.5s) and live reasoning log UI

## Phase 4: Online Multiplayer (`/server` & `/client`)
- [ ] Implement Socket.IO Room Manager (`create_room`, `join_room`, `start_game`)
- [ ] Enforce server-authoritative move validation using `/shared/gameEngine.ts`
- [ ] Handle player disconnections and turn timers
- [ ] Add animations for movement trails, fire arrow trajectories, and elimination alerts

---

## Current Focus
- **Completed:** Phase 2 — local pass-and-play board UI with snake-draft placement (`/client`), engine upgraded (`/shared`: 31 unit tests + 50-match simulation passing). `tsc --noEmit` clean in `/shared` and `/client`; `npm run build` and `npm run lint` pass in `/client`.
- **Next Immediate Task:** Phase 3 — Express + TypeScript server entry point and `.env.example` in `/server` (`ai-arena` skill).
- **Done:** `game-engine` and `nextjs-board-ui` skills updated for the Snake Draft `PLACEMENT` phase and the 4 Aztec tribe themes.

## Decisions & Notes Log
- **2026-11-19:** Project initialized as **Tribal Wars**. Decided on Full-Stack TypeScript (`Next.js` client, `Node.js/Express/Socket.IO` server, pure TS `shared` engine) and OpenAI-compatible free LLM APIs (OpenRouter/Groq).
- **2026-11-19:** Core engine implemented. Public API: `createGame(config, random?)`, `createStateFromBoard`, `getValidActions`, `validateAction`/`isValidAction`, `applyAction` (throws `GameRuleError`), `tryApplyAction`, `hasValidAction`. `Math.random` is used only in `createGame` (injectable RNG for reproducible setups); initial placement is random over the whole board and retried until every player has a legal turn.
- **2026-11-19:** Elimination semantics: after each turn, every *opponent* of the mover who cannot complete move+shot is eliminated (fire is permanent and vacated squares become fire, so "stuck" is permanent; this matches "eliminated at start of their turn"). The mover is evaluated at their own next turn, so a mover who traps everyone else wins even if they are now stuck too (no draws).
- **2026-11-19:** `shared/package.json` switched to `"type": "module"` (required by the tsconfig's `verbatimModuleSyntax` + `nodenext`). Relative imports in `/shared` use `.js` extensions. Tests run with `npm test` in `/shared` (`npx tsx`); `tsx` is not a dependency of `/shared` (it is already in `/server` devDependencies).
- **2026-11-19:** Phase 1 verification: `npm run simulate` in `/shared` runs seeded (reproducible) matches and checks per-turn invariants (fire +2/turn, fire never disappears, piece counts constant, eliminated players truly stuck, current player always has a legal action). No engine changes were required.
- **2026-11-19:** **Snake Draft placement** added to match the official rulebook. `GameState` gained `phase`, `placementOrder`, `placementIndex`; `createGame` now defaults to `placementMode: 'MANUAL'` (empty board). `status` (`PLAYING`/`FINISHED`) still means "match running vs. over" and is independent of `phase`. If a totem is boxed in by the draft, that player is eliminated as the battle starts and the turn passes clockwise.
- **2026-11-19:** `/client` imports the engine via the `@shared/*` tsconfig path alias; `next.config.ts` sets `turbopack.root` to the repo root so Turbopack can resolve `../shared`. No new npm dependencies (font: Cinzel via `next/font/google`).
- **2026-11-19:** UI structure: `useLocalMatch` (reducer: engine state + turn step + battle log) → `MatchScreen` (`Board`, `Hud`, `VictoryModal`); SVG art (totems, fire tokens, torches, spears) lives in `components/art.tsx` with shared gradients in a single hidden `<defs>`.

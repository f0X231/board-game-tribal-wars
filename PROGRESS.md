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

## Phase 2: Local Playable Board UI (`/client`)
- [ ] Build Match Setup Lobby (select board size, 2-4 players, pieces per player)
- [ ] Build responsive CSS Grid board component (`6x6`, `10x10`, `12x12`)
- [ ] Implement 3-step interactive turn UX (`SELECT_PIECE` -> `SELECT_MOVE` -> `SELECT_SHOOT`)
- [ ] Add visual distinction for P1–P4 pieces and permanent fire tiles
- [ ] Test full local pass-and-play match from start to finish

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
- **Completed:** `/shared/gameEngine.ts` + `/shared/gameEngine.test.ts` (23 tests passing via `tsx`, `tsc --noEmit` clean).
- **Next Immediate Task:** Phase 2 — Build Match Setup Lobby in `/client` (`nextjs-board-ui` skill).

## Decisions & Notes Log
- **2026-11-19:** Project initialized as **Tribal Wars**. Decided on Full-Stack TypeScript (`Next.js` client, `Node.js/Express/Socket.IO` server, pure TS `shared` engine) and OpenAI-compatible free LLM APIs (OpenRouter/Groq).
- **2026-11-19:** Core engine implemented. Public API: `createGame(config, random?)`, `createStateFromBoard`, `getValidActions`, `validateAction`/`isValidAction`, `applyAction` (throws `GameRuleError`), `tryApplyAction`, `hasValidAction`. `Math.random` is used only in `createGame` (injectable RNG for reproducible setups); initial placement is random over the whole board and retried until every player has a legal turn.
- **2026-11-19:** Elimination semantics: after each turn, every *opponent* of the mover who cannot complete move+shot is eliminated (fire is permanent and vacated squares become fire, so "stuck" is permanent; this matches "eliminated at start of their turn"). The mover is evaluated at their own next turn, so a mover who traps everyone else wins even if they are now stuck too (no draws).
- **2026-11-19:** `shared/package.json` switched to `"type": "module"` (required by the tsconfig's `verbatimModuleSyntax` + `nodenext`). Relative imports in `/shared` use `.js` extensions. Tests run with `npm test` in `/shared` (`npx tsx`); `tsx` is not a dependency of `/shared` (it is already in `/server` devDependencies).

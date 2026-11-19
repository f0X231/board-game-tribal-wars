---
name: game-engine
description: Core game rules, Snake Draft totem placement, Queen movement validation, permanent fire trails, fire arrow shooting, and elimination logic for Tribal Wars in /shared.
---

# Tribal Wars - Core Game Engine Guidelines

When modifying or testing code in `/shared`, strictly follow these rules. The engine lives in `/shared/gameEngine.ts`; tests in `/shared/gameEngine.test.ts` (`npm test`) and `/shared/simulateMatch.ts` (`npm run simulate`).

## 1. Board & Piece Constraints
- **Board Sizes**: Must only allow `6`, `10`, or `12`.
- **Players**: Support `2`, `3`, or `4` players (`P1`, `P2`, `P3`, `P4`), always seated in that clockwise order.
- **Piece Count Validation** (`validateConfig`, `getPieceLimits`):
  - If `boardSize === 6`: `piecesPerPlayer` must be `2` to `4`.
  - If `boardSize === 10` or `12`: `piecesPerPlayer` must be `4` to `6`.
- **Tribes** (UI names only; the engine uses `PlayerId`): `P1` Aztec, `P2` Maya, `P3` Eagle, `P4` Big Bear.

## 2. Game Phases
`GameState.phase` is `'PLACEMENT' | 'PLAYING'`. `GameState.status` (`'PLAYING' | 'FINISHED'`) is separate and only says whether the match is still running.

### 2a. `PLACEMENT` — Snake Draft
- `createGame(config, random?)` with `placementMode: 'MANUAL'` (the default) returns an **empty board** in `phase: 'PLACEMENT'`.
- `placementOrder` is the full snake sequence from `getSnakeDraftOrder(players, piecesPerPlayer)`: forward on even rounds, reversed on odd rounds (3 players × 2: `P1 P2 P3 P3 P2 P1`). `placementIndex` points at the next totem; `currentPlayer` is always `placementOrder[placementIndex]`.
- `placePiece(state, pos)` deploys one totem for `currentPlayer` on any `EMPTY` square (throws `GameRuleError`; `validatePlacement` / `tryPlacePiece` don't throw). Helpers: `getValidPlacements`, `getPiecesToPlace(state, player)`.
- **First Mover Rule**: when the last totem is placed, `phase` becomes `'PLAYING'` and the player who placed **that last totem** moves first, then clockwise.
- At that transition, any player with no complete legal turn is eliminated immediately and the turn passes clockwise to the next able player.
- `placementMode: 'RANDOM'` runs the same draft via `placePiece` on random empty squares (retrying until every player can act), so the first-mover rule still applies.
- No battle actions during placement: `getValidActions` returns `[]` and `validateAction` rejects. No placements after it.

### 2b. `PLAYING` — Turn Execution Order (Atomic Action)
Every turn consists of a single `MoveAction` (`{ from, to, shoot }`) executed in this exact sequence:
1. **Validate Move**: `from` must contain the current player's piece. `to` must be reachable via an unobstructed Queen path (orthogonal or diagonal) over `EMPTY` tiles only.
2. **Ignite Trail**: Set `board[from.row][from.col] = 'FIRE'`.
3. **Move Piece**: Set `board[to.row][to.col] = currentPlayer`.
4. **Validate & Ignite Fire Arrow**: From `to`, `shoot` must be reachable via an unobstructed Queen path over `EMPTY` tiles only (note: `from` is now `'FIRE'`, so it blocks shots). Set `board[shoot.row][shoot.col] = 'FIRE'`.

Use `applyAction` (throws `GameRuleError`) or `tryApplyAction`; `validateAction` returns a human-readable reason or `null`.

## 3. Elimination & Win Condition
- A player is **eliminated** if they have no complete turn (`hasValidAction(board, player) === false`): either no piece can move, OR no move leaves a square from which an arrow can be shot.
- After every turn, all active **opponents of the mover** are re-evaluated and stuck ones are eliminated (stuck is permanent: empty squares never come back). The mover is evaluated at the start of their own next turn, so a mover who traps everyone else wins even if they are now stuck too.
- Skip eliminated players in turn rotation; `eliminated` keeps knock-out order.
- The match ends (`status: 'FINISHED'`, `winner` set) as soon as `activePlayers.length <= 1`.

## 4. Coding Standards
- Keep all functions pure and immutable (clone the 2D board array before mutating).
- `Math.random` is only allowed in `createGame` (injectable `random` param for seeded tests).
- Zero external dependencies or UI imports allowed in `/shared`.
- When rules change, update unit tests, the simulation invariants, and `CLAUDE.md` together.

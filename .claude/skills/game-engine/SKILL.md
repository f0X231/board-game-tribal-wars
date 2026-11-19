---
name: game-engine
description: Core game rules, board initialization, Queen movement validation, permanent fire trails, fire arrow shooting, and elimination logic for Tribal Wars in /shared.
---

# Tribal Wars - Core Game Engine Guidelines

When modifying or testing code in `/shared`, strictly follow these rules:

## 1. Board & Piece Constraints
- **Board Sizes**: Must only allow `6`, `10`, or `12`.
- **Players**: Support `2`, `3`, or `4` players (`P1`, `P2`, `P3`, `P4`).
- **Piece Count Validation**:
  - If `boardSize === 6`: `piecesPerPlayer` must be `2` to `4`.
  - If `boardSize === 10` or `12`: `piecesPerPlayer` must be `4` to `6`.

## 2. Turn Execution Order (Atomic Action)
Every turn consists of a single `MoveAction` (`{ from, to, shoot }`) executed in this exact sequence:
1. **Validate Move**: `from` must contain the current player's piece. `to` must be reachable via an unobstructed Queen path (orthogonal or diagonal) over `EMPTY` tiles only.
2. **Ignite Trail**: Set `board[from.row][from.col] = 'FIRE'`.
3. **Move Piece**: Set `board[to.row][to.col] = currentPlayer`.
4. **Validate & Ignite Fire Arrow**: From `to`, `shoot` must be reachable via an unobstructed Queen path over `EMPTY` tiles only (note: `from` is now `'FIRE'`, so it blocks shots). Set `board[shoot.row][shoot.col] = 'FIRE'`.

## 3. Elimination & Win Condition
- At the end of every turn, re-evaluate all active players.
- A player is **eliminated** if `getValidActions(state, player).length === 0` (meaning they either cannot move any piece OR cannot shoot an arrow after moving).
- Skip eliminated players in turn rotation.
- The match ends immediately when `activePlayers.length <= 1`.

## 4. Coding Standards
- Keep all functions pure and immutable (clone the 2D board array before mutating).
- Zero external dependencies or UI imports allowed in `/shared`.

/**
 * Tribal Wars - pure, deterministic bot heuristics.
 *
 * Shared by the server's offline bots / LLM candidate shortlists and the
 * client's emergency fallback. No randomness here except through an injected
 * `random` function (only used by the `random` bot).
 */
import {
  QUEEN_DIRECTIONS,
  getCell,
  getPlayerPieces,
  getQueenReachable,
  getValidActions,
  getValidPlacements,
  hasValidAction,
  type Board,
  type Cell,
  type GameState,
  type MoveAction,
  type PlayerId,
  type Position,
} from './gameEngine.ts';

export interface Scored<T> {
  readonly choice: T;
  readonly score: number;
}

/** Number of squares reachable from `pos` by a Queen line (no allocation). */
export function countReachable(board: Board, pos: Position): number {
  let n = 0;
  for (const [dr, dc] of QUEEN_DIRECTIONS) {
    let row = pos.row + dr;
    let col = pos.col + dc;
    while (getCell(board, { row, col }) === 'EMPTY') {
      n++;
      row += dr;
      col += dc;
    }
  }
  return n;
}

/** Total Queen mobility of a player's pieces, plus how many of them are fully trapped. */
export function playerMobility(board: Board, player: PlayerId): { mobility: number; trapped: number } {
  let mobility = 0;
  let trapped = 0;
  for (const p of getPlayerPieces(board, player)) {
    const m = countReachable(board, p);
    mobility += m;
    if (m === 0) trapped++;
  }
  return { mobility, trapped };
}

/** Distance from the board centre (0 at the centre). */
function centreDistance(size: number, p: Position): number {
  const c = (size - 1) / 2;
  return Math.max(Math.abs(p.row - c), Math.abs(p.col - c));
}

/**
 * Board evaluation from `me`'s point of view: own mobility vs. average opponent
 * mobility, trapped-piece penalties, eliminations, and a small centre-control bonus.
 */
export function evaluateBoard(board: Board, me: PlayerId, opponents: ReadonlyArray<PlayerId>): number {
  const mine = playerMobility(board, me);
  let oppMobility = 0;
  let oppTrapped = 0;
  let oppDead = 0;
  for (const o of opponents) {
    const m = playerMobility(board, o);
    oppMobility += m.mobility;
    oppTrapped += m.trapped;
    if (m.mobility === 0 || !hasValidAction(board, o)) oppDead++;
  }
  const avgOpp = opponents.length > 0 ? oppMobility / opponents.length : 0;
  let centre = 0;
  for (const p of getPlayerPieces(board, me)) centre -= centreDistance(board.length, p);
  const meDead = !hasValidAction(board, me) ? 1 : 0;
  return mine.mobility - avgOpp - 8 * mine.trapped + 5 * oppTrapped + 60 * oppDead - 200 * meDead + 0.4 * centre;
}

function withCell(board: Board, edits: ReadonlyArray<readonly [Position, Cell]>): Cell[][] {
  const next = board.map((r) => [...r]);
  for (const [p, cell] of edits) next[p.row]![p.col] = cell;
  return next;
}

/**
 * Ranks legal battle actions for the current player, best first.
 * Two-stage search keeps it fast on 12x12: score every move (after trail), keep
 * the best `moveBeam`, then score every arrow from those moves.
 */
export function rankActions(state: GameState, moveBeam = 10): Array<Scored<MoveAction>> {
  const me = state.currentPlayer;
  const opponents = state.activePlayers.filter((p) => p !== me);
  const actions = getValidActions(state);
  if (actions.length === 0) return [];

  // Stage 1: unique (from, to) moves.
  const moveKey = (a: MoveAction) => `${a.from.row},${a.from.col}>${a.to.row},${a.to.col}`;
  const moves = new Map<string, { from: Position; to: Position; score: number }>();
  for (const a of actions) {
    const k = moveKey(a);
    if (moves.has(k)) continue;
    const b = withCell(state.board, [[a.from, 'FIRE'], [a.to, me]]);
    moves.set(k, { from: a.from, to: a.to, score: evaluateBoard(b, me, opponents) });
  }
  const keep = new Set(
    [...moves.entries()]
      .sort((x, y) => y[1].score - x[1].score)
      .slice(0, moveBeam)
      .map(([k]) => k),
  );

  // Stage 2: arrows for the shortlisted moves.
  const scored: Array<Scored<MoveAction>> = [];
  for (const a of actions) {
    if (!keep.has(moveKey(a))) continue;
    const b = withCell(state.board, [[a.from, 'FIRE'], [a.to, me], [a.shoot, 'FIRE']]);
    scored.push({ choice: a, score: evaluateBoard(b, me, opponents) });
  }
  return scored.sort((x, y) => y.score - x.score);
}

/** Ranks legal placement squares for the current drafter, best first. */
export function rankPlacements(state: GameState): Array<Scored<Position>> {
  const me = state.currentPlayer;
  const mine = getPlayerPieces(state.board, me);
  const size = state.board.length;
  return getValidPlacements(state)
    .map((pos) => {
      const reach = getQueenReachable(state.board, pos).length;
      // Spread own totems out: penalise squares adjacent to our own pieces.
      const crowd = mine.filter((p) => Math.max(Math.abs(p.row - pos.row), Math.abs(p.col - pos.col)) <= 1).length;
      const score = reach - 1.5 * centreDistance(size, pos) - 4 * crowd;
      return { choice: pos, score };
    })
    .sort((x, y) => y.score - x.score);
}

/** `offline:heuristic` battle choice (deterministic). */
export function heuristicAction(state: GameState): MoveAction | null {
  return rankActions(state)[0]?.choice ?? null;
}

/** `offline:heuristic` placement choice (deterministic). */
export function heuristicPlacement(state: GameState): Position | null {
  return rankPlacements(state)[0]?.choice ?? null;
}

/** `offline:random` choices; `random` must be injected (keeps /shared deterministic by default). */
export function randomAction(state: GameState, random: () => number): MoveAction | null {
  const actions = getValidActions(state);
  return actions[Math.floor(random() * actions.length)] ?? null;
}

export function randomPlacement(state: GameState, random: () => number): Position | null {
  const options = getValidPlacements(state);
  return options[Math.floor(random() * options.length)] ?? null;
}

/** Short human-readable explanation for a heuristic battle choice. */
export function explainAction(state: GameState, action: MoveAction): string {
  const me = state.currentPlayer;
  const opponents = state.activePlayers.filter((p) => p !== me);
  const before = playerMobility(state.board, me).mobility;
  const after = withCell(state.board, [[action.from, 'FIRE'], [action.to, me], [action.shoot, 'FIRE']]);
  const mineAfter = playerMobility(after, me).mobility;
  const oppBefore = opponents.reduce((s, o) => s + playerMobility(state.board, o).mobility, 0);
  const oppAfter = opponents.reduce((s, o) => s + playerMobility(after, o).mobility, 0);
  return `Maximise mobility: my reach ${before}→${mineAfter}, opponents' reach ${oppBefore}→${oppAfter}.`;
}

export function explainPlacement(state: GameState, pos: Position): string {
  const reach = getQueenReachable(state.board, pos).length;
  return `Open square with ${reach} lines of reach, close to the centre and away from my other totems.`;
}

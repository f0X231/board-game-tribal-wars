/**
 * Tribal Wars - full-match simulation & critical edge-case verification.
 * Run with:  npx tsx simulateMatch.ts
 *
 * 1. Explicitly verifies 4 critical edge cases.
 * 2. Prints an ASCII replay of one sample 6x6 match (first 3 turns + final board).
 * 3. Runs 50 seeded random matches across every board size / player count,
 *    checking engine invariants after every single turn.
 */
import {
  applyAction,
  createGame,
  createStateFromBoard,
  getPieceLimits,
  getQueenReachable,
  getValidActions,
  hasValidAction,
  isValidAction,
  validateAction,
  type Board,
  type BoardSize,
  type Cell,
  type GameState,
  type MoveAction,
  type PlayerCount,
  type Position,
} from './gameEngine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CheckFailed extends Error {}

function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new CheckFailed(msg);
}

/** Seeded PRNG (mulberry32) so every run is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '.' EMPTY, '#' FIRE, '1'..'4' players; whitespace ignored. */
function parseBoard(rows: string[]): Cell[][] {
  const map: Record<string, Cell> = { '.': 'EMPTY', '#': 'FIRE', '1': 'P1', '2': 'P2', '3': 'P3', '4': 'P4' };
  return rows.map((line) =>
    [...line.replace(/\s+/g, '')].map((ch) => {
      const cell = map[ch];
      if (cell === undefined) throw new Error(`Unknown board char "${ch}"`);
      return cell;
    }),
  );
}

const pos = (row: number, col: number): Position => ({ row, col });
const act = (f: [number, number], t: [number, number], s: [number, number]): MoveAction => ({
  from: pos(...f),
  to: pos(...t),
  shoot: pos(...s),
});
const countCells = (board: Board, cell: Cell): number => board.flat().filter((c) => c === cell).length;
const fmt = (p: Position): string => `(${p.row},${p.col})`;

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

/**
 * ASCII board. Legend:
 *   1-4 = player pieces   . = empty   # = older fire
 *   T   = fire trail left this turn (the `from` square)
 *   A   = fire arrow landed this turn (the `shoot` square)
 *   [n] = the piece that just moved
 */
function renderBoard(state: GameState): string {
  const last = state.lastAction;
  const header = '     ' + state.board[0]!.map((_, c) => ` ${String(c % 10)} `).join('');
  const lines = state.board.map((row, r) => {
    const cells = row.map((cell, c) => {
      const isAt = (p: Position | undefined): boolean => p !== undefined && p.row === r && p.col === c;
      if (isAt(last?.from)) return ' T ';
      if (isAt(last?.shoot)) return ' A ';
      const ch = cell === 'EMPTY' ? '.' : cell === 'FIRE' ? '#' : cell.slice(1);
      return isAt(last?.to) ? `[${ch}]` : ` ${ch} `;
    });
    return `  ${String(r).padStart(2, ' ')} ${cells.join('')}`;
  });
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Part 1: critical edge cases
// ---------------------------------------------------------------------------

const edgeResults: Array<{ name: string; ok: boolean; detail: string }> = [];

function edge(name: string, fn: () => string): void {
  try {
    const detail = fn();
    edgeResults.push({ name, ok: true, detail });
  } catch (err) {
    edgeResults.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

edge('EC1 Trail at exact `from` is permanent FIRE and blocks the same-turn arrow', () => {
  const s0 = createStateFromBoard(parseBoard([
    '. . . . . 2',
    '. . . . . .',
    '. . 1 . . .',
    '. . . . . .',
    '. . . . . .',
    '2 . . . . .',
  ]), ['P1', 'P2']);
  // P1 moves (2,2) -> (2,4). Arrow back along row 2 past (2,2) must be rejected.
  check(validateAction(s0, act([2, 2], [2, 4], [2, 1])) !== null, 'arrow passed through new trail to (2,1)');
  check(validateAction(s0, act([2, 2], [2, 4], [2, 0])) !== null, 'arrow passed through new trail to (2,0)');
  check(validateAction(s0, act([2, 2], [2, 4], [2, 2])) !== null, 'arrow landed on the new trail square');
  // Diagonal variant: (2,2) -> (4,4), shoot back up the diagonal to (1,1).
  check(validateAction(s0, act([2, 2], [4, 4], [1, 1])) !== null, 'diagonal arrow passed through new trail');
  // Shooting into the gap between trail and piece is legal.
  check(isValidAction(s0, act([2, 2], [2, 4], [2, 3])), 'shot into the square before the trail should be legal');

  const s1 = applyAction(s0, act([2, 2], [2, 4], [2, 3]));
  check(s1.board[2]![2] === 'FIRE', 'from square (2,2) is not FIRE after the move');
  check(s1.board[2]![4] === 'P1', 'piece did not arrive at (2,4)');
  check(s1.board[2]![3] === 'FIRE', 'arrow square (2,3) is not FIRE');
  // Permanence: play several more turns and confirm both fires stay.
  let s = s1;
  for (let i = 0; i < 4 && s.status === 'PLAYING'; i++) s = applyAction(s, getValidActions(s)[0]!);
  check(s.board[2]![2] === 'FIRE' && s.board[2]![3] === 'FIRE', 'fire disappeared in later turns');
  return `trail (2,2)+arrow (2,3) still FIRE after ${s.turnNumber} turns; 4 illegal "through-trail" arrows rejected`;
});

edge('EC2 Player with 3 pieces, 2 trapped, 1 free is NOT eliminated', () => {
  const board = parseBoard([
    '1 # . . # 1',
    '# # . . # #',
    '. . . . . .',
    '. . . 1 . .',
    '. . . . . .',
    '2 . . . . 2',
  ]);
  check(getQueenReachable(board, pos(0, 0)).length === 0, 'piece (0,0) should be trapped');
  check(getQueenReachable(board, pos(0, 5)).length === 0, 'piece (0,5) should be trapped');
  const s0 = createStateFromBoard(board, ['P2', 'P1'], 'P2');
  check(s0.activePlayers.includes('P1'), 'P1 eliminated at creation despite free piece');
  const p1Actions = getValidActions(s0, 'P1');
  check(p1Actions.length > 0, 'P1 should have actions');
  check(p1Actions.every((a) => a.from.row === 3 && a.from.col === 3), 'actions should only come from free piece (3,3)');
  // Opponent takes a turn; P1 must still be active and be the current player.
  const s1 = applyAction(s0, act([5, 0], [4, 0], [3, 0]));
  check(s1.status === 'PLAYING', 'game ended unexpectedly');
  check(s1.activePlayers.includes('P1') && !s1.eliminated.includes('P1'), 'P1 was eliminated');
  check(s1.currentPlayer === 'P1', 'turn did not pass to P1');
  return `P1 kept ${p1Actions.length} legal actions, all from (3,3); still active after P2's turn`;
});

edge('EC3 Player who can move to an adjacent square but cannot shoot from it IS eliminated', () => {
  // P1 (0,0) can move to (0,1) or (1,0). P2 burns (1,0) with a diagonal arrow,
  // leaving P1 a single move to (0,1) whose every neighbour is blocked.
  const s0 = createStateFromBoard(parseBoard([
    '1 . # . . .',
    '. # # . . .',
    '# . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . 2',
  ]), ['P2', 'P1'], 'P2');
  check(s0.activePlayers.includes('P1'), 'P1 should start active');
  const s1 = applyAction(s0, act([5, 5], [5, 4], [1, 0])); // arrow (4,3)->(3,2)->(2,1)->(1,0)
  check(s1.board[1]![0] === 'FIRE', 'arrow did not land at (1,0)');
  const moves = getQueenReachable(s1.board, pos(0, 0));
  check(moves.length === 1 && moves[0]!.row === 0 && moves[0]!.col === 1, `P1 should have exactly one move to (0,1), got ${moves.map(fmt).join(' ')}`);
  check(getValidActions(s1, 'P1').length === 0, 'P1 should have zero complete actions');
  check(!hasValidAction(s1.board, 'P1'), 'hasValidAction disagrees');
  check(s1.eliminated.includes('P1'), 'P1 was NOT eliminated');
  check(s1.status === 'FINISHED' && s1.winner === 'P2', 'P2 should win');
  return 'P1 had 1 legal move -> (0,1) but 0 shots; eliminated immediately, P2 declared winner';
});

edge('EC4 applyAction never mutates the previous GameState', () => {
  const s0 = createGame({ boardSize: 10, playerCount: 4, piecesPerPlayer: 5, placementMode: 'RANDOM' }, seeded(99));
  const snapshot = JSON.stringify(s0);
  deepFreeze(s0); // any write to s0 (or its nested board rows) would throw in strict-mode ESM
  let s = s0;
  const states: GameState[] = [s0];
  for (let i = 0; i < 10 && s.status === 'PLAYING'; i++) {
    const before = JSON.stringify(s);
    deepFreeze(s);
    const next = applyAction(s, getValidActions(s)[0]!);
    check(JSON.stringify(s) === before, `state at turn ${i} was mutated`);
    check(next !== s && next.board !== s.board, 'applyAction returned the same object/board reference');
    check(next.board.every((row, r) => row !== s.board[r]), 'board rows are shared between states');
    states.push(next);
    s = next;
  }
  check(JSON.stringify(s0) === snapshot, 'initial state changed');
  return `10 turns on deep-frozen states: no mutation, no shared board rows (${states.length} distinct snapshots)`;
});

// ---------------------------------------------------------------------------
// Part 2: per-turn invariant checks used by the simulation
// ---------------------------------------------------------------------------

function verifyTurn(prev: GameState, action: MoveAction, next: GameState): void {
  const mover = prev.currentPlayer;
  check(next.board[action.from.row]![action.from.col] === 'FIRE', 'trail missing at from');
  check(next.board[action.to.row]![action.to.col] === mover, 'piece missing at to');
  check(next.board[action.shoot.row]![action.shoot.col] === 'FIRE', 'fire missing at shoot');
  check(countCells(next.board, 'FIRE') === countCells(prev.board, 'FIRE') + 2, 'fire count must grow by exactly 2');
  for (let r = 0; r < prev.board.length; r++) {
    for (let c = 0; c < prev.board.length; c++) {
      if (prev.board[r]![c] === 'FIRE') check(next.board[r]![c] === 'FIRE', `fire at (${r},${c}) disappeared`);
    }
  }
  for (const p of next.players) {
    check(countCells(next.board, p) === next.piecesPerPlayer, `${p} piece count changed`);
  }
  for (const p of prev.eliminated) check(next.eliminated.includes(p), `${p} was un-eliminated`);
  for (const p of next.eliminated) {
    check(!next.activePlayers.includes(p), `${p} is both active and eliminated`);
    check(!hasValidAction(next.board, p), `${p} eliminated while still able to play`);
  }
  check(next.activePlayers.length + next.eliminated.length === next.players.length, 'player bookkeeping mismatch');
  if (next.status === 'PLAYING') {
    check(next.activePlayers.length >= 2, 'PLAYING with fewer than 2 active players');
    check(next.currentPlayer !== mover || next.activePlayers.length === 1, 'turn did not advance');
    check(next.activePlayers.includes(next.currentPlayer), 'current player is not active');
    check(hasValidAction(next.board, next.currentPlayer), 'current player has no legal action but was not eliminated');
    // Every active opponent of the mover must be able to play.
    for (const p of next.activePlayers) {
      if (p !== mover) check(hasValidAction(next.board, p), `${p} should have been eliminated`);
    }
  } else {
    check(next.winner !== null && next.activePlayers.length === 1 && next.activePlayers[0] === next.winner, 'bad finished state');
  }
}

interface MatchResult {
  boardSize: BoardSize;
  playerCount: PlayerCount;
  pieces: number;
  seed: number;
  turns: number;
  winner: string;
  eliminationOrder: string;
  fireTiles: number;
  error?: string;
}

function playMatch(
  boardSize: BoardSize,
  playerCount: PlayerCount,
  pieces: number,
  seed: number,
  onTurn?: (state: GameState) => void,
): MatchResult {
  const setupRng = seeded(seed);
  const moveRng = seeded(seed * 7919 + 1);
  let s = createGame({ boardSize, playerCount, piecesPerPlayer: pieces, placementMode: 'RANDOM' }, setupRng);
  const base = { boardSize, playerCount, pieces, seed };
  try {
    check(s.status === 'PLAYING' && s.activePlayers.length === playerCount, 'bad initial state');
    onTurn?.(s);
    const maxTurns = boardSize * boardSize; // each turn burns 2 squares, so this is a hard upper bound
    while (s.status === 'PLAYING') {
      const actions = getValidActions(s);
      check(actions.length > 0, `${s.currentPlayer} to move but has no actions`);
      const action = actions[Math.floor(moveRng() * actions.length)]!;
      check(validateAction(s, action) === null, 'generated action failed validation');
      const next = applyAction(s, action);
      verifyTurn(s, action, next);
      s = next;
      onTurn?.(s);
      check(s.turnNumber <= maxTurns, 'match did not terminate');
    }
    return {
      ...base,
      turns: s.turnNumber,
      winner: s.winner ?? '-',
      eliminationOrder: s.eliminated.join('>'),
      fireTiles: countCells(s.board, 'FIRE'),
    };
  } catch (err) {
    return { ...base, turns: s.turnNumber, winner: '-', eliminationOrder: '', fireTiles: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Run everything
// ---------------------------------------------------------------------------

const line = (ch = '='): string => ch.repeat(72);

console.log(line());
console.log(' PART 1 - Critical edge cases');
console.log(line());
for (const r of edgeResults) {
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}\n          -> ${r.detail}`);
}

console.log('\n' + line());
console.log(' PART 2 - Sample 6x6 match (2 players, 3 pieces, seed 2026)');
console.log(line());
console.log('  Legend: 1/2 = pieces  [n] = piece that just moved  T = trail left this turn');
console.log('          A = arrow fire this turn  # = older fire  . = empty\n');
{
  const frames: GameState[] = [];
  const sample = playMatch(6, 2, 3, 2026, (st) => frames.push(st));
  for (const st of frames.slice(0, 4)) {
    const a = st.lastAction;
    const title = a
      ? `Turn ${st.turnNumber}: ${frames[st.turnNumber - 1]!.currentPlayer} moves ${fmt(a.from)} -> ${fmt(a.to)}, shoots ${fmt(a.shoot)}`
      : 'Initial board';
    console.log(`  ${title}`);
    console.log(renderBoard(st) + '\n');
  }
  const final = frames[frames.length - 1]!;
  const fa = final.lastAction!;
  console.log(`  ... FINAL (turn ${final.turnNumber}): ${frames[final.turnNumber - 1]!.currentPlayer} moved ${fmt(fa.from)} -> ${fmt(fa.to)}, shot ${fmt(fa.shoot)}`);
  console.log(renderBoard(final));
  console.log(`\n  Winner: ${sample.winner}   Eliminated: ${sample.eliminationOrder}   Fire tiles: ${sample.fireTiles}/36${sample.error ? `   ERROR: ${sample.error}` : ''}`);
}

console.log('\n' + line());
console.log(' PART 3 - 50 random full matches (invariants checked every turn)');
console.log(line());
const configs: Array<[BoardSize, PlayerCount]> = [];
for (const size of [6, 10, 12] as const) for (const pc of [2, 3, 4] as const) configs.push([size, pc]);

const results: MatchResult[] = [];
const pieceCursor = new Map<string, number>();
const t0 = Date.now();
for (let i = 0; i < 50; i++) {
  const [size, pc] = configs[i % configs.length]!;
  const { min, max } = getPieceLimits(size);
  const key = `${size}-${pc}`;
  const k = pieceCursor.get(key) ?? 0;
  pieceCursor.set(key, k + 1);
  const pieces = min + (k % (max - min + 1)); // cycle through every legal piece count
  results.push(playMatch(size, pc, pieces, 1000 + i));
}
const elapsed = Date.now() - t0;

console.log('  Board  Players  Pieces | Matches  Avg turns  Min-Max  | Wins by player        | Errors');
console.log('  ' + '-'.repeat(88));
for (const [size, pc] of configs) {
  const rs = results.filter((r) => r.boardSize === size && r.playerCount === pc);
  const ok = rs.filter((r) => !r.error);
  const turns = ok.map((r) => r.turns);
  const wins = new Map<string, number>();
  for (const r of ok) wins.set(r.winner, (wins.get(r.winner) ?? 0) + 1);
  const winStr = [...wins.entries()].sort().map(([p, n]) => `${p}:${n}`).join(' ');
  const pieceSet = [...new Set(rs.map((r) => r.pieces))].sort().join(',');
  const avg = turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : '-';
  console.log(
    `  ${`${size}x${size}`.padEnd(6)} ${String(pc).padEnd(8)} ${pieceSet.padEnd(6)} | ${String(rs.length).padEnd(8)} ${avg.padEnd(10)} ${`${Math.min(...turns)}-${Math.max(...turns)}`.padEnd(8)} | ${winStr.padEnd(21)} | ${rs.length - ok.length}`,
  );
}

const failedMatches = results.filter((r) => r.error);
const failedEdges = edgeResults.filter((r) => !r.ok);
const totalTurns = results.reduce((a, r) => a + r.turns, 0);
console.log('  ' + '-'.repeat(88));
console.log(`  ${results.length} matches, ${totalTurns} turns verified in ${elapsed} ms`);
for (const r of failedMatches) {
  console.log(`  FAILED ${r.boardSize}x${r.boardSize} ${r.playerCount}p ${r.pieces}pc seed=${r.seed} turn=${r.turns}: ${r.error}`);
}

console.log('\n' + line());
const allOk = failedMatches.length === 0 && failedEdges.length === 0;
console.log(
  ` RESULT: ${allOk ? 'ALL CHECKS PASSED' : 'FAILURES DETECTED'} - edge cases ${edgeResults.length - failedEdges.length}/${edgeResults.length}, ` +
    `matches ${results.length - failedMatches.length}/${results.length} finished with a single winner`,
);
console.log(line());
if (!allOk) throw new Error('Simulation found failures');

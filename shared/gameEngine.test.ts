/**
 * Tribal Wars engine tests. Run with:  npx tsx gameEngine.test.ts
 * Dependency-free mini harness (no test framework required).
 */
import {
  applyAction,
  createGame,
  createStateFromBoard,
  getPieceLimits,
  getQueenReachable,
  getValidActions,
  getValidActionsOnBoard,
  GameRuleError,
  hasValidAction,
  isValidAction,
  tryApplyAction,
  validateAction,
  validateConfig,
  type BoardSize,
  type Cell,
  type GameState,
  type MoveAction,
} from './gameEngine.js';

// ---------------------------------------------------------------------------
// Mini harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} — expected ${e}, got ${a}`);
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
  } catch (err) {
    assert(err instanceof GameRuleError, `${msg} — threw a non-GameRuleError`);
    return;
  }
  throw new Error(`${msg} — expected to throw`);
}

/** Seeded PRNG (mulberry32) for reproducible createGame tests. */
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

/** '.' = EMPTY, '#' = FIRE, '1'..'4' = P1..P4. Whitespace between cells is ignored. */
function parseBoard(rows: string[]): Cell[][] {
  return rows.map((line) =>
    [...line.replace(/\s+/g, '')].map((ch): Cell => {
      switch (ch) {
        case '.': return 'EMPTY';
        case '#': return 'FIRE';
        case '1': return 'P1';
        case '2': return 'P2';
        case '3': return 'P3';
        case '4': return 'P4';
        default: throw new Error(`Unknown board char "${ch}"`);
      }
    }),
  );
}

const at = (row: number, col: number) => ({ row, col });
const act = (from: [number, number], to: [number, number], shoot: [number, number]): MoveAction => ({
  from: at(...from),
  to: at(...to),
  shoot: at(...shoot),
});

const OPEN_6: string[] = [
  '1 . . . . 2',
  '. . . . . .',
  '. . . . . .',
  '. . . . . .',
  '. . . . . .',
  '1 . . . . 2',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nConfig & setup');

test('piece limits per board size', () => {
  assertEqual(getPieceLimits(6), { min: 2, max: 4 }, '6x6');
  assertEqual(getPieceLimits(10), { min: 4, max: 6 }, '10x10');
  assertEqual(getPieceLimits(12), { min: 4, max: 6 }, '12x12');
});

test('validateConfig accepts all legal combinations', () => {
  for (const boardSize of [6, 10, 12] as const) {
    const { min, max } = getPieceLimits(boardSize);
    for (const playerCount of [2, 3, 4] as const) {
      for (let p = min; p <= max; p++) {
        assertEqual(validateConfig({ boardSize, playerCount, piecesPerPlayer: p }), [], `${boardSize}/${playerCount}/${p}`);
      }
    }
  }
});

test('validateConfig rejects illegal sizes, player counts and piece counts', () => {
  const bad: Array<[number, number, number]> = [
    [8, 2, 3], [6, 1, 2], [6, 5, 2], [6, 2, 1], [6, 2, 5], [10, 2, 3], [10, 2, 7], [12, 4, 3], [12, 2, 7], [6, 2, 2.5],
  ];
  for (const [boardSize, playerCount, piecesPerPlayer] of bad) {
    const errors = validateConfig({
      boardSize: boardSize as BoardSize,
      playerCount: playerCount as 2,
      piecesPerPlayer,
    });
    assert(errors.length > 0, `expected errors for ${boardSize}/${playerCount}/${piecesPerPlayer}`);
  }
});

test('createGame throws on invalid config', () => {
  assertThrows(() => createGame({ boardSize: 6, playerCount: 2, piecesPerPlayer: 5 }), '6x6 with 5 pieces');
  assertThrows(() => createGame({ boardSize: 10, playerCount: 4, piecesPerPlayer: 3 }), '10x10 with 3 pieces');
});

test('createGame places the right pieces for every size/player combination', () => {
  const rng = seeded(42);
  for (const boardSize of [6, 10, 12] as const) {
    const { min, max } = getPieceLimits(boardSize);
    for (const playerCount of [2, 3, 4] as const) {
      for (const pieces of [min, max]) {
        const s = createGame({ boardSize, playerCount, piecesPerPlayer: pieces }, rng);
        assertEqual(s.board.length, boardSize, 'rows');
        assert(s.board.every((r) => r.length === boardSize), 'cols');
        assertEqual(s.players.length, playerCount, 'player count');
        for (const p of s.players) {
          const count = s.board.flat().filter((c) => c === p).length;
          assertEqual(count, pieces, `${p} piece count on ${boardSize}x${boardSize}`);
        }
        assertEqual(s.board.flat().filter((c) => c === 'FIRE').length, 0, 'no fire at start');
        assertEqual(s.status, 'PLAYING', 'status');
        assertEqual(s.currentPlayer, 'P1', 'P1 starts');
      }
    }
  }
});

test('createGame is reproducible with the same seed', () => {
  const a = createGame({ boardSize: 10, playerCount: 3, piecesPerPlayer: 5 }, seeded(7));
  const b = createGame({ boardSize: 10, playerCount: 3, piecesPerPlayer: 5 }, seeded(7));
  assertEqual(a.board, b.board, 'same board');
});

console.log('\nQueen movement & shooting');

test('Queen reach on an open board from a corner', () => {
  const board = parseBoard(OPEN_6);
  // From (0,0): right blocked at (0,5) by P2 -> 4 squares; down blocked at (5,0) by P1 -> 4; diagonal to (5,5) blocked by P2 -> 4
  assertEqual(getQueenReachable(board, at(0, 0)).length, 12, 'reachable squares');
});

test('movement cannot jump over pieces or fire, nor land on them', () => {
  const s = createStateFromBoard(parseBoard([
    '1 # . . . 2',
    '2 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . 1',
  ]), ['P1', 'P2']);
  assert(!isValidAction(s, act([0, 0], [0, 2], [0, 3])), 'jumped over fire');
  assert(!isValidAction(s, act([0, 0], [0, 1], [1, 1])), 'landed on fire');
  assert(!isValidAction(s, act([0, 0], [2, 0], [3, 0])), 'jumped over a piece');
  assert(!isValidAction(s, act([0, 0], [1, 0], [2, 0])), 'landed on a piece');
  assert(isValidAction(s, act([0, 0], [4, 4], [4, 0])), 'diagonal move + orthogonal shot should be legal');
});

test('non-Queen (knight-like) moves and shots are rejected', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  assert(validateAction(s, act([0, 0], [2, 1], [3, 1])) !== null, 'knight move');
  assert(validateAction(s, act([0, 0], [2, 2], [3, 4])) !== null, 'knight shot');
});

test('cannot move an opponent piece or move out of turn', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  assert(!isValidAction(s, act([0, 5], [2, 5], [3, 5])), 'moved P2 piece on P1 turn');
  assert(!isValidAction(s, act([2, 2], [3, 3], [4, 4])), 'moved from an empty square');
});

test('arrow cannot pass through the freshly ignited origin square', () => {
  const s = createStateFromBoard(parseBoard([
    '. . . . . 2',
    '. . . . . .',
    '1 . . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . 2',
  ]), ['P1', 'P2']);
  // Move (2,0) -> (2,3), then shoot back left past origin to (2,0)? origin is FIRE now.
  assert(!isValidAction(s, act([2, 0], [2, 3], [2, 0])), 'shot onto the trail square');
  // Moving right from (2,0)->(2,2) and shooting left to (2,1) is fine (before the trail).
  assert(isValidAction(s, act([2, 0], [2, 2], [2, 1])), 'shot into square between trail and piece');
  // But a shot that would need to cross the trail is not.
  const s2 = createStateFromBoard(parseBoard([
    '. . . . . 2',
    '. . . . . .',
    '. 1 . . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . 2',
  ]), ['P1', 'P2']);
  assert(!isValidAction(s2, act([2, 1], [2, 3], [2, 0])), 'shot crossed the trail');
});

test('arrow cannot land on a piece', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  assert(!isValidAction(s, act([0, 0], [0, 4], [0, 5])), 'shot onto opponent piece');
});

test('out-of-bounds coordinates are rejected', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  assert(!isValidAction(s, act([0, 0], [-1, 0], [0, 0])), 'negative coords');
  assert(!isValidAction(s, act([0, 0], [1, 1], [1, 6])), 'shot off board');
});

console.log('\nAtomic turn execution');

test('applyAction: trail at origin, piece at destination, fire at arrow target', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  const next = applyAction(s, act([0, 0], [2, 2], [2, 4]));
  assertEqual(next.board[0]![0], 'FIRE', 'trail');
  assertEqual(next.board[2]![2], 'P1', 'piece moved');
  assertEqual(next.board[2]![4], 'FIRE', 'arrow fire');
  assertEqual(next.currentPlayer, 'P2', 'turn passes');
  assertEqual(next.turnNumber, 1, 'turn counter');
  assertEqual(next.board.flat().filter((c) => c === 'FIRE').length, 2, 'exactly two new fires');
});

test('applyAction is immutable (input state untouched)', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  const snapshot = JSON.stringify(s);
  applyAction(s, act([0, 0], [2, 2], [2, 4]));
  assertEqual(JSON.stringify(s), snapshot, 'state mutated');
});

test('fire is permanent across turns and blocks later moves', () => {
  let s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  s = applyAction(s, act([0, 0], [2, 2], [2, 4])); // P1
  s = applyAction(s, act([0, 5], [1, 4], [1, 0])); // P2
  assertEqual(s.board[0]![0], 'FIRE', 'P1 trail still burning');
  assertEqual(s.board[2]![4], 'FIRE', 'P1 arrow still burning');
  assertEqual(s.board[0]![5], 'FIRE', 'P2 trail');
  assertEqual(s.board[1]![0], 'FIRE', 'P2 arrow');
  // P1 at (2,2) cannot move through (2,4) to (2,5)
  assert(!isValidAction(s, act([2, 2], [2, 5], [3, 5])), 'moved through fire');
  assert(isValidAction(s, act([2, 2], [3, 3], [4, 4])), 'normal action still ok');
});

test('illegal actions throw / tryApplyAction returns error', () => {
  const s = createStateFromBoard(parseBoard(OPEN_6), ['P1', 'P2']);
  assertThrows(() => applyAction(s, act([0, 0], [2, 1], [3, 1])), 'knight move');
  const r = tryApplyAction(s, act([0, 0], [2, 1], [3, 1]));
  assert(!r.ok, 'expected failure');
});

test('every action from getValidActions is accepted by validateAction', () => {
  const s = createGame({ boardSize: 6, playerCount: 3, piecesPerPlayer: 3 }, seeded(3));
  const actions = getValidActions(s);
  assert(actions.length > 0, 'expected actions');
  for (const a of actions) assert(validateAction(s, a) === null, `rejected generated action ${JSON.stringify(a)}`);
});

console.log('\nElimination & win condition');

test('edge case: piece can move but has no valid shot afterwards -> no valid actions', () => {
  // P1 at (0,0) can only move to (0,1). After moving, (0,0) is FIRE and every
  // other neighbour of (0,1) is blocked, so no arrow can be shot.
  const board = parseBoard([
    '1 . # . . .',
    '# # # . . .',
    '. . . . . .',
    '. . . . . .',
    '. . . . . 2',
    '. . . . . 2',
  ]);
  assertEqual(getQueenReachable(board, at(0, 0)).length, 1, 'P1 has exactly one move');
  assertEqual(getValidActionsOnBoard(board, 'P1').length, 0, 'P1 has no complete turn');
  assert(!hasValidAction(board, 'P1'), 'hasValidAction should be false');
  // Creating a state where P1 is stuck: P1 is eliminated immediately and P2 wins.
  const s = createStateFromBoard(board, ['P1', 'P2']);
  assertEqual(s.status, 'FINISHED', 'finished');
  assertEqual(s.winner, 'P2', 'P2 wins');
  assertEqual(s.eliminated, ['P1'], 'P1 eliminated');
});

test('a move that traps the opponent eliminates them and ends a 2-player match', () => {
  // P2 at (0,5) can only escape via (0,4); P1 burns it with a diagonal arrow.
  const s = createStateFromBoard(parseBoard([
    '. . . . . 2',
    '. . . . # #',
    '. . . . . .',
    '1 . . . . .',
    '. . . . . .',
    '. . . . . .',
  ]), ['P1', 'P2']);
  assertEqual(s.status, 'PLAYING', 'still playing');
  const next = applyAction(s, act([3, 0], [3, 1], [0, 4])); // diagonal shot (2,2)->(1,3)->(0,4)
  assertEqual(next.board[0]![4], 'FIRE', 'escape square burnt');
  assertEqual(next.status, 'FINISHED', 'match over');
  assertEqual(next.winner, 'P1', 'P1 wins');
  assertEqual(next.eliminated, ['P2'], 'P2 eliminated');
  assertEqual(next.activePlayers, ['P1'], 'only P1 left');
  assertThrows(() => applyAction(next, act([3, 4], [4, 4], [5, 4])), 'no moves after finish');
});

test('3-player: eliminated player is skipped in turn rotation', () => {
  const s = createStateFromBoard(parseBoard([
    '. . . . . 2',
    '. . . . # #',
    '. . . . . .',
    '1 . . . . .',
    '. . . . . .',
    '3 . . . . .',
  ]), ['P1', 'P2', 'P3']);
  const next = applyAction(s, act([3, 0], [3, 1], [0, 4])); // traps P2
  assertEqual(next.status, 'PLAYING', 'still playing with P1 & P3');
  assertEqual(next.eliminated, ['P2'], 'P2 eliminated');
  assertEqual(next.activePlayers, ['P1', 'P3'], 'active');
  assertEqual(next.currentPlayer, 'P3', 'P2 skipped -> P3');
  const after = applyAction(next, act([5, 0], [5, 2], [5, 3]));
  assertEqual(after.currentPlayer, 'P1', 'rotation wraps back to P1');
});

test('mover who traps everyone else wins even if self is also stuck', () => {
  // P1 at (0,0) moves to (0,1) and shoots (0,2); P1 is now stuck too, but P2 is
  // eliminated first (start of their turn), leaving P1 as last player standing.
  const s = createStateFromBoard(parseBoard([
    '1 . . # 2 #',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
  ]), ['P1', 'P2']);
  // P2 at (0,4) has no move at all (all neighbours blocked) -> already stuck.
  assertEqual(s.status, 'FINISHED', 'P2 stuck from the start');
  const s2 = createStateFromBoard(parseBoard([
    '1 . . . 2 .',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
    '# # # # # #',
  ]), ['P1', 'P2']);
  assertEqual(s2.status, 'PLAYING', 'both can act');
  // P1: (0,0)->(0,2), shoot (0,3). P2 at (0,4) can move to (0,5) but then cannot shoot.
  const next = applyAction(s2, act([0, 0], [0, 2], [0, 3]));
  assertEqual(next.status, 'FINISHED', 'finished');
  assertEqual(next.winner, 'P1', 'P1 last standing');
});

test('4-player full random playthrough always terminates with a single winner', () => {
  for (const [size, pieces] of [[6, 2], [6, 4], [10, 4], [12, 6]] as const) {
    let s: GameState = createGame({ boardSize: size, playerCount: 4, piecesPerPlayer: pieces }, seeded(size * 100 + pieces));
    const rng = seeded(size + pieces);
    let guard = 0;
    while (s.status === 'PLAYING') {
      const actions = getValidActions(s);
      assert(actions.length > 0, `current player ${s.currentPlayer} has no actions but was not eliminated`);
      const fireBefore = s.board.flat().filter((c) => c === 'FIRE').length;
      s = applyAction(s, actions[Math.floor(rng() * actions.length)]!);
      assertEqual(s.board.flat().filter((c) => c === 'FIRE').length, fireBefore + 2, 'two fires per turn');
      assert(++guard < size * size, 'game did not terminate');
    }
    assert(s.winner !== null, 'winner expected');
    assertEqual(s.activePlayers, [s.winner], 'only winner active');
    assertEqual(s.eliminated.length, 3, 'three eliminated');
    for (const p of s.players) {
      assertEqual(s.board.flat().filter((c) => c === p).length, pieces, `${p} keeps all pieces`);
    }
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  throw new Error(`Failures:\n${failures.join('\n')}`);
}

/**
 * Tests for /shared/telemetry.ts. Run: `npx tsx telemetry.test.ts` (or `npm test`).
 */
import {
  createGame,
  createStateFromBoard,
  getValidActionsOnBoard,
  hasValidAction,
  type Cell,
  type GameState,
} from './gameEngine.ts';
import { randomAction, randomPlacement } from './aiBots.ts';
import {
  CSV_COLUMNS,
  applyDecision,
  computeBoardMetrics,
  createMatchId,
  describeTransition,
  directionOf,
  distanceFromCenter,
  kingDistanceMap,
  legalActionCount,
  matchToCsv,
  queenDistanceMap,
  rebuildMatchTelemetry,
  buildMatchTelemetry,
  spawnDecisions,
  toAlgebraic,
  type Decision,
  type MatchMeta,
  type TelemetryEvent,
} from './telemetry.ts';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}
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
function parseBoard(rows: string[]): Cell[][] {
  const map: Record<string, Cell> = { '.': 'EMPTY', '#': 'FIRE', '1': 'P1', '2': 'P2', '3': 'P3', '4': 'P4' };
  return rows.map((line) => [...line].map((ch) => map[ch]!));
}
const at = (row: number, col: number) => ({ row, col });
const meta0 = { controller: 'test', modelUsed: null, fallback: false, reasoning: null, thinkTimeMs: 5 };

/** Plays a full seeded random match, returning every decision. */
function playRandom(seed: number, boardSize: 6 | 10 | 12, playerCount: 2 | 3 | 4, pieces: number) {
  const rnd = seeded(seed);
  let s = createGame({ boardSize, playerCount, piecesPerPlayer: pieces });
  const decisions: Decision[] = [];
  const states: GameState[] = [s];
  while (s.status === 'PLAYING') {
    const d: Decision =
      s.phase === 'PLACEMENT'
        ? { ...meta0, kind: 'placement', player: s.currentPlayer, placement: randomPlacement(s, rnd)! }
        : { ...meta0, kind: 'move', player: s.currentPlayer, move: randomAction(s, rnd)! };
    s = applyDecision(s, d);
    decisions.push(d);
    states.push(s);
  }
  return { decisions, states, final: s };
}

const META = (config: MatchMeta['config'], players: number): MatchMeta => ({
  matchId: 'm-test',
  source: 'experiment',
  startedAt: '2026-11-21T00:00:00.000Z',
  endedAt: '2026-11-21T00:01:00.000Z',
  config,
  seats: (['P1', 'P2', 'P3', 'P4'] as const).slice(0, players).map((p) => ({ player: p, controller: 'ai', modelId: 'offline:random', label: 'Random' })),
});

console.log('\nTelemetry tests\n');

test('algebraic notation, directions and centre distance', () => {
  assertEqual(toAlgebraic(at(0, 0)), 'a1', 'a1');
  assertEqual(toAlgebraic(at(11, 11)), 'l12', 'l12');
  assertEqual(toAlgebraic(at(3, 2)), 'c4', 'c4');
  assertEqual(directionOf(at(2, 2), at(5, 2)), 'N', 'rank up = N');
  assertEqual(directionOf(at(2, 2), at(0, 4)), 'SE', 'rank down + file up = SE');
  assertEqual(directionOf(at(2, 2), at(2, 0)), 'W', 'W');
  assertEqual(directionOf(at(2, 2), at(3, 4)), null, 'not a Queen line');
  assertEqual(distanceFromCenter(6, at(0, 0)), 3.536, 'corner of 6x6');
  assertEqual(distanceFromCenter(5, at(2, 2)), 0, 'exact centre');
});

test('Queen vs King distance maps on an open board', () => {
  const s = createStateFromBoard(parseBoard(['1.....', '......', '......', '......', '......', '.....2']), ['P1', 'P2']);
  const q = queenDistanceMap(s.board, [at(0, 0)]);
  const k = kingDistanceMap(s.board, [at(0, 0)]);
  assertEqual(q[4 * 6 + 4], 1, 'queen: diagonal in 1');
  assertEqual(k[4 * 6 + 4], 4, 'king: 4 steps');
  assertEqual(q[2 * 6 + 1], 2, 'queen: off-line square in 2');
  assertEqual(q[0], -1, 'source square itself is not empty');
  assertEqual(q[35], -1, 'enemy piece square is not reachable');
});

test('Voronoi partition + exclusive regions on a walled board', () => {
  const s = createStateFromBoard(parseBoard(['1.#...', '..#...', '###...', '......', '......', '.....2']), ['P1', 'P2']);
  const m = computeBoardMetrics(s);
  const [p1, p2] = m.players;
  assertEqual([p1!.queenVoronoiCells, p2!.queenVoronoiCells, m.queenContestedCells], [3, 26, 0], 'queen territory');
  assertEqual([p1!.kingVoronoiCells, p2!.kingVoronoiCells], [3, 26], 'king territory');
  assertEqual([p1!.exclusiveSafeCells, p2!.exclusiveSafeCells], [3, 26], 'both regions are exclusive');
  assertEqual([m.emptyCells, m.fireTileCount, m.fireCoverageRatio], [29, 5, 0.1389], 'fire stats');
});

test('contested squares and symmetry with mirrored tribes', () => {
  const s = createStateFromBoard(parseBoard(['1....2', '......', '......', '......', '......', '......']), ['P1', 'P2']);
  const m = computeBoardMetrics(s);
  const [p1, p2] = m.players;
  assertEqual(p1!.queenVoronoiCells, p2!.queenVoronoiCells, 'mirror => equal queen territory');
  assertEqual(p1!.kingVoronoiCells, p2!.kingVoronoiCells, 'mirror => equal king territory');
  assert(m.queenContestedCells > 0, 'row 0 between the tribes is contested');
  assertEqual(p1!.queenVoronoiCells + p2!.queenVoronoiCells + m.queenContestedCells + m.neutralCells, m.emptyCells, 'partition');
  assertEqual(p1!.contestedCells, m.queenContestedCells, '2 tribes: every tie involves P1');
  assertEqual([p1!.exclusiveSafeCells, p2!.exclusiveSafeCells], [0, 0], 'shared region is not exclusive');
});

test('legal action counts and trapped pieces match brute-force enumeration (3 random matches)', () => {
  let checked = 0;
  for (const [seed, size, players, pieces] of [[1, 6, 2, 3], [2, 10, 3, 4], [3, 12, 4, 5]] as const) {
    const { states } = playRandom(seed, size, players, pieces);
    for (const s of states.filter((_, i) => i % 3 === 0)) {
      const m = computeBoardMetrics(s);
      for (const p of s.players) {
        const brute = getValidActionsOnBoard(s.board, p).length;
        assertEqual(legalActionCount(s, p), brute, `legal actions ${p}`);
        const pm = m.players.find((x) => x.player === p)!;
        assertEqual(pm.legalActions, brute, 'metrics legalActions');
        assertEqual(pm.activePiecesCount + pm.trappedPiecesCount, pm.pieceCount, 'active + trapped = pieces');
        assertEqual(pm.activePiecesCount > 0, hasValidAction(s.board, p), 'some active piece <=> has a turn');
        checked++;
      }
      const owned = m.players.reduce((a, p) => a + p.queenVoronoiCells, 0);
      assertEqual(owned + m.queenContestedCells + m.neutralCells, m.emptyCells, 'queen partition');
    }
  }
  assert(checked > 50, `checked ${checked} player-states`);
});

test('describeTransition: notation, piece id, distances, mobility deltas', () => {
  let s = createStateFromBoard(parseBoard(['1.....', '......', '......', '......', '......', '.....2']), ['P1', 'P2']);
  const move = { from: at(0, 0), to: at(3, 3), shoot: at(3, 0) };
  const next = applyDecision(s, { ...meta0, kind: 'move', player: 'P1', move });
  const e = describeTransition(s, next, { ...meta0, kind: 'move', player: 'P1', move }, 0);
  assertEqual(e.notation, 'a1-d4/a4', 'notation');
  assertEqual(e.pieceId, 'P1_1', 'piece id');
  assertEqual([e.moveDistance, e.moveDirection, e.shootDistance, e.shootDirection], [3, 'NE', 3, 'W'], 'geometry');
  assertEqual(e.turnNumber, 1, 'turn number');
  assertEqual(e.totalValidActionsBefore, getValidActionsOnBoard(s.board, 'P1').length, 'before');
  assertEqual(e.playerMobilityAfter, getValidActionsOnBoard(next.board, 'P1').length, 'after');
  const oppDelta = getValidActionsOnBoard(next.board, 'P2').length - getValidActionsOnBoard(s.board, 'P2').length;
  assertEqual(e.opponentsMobilityDelta, oppDelta, 'opponents delta');
  assert(e.opponentsMobilityDelta < 0, 'fire reduced opponent options');
  assertEqual(e.board[0], '#.....', 'snapshot row 0 has the trail');
  s = next;
});

test('replay: incremental events == authoritative rebuild, deterministic, with RANDOM spawn', () => {
  const rnd = seeded(77);
  let s = createGame({ boardSize: 10, playerCount: 3, piecesPerPlayer: 4, placementMode: 'RANDOM' }, rnd);
  const decisions: Decision[] = spawnDecisions(s);
  // Rebuild the spawn events, then keep playing incrementally.
  const config = { boardSize: 10, playerCount: 3, piecesPerPlayer: 4, placementMode: 'RANDOM' } as const;
  const events: TelemetryEvent[] = rebuildPrefix(config, decisions);
  while (s.status === 'PLAYING') {
    const d: Decision = { ...meta0, kind: 'move', player: s.currentPlayer, move: randomAction(s, rnd)!, reasoning: 'x, "quoted"' };
    const next = applyDecision(s, d);
    events.push(describeTransition(s, next, d, decisions.length));
    decisions.push(d);
    s = next;
  }
  const meta = META(config, 3);
  const live = buildMatchTelemetry(meta, events, s);
  const rebuilt = rebuildMatchTelemetry(meta, decisions);
  assertEqual(rebuilt, live, 'rebuild equals live recording');
  assertEqual(rebuildMatchTelemetry(meta, decisions), rebuilt, 'deterministic');
  assertEqual(live.summary.totalPlacements, 12, '12 spawn placements recorded');
  assertEqual(live.summary.totalTurns, s.turnNumber, 'turns');
  assertEqual(live.summary.seats.find((x) => x.placing === 1)?.player, s.winner, 'placing 1 = winner');
  assertEqual(live.summary.eliminationOrder, s.eliminated, 'elimination order');
});

function rebuildPrefix(config: MatchMeta['config'], decisions: Decision[]): TelemetryEvent[] {
  let s = createGame({ ...config, placementMode: 'MANUAL' });
  return decisions.map((d, i) => {
    const next = applyDecision(s, d);
    const e = describeTransition(s, next, d, i);
    s = next;
    return e;
  });
}

test('rebuild rejects out-of-turn, illegal and unfinished logs', () => {
  const config = { boardSize: 6, playerCount: 2, piecesPerPlayer: 2, placementMode: 'MANUAL' } as const;
  const { decisions } = playRandom(5, 6, 2, 2);
  const meta = META(config, 2);
  const throws = (fn: () => void) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(throws(() => rebuildMatchTelemetry(meta, decisions.slice(0, -1))), 'unfinished rejected');
  const wrongPlayer = decisions.map((d, i) => (i === 0 ? { ...d, player: 'P2' as const } : d));
  assert(throws(() => rebuildMatchTelemetry(meta, wrongPlayer)), 'out-of-turn rejected');
  const doubled = [decisions[0]!, decisions[0]!, ...decisions.slice(2)];
  assert(throws(() => rebuildMatchTelemetry(meta, doubled)), 'occupied square rejected');
  assert(throws(() => rebuildMatchTelemetry(meta, [...decisions, decisions.at(-1)!])), 'decision after the end rejected');
  assert(!throws(() => rebuildMatchTelemetry(meta, decisions)), 'valid log accepted');
});

test('CSV: fixed header, one row per decision, quoting and formula neutralisation', () => {
  const config = { boardSize: 6, playerCount: 2, piecesPerPlayer: 2, placementMode: 'MANUAL' } as const;
  const { decisions } = playRandom(9, 6, 2, 2);
  const withText = decisions.map((d, i) => (i === 1 ? { ...d, reasoning: '=HYPERLINK("x"), then\nnew line' } : d));
  const csv = matchToCsv(rebuildMatchTelemetry(META(config, 2), withText));
  const rows = parseCsv(csv);
  assertEqual(rows[0], [...CSV_COLUMNS], 'header');
  assertEqual(rows.length, decisions.length + 1, 'one row per decision');
  for (const r of rows) assertEqual(r.length, CSV_COLUMNS.length, 'column count');
  assertEqual(rows[2]![CSV_COLUMNS.indexOf('reasoning')], `'=HYPERLINK("x"), then\nnew line`, 'escaped reasoning');
  assertEqual(rows[1]![CSV_COLUMNS.indexOf('p3_queen_voronoi')], '', 'absent tribe columns are empty');
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  return rows;
}

test('createMatchId is sortable and path-safe', () => {
  const id = createMatchId(new Date('2026-11-21T14:30:05Z'), seeded(1));
  assert(/^m-20261121-143005-[0-9a-z]{6}$/.test(id), id);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`Failures:\n${failures.join('\n')}`);

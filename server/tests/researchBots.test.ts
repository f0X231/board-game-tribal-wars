/**
 * Research bot tests. Run: `npx tsx tests/researchBots.test.ts`
 *
 * 1. Core: FastBoard move generation / elimination checks agree with the shared
 *    engine; make/unmake and deadline interruptions leave the board untouched;
 *    the alpha-beta engine (TT + PVS + killers) returns the exact minimax value.
 * 2. All 7 bots complete PLACEMENT and PLAYING turns on 6x6, 10x10, 12x12 for
 *    2 and 4 tribes, with engine-legal results and within budget.
 * 3. Full budget through the worker pool (the production path): every bot at the
 *    default 3500 ms, and 5000 ms, stays under the 5000 ms hard ceiling.
 * 4. Short complete research-vs-research matches.
 */
process.env.GROQ_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';

const { applyAction, createGame, getValidActions, hasValidAction, placePiece, validateAction, validatePlacement } = await import('../../shared/gameEngine.js');
type GameState = import('../../shared/gameEngine.js').GameState;
const { heuristicAction } = await import('../../shared/aiBots.js');
const { Clock, FastBoard, TIMEOUT, WIN, slotOf, fromOf, toOf, shootOf } = await import('../src/bots/evalUtils.js');
const { AlphaBeta } = await import('../src/bots/search.js');
const { RESEARCH_BOTS, runResearchBot, DEFAULT_BOT_BUDGET_MS, HARD_CEILING_MS } = await import('../src/bots/index.js');
const { chooseAiTurn } = await import('../src/aiService.js');
const { shutdownResearchWorkers } = await import('../src/bots/runner.js');
const { listModels } = await import('../src/models.js');

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const t = performance.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${((performance.now() - t) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
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

/** A RANDOM-spawn battle position after `turns` heuristic turns (deterministic). */
function battlePosition(boardSize: 6 | 10 | 12, playerCount: 2 | 3 | 4, pieces: number, turns: number, seed: number): GameState {
  let s = createGame({ boardSize, playerCount, piecesPerPlayer: pieces, placementMode: 'RANDOM' }, seeded(seed));
  for (let i = 0; i < turns && s.status === 'PLAYING'; i++) s = applyAction(s, heuristicAction(s)!);
  return s;
}

/** A MANUAL draft position with `placed` totems already deployed. */
function draftPosition(boardSize: 6 | 10 | 12, playerCount: 2 | 3 | 4, pieces: number, placed: number, seed: number): GameState {
  let s = createGame({ boardSize, playerCount, piecesPerPlayer: pieces, placementMode: 'MANUAL' });
  const rnd = seeded(seed);
  for (let i = 0; i < placed; i++) {
    const empties: Array<{ row: number; col: number }> = [];
    s.board.forEach((row, r) => row.forEach((c, q) => c === 'EMPTY' && empties.push({ row: r, col: q })));
    s = placePiece(s, empties[Math.floor(rnd() * empties.length)]!);
  }
  return s;
}

const boardKey = (fb: InstanceType<typeof FastBoard>) => `${Array.from(fb.cells).join('')}|${fb.hashLo}|${fb.hashHi}|${fb.empties}|${fb.pieces.map((p) => Array.from(p).join(',')).join(';')}`;

console.log('\ncore');
await test('FastBoard actions / hasAction match the shared engine on 30 positions', () => {
  for (let i = 0; i < 30; i++) {
    const size = ([6, 10, 12] as const)[i % 3]!;
    const s = battlePosition(size, (2 + (i % 3)) as 2 | 3 | 4, size === 6 ? 2 : 4, i % 11, 100 + i);
    if (s.status !== 'PLAYING') continue;
    const fb = FastBoard.fromState(s);
    const me = slotOf(s.currentPlayer);
    const fast = fb.allActions(me).map((a) => `${fromOf(a)}>${toOf(a)}>${shootOf(a)}`).sort();
    const n = s.boardSize;
    const ref = getValidActions(s).map((a) => `${a.from.row * n + a.from.col}>${a.to.row * n + a.to.col}>${a.shoot.row * n + a.shoot.col}`).sort();
    assert(fast.length === ref.length && fast.every((x, j) => x === ref[j]), `action mismatch at position ${i}: ${fast.length} vs ${ref.length}`);
    for (const p of s.players) assert(fb.hasAction(slotOf(p)) === hasValidAction(s.board, p), `hasAction mismatch for ${p}`);
  }
});

await test('make/unmake restores board + Zobrist hash; interrupted search restores the board', () => {
  const s = battlePosition(10, 2, 4, 4, 7);
  const fb = FastBoard.fromState(s);
  const before = boardKey(fb);
  const me = slotOf(s.currentPlayer);
  for (const a of fb.allActions(me).slice(0, 200)) {
    const k = fb.make(me, a);
    fb.unmake(me, a, k);
  }
  assert(boardKey(fb) === before, 'make/unmake changed the board');
  // A search cut off by its deadline mid-tree must hand the board back unchanged.
  const ab = new AlphaBeta(
    fb,
    { evaluate: (b, root) => b.reach(b.pieces[root]![0]!), candidates: (b, slot) => b.allActions(slot).slice(0, 30) },
    { maxDepth: 30, tt: true, aspiration: 2, pvs: true, killers: true, epsilon: 0.01 },
  );
  const r = ab.run(me, Clock.fromBudget(60));
  assert(r.action >= 0 && boardKey(fb) === before, 'board changed after an interrupted search');
  assert(TIMEOUT instanceof Error, 'timeout sentinel');
});

/** Plain minimax (no pruning, no TT) with the same paranoid / elimination semantics. */
function minimax(fb: InstanceType<typeof FastBoard>, root: number, slot: number, depth: number, ply: number, evaluate: (b: InstanceType<typeof FastBoard>, r: number) => number): number {
  if (fb.aliveCount() <= 1) return fb.isAlive(root) ? WIN - ply : -WIN + ply;
  if (depth === 0) return evaluate(fb, root);
  const moves = fb.allActions(slot, []);
  if (moves.length === 0) {
    if (slot === root) return -WIN + ply;
    const mask = fb.aliveMask;
    fb.aliveMask &= ~(1 << slot);
    const v = fb.aliveCount() <= 1 ? WIN - ply : minimax(fb, root, fb.nextAlive(slot), depth - 1, ply + 1, evaluate);
    fb.aliveMask = mask;
    return v;
  }
  let best = slot === root ? -Infinity : Infinity;
  for (const a of moves) {
    const k = fb.make(slot, a);
    const v = minimax(fb, root, fb.nextAlive(slot), depth - 1, ply + 1, evaluate);
    fb.unmake(slot, a, k);
    best = slot === root ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

await test('alpha-beta (TT + PVS + killers + aspiration) equals brute-force minimax on endgames', () => {
  let checked = 0;
  for (let seed = 1; checked < 8 && seed < 200; seed++) {
    const players = (seed % 2 === 0 ? 2 : 3) as 2 | 3;
    const s = battlePosition(6, players, 2, 7 + (seed % 4), seed);
    if (s.status !== 'PLAYING') continue;
    const fb = FastBoard.fromState(s);
    const me = slotOf(s.currentPlayer);
    const n = fb.allActions(me).length;
    if (n < 2 || n > 40) continue;
    const evaluate = (b: InstanceType<typeof FastBoard>, r: number) => {
      let v = 0;
      for (let p = 0; p < b.pieces[r]!.length; p++) v += b.reach(b.pieces[r]![p]!);
      for (const o of b.opponents(r)) for (let p = 0; p < b.pieces[o]!.length; p++) v -= 0.5 * b.reach(b.pieces[o]![p]!);
      return v;
    };
    const depth = 3;
    const ref = minimax(fb, me, me, depth, 0, evaluate);
    for (const opt of [
      { tt: true, pvs: true, killers: true, aspiration: 1 },
      { tt: false, pvs: false, killers: false, aspiration: null },
    ]) {
      const ab = new AlphaBeta(fb, { evaluate: (b, r) => evaluate(b, r), candidates: (b, slot) => b.allActions(slot, []) }, { maxDepth: depth, epsilon: 0.001, ...opt });
      const r = ab.run(me, Clock.fromBudget(60_000));
      assert(r.depth === depth || r.proven, `search stopped at depth ${r.depth}`);
      assert(Math.abs(r.score - ref) < 1e-9, `seed ${seed} ${JSON.stringify(opt)}: alpha-beta ${r.score} vs minimax ${ref}`);
    }
    checked++;
  }
  assert(checked >= 5, `only ${checked} endgame positions checked`);
});

await test('GET /api/models catalog lists the 7 research bots (Research Algorithms group)', () => {
  const research = listModels().filter((m) => m.provider === 'research');
  assert(research.length === 7, `found ${research.length}`);
  const ids = research.map((m) => m.id).sort();
  const expected = ['research:amazong-guard', 'research:anky-rel-territory', 'research:arrow-lsg', 'research:cgt-subgame', 'research:mg-peo-mcts', 'research:tas-move-cat', 'research:tds-endgame'];
  assert(JSON.stringify(ids) === JSON.stringify(expected), ids.join(','));
  assert(research.every((m) => m.available && m.paper && m.budgetMs === DEFAULT_BOT_BUDGET_MS), 'metadata');
});

console.log('\nall bots x boards x players x phases (budget 300 ms, in-process)');
const BUDGET = 300;
const CONFIGS = [
  { size: 6, players: 2, pieces: 2 },
  { size: 6, players: 4, pieces: 2 },
  { size: 10, players: 2, pieces: 4 },
  { size: 10, players: 4, pieces: 4 },
  { size: 12, players: 2, pieces: 4 },
  { size: 12, players: 4, pieces: 4 },
] as const;
for (const bot of RESEARCH_BOTS) {
  await test(`${bot.id}: PLACEMENT + PLAYING on 6/10/12 for 2 and 4 tribes`, () => {
    let worst = 0;
    for (const [i, c] of CONFIGS.entries()) {
      const draft = draftPosition(c.size, c.players, c.pieces, c.players + 1, 50 + i);
      let t = performance.now();
      const p = runResearchBot(draft, bot.id, BUDGET);
      worst = Math.max(worst, performance.now() - t);
      assert(p.kind === 'placement' && validatePlacement(draft, p.placement) === null, `${c.size}x${c.size}/${c.players}p illegal placement`);
      assert(p.modelUsed === bot.id, `${c.size}x${c.size}/${c.players}p placement fell back: ${p.reasoning}`);

      const battle = battlePosition(c.size, c.players, c.pieces, 3 + i, 900 + i);
      assert(battle.status === 'PLAYING', 'fixture finished early');
      t = performance.now();
      const m = runResearchBot(battle, bot.id, BUDGET);
      worst = Math.max(worst, performance.now() - t);
      assert(m.kind === 'move' && validateAction(battle, m.move) === null, `${c.size}x${c.size}/${c.players}p illegal move`);
      assert(m.modelUsed === bot.id, `${c.size}x${c.size}/${c.players}p move fell back: ${m.reasoning}`);
      assert(/\[.*\]/.test(m.reasoning), 'no search stats in reasoning');
    }
    assert(worst <= BUDGET + 100, `slowest turn ${worst.toFixed(0)} ms for a ${BUDGET} ms budget`);
  });
}

console.log(`\nfull budget via worker threads (default ${DEFAULT_BOT_BUDGET_MS} ms, hard ceiling ${HARD_CEILING_MS} ms)`);
const heavy = battlePosition(12, 4, 6, 4, 4242);
for (const bot of RESEARCH_BOTS) {
  await test(`${bot.id}: 12x12 / 4 tribes / 6 totems at ${DEFAULT_BOT_BUDGET_MS} ms`, async () => {
    const t = performance.now();
    const r = await chooseAiTurn(heavy, bot.id);
    const elapsed = performance.now() - t;
    assert(!r.fallback && r.modelUsed === bot.id, `fell back: ${r.reasoning}`);
    assert(r.kind === 'move' && validateAction(heavy, r.move) === null, 'illegal move');
    assert(elapsed < HARD_CEILING_MS, `took ${elapsed.toFixed(0)} ms`);
    assert(elapsed > DEFAULT_BOT_BUDGET_MS * 0.5, `used only ${elapsed.toFixed(0)} ms of the budget`);
    console.log(`      ${elapsed.toFixed(0)} ms  ${r.reasoning.slice(0, 150)}`);
  });
}
await test('5000 ms budget (maximum) still returns under the 5000 ms ceiling', async () => {
  const t = performance.now();
  const r = await chooseAiTurn(heavy, 'research:arrow-lsg', { botBudgetMs: 5000 });
  const elapsed = performance.now() - t;
  assert(!r.fallback, `fell back: ${r.reasoning}`);
  assert(elapsed < HARD_CEILING_MS, `took ${elapsed.toFixed(0)} ms`);
});

console.log('\ncomplete matches (6x6, budget 120 ms)');
for (const [a, b] of [
  ['research:anky-rel-territory', 'research:mg-peo-mcts'],
  ['research:cgt-subgame', 'research:amazong-guard'],
  ['research:tas-move-cat', 'research:arrow-lsg'],
  ['research:tds-endgame', 'research:anky-rel-territory'],
] as const) {
  await test(`${a} vs ${b}: draft + battle to the end, every decision by the bots`, () => {
    let s = createGame({ boardSize: 6, playerCount: 2, piecesPerPlayer: 3, placementMode: 'MANUAL' });
    let turns = 0;
    while (s.status === 'PLAYING') {
      const id = s.currentPlayer === 'P1' ? a : b;
      const d = runResearchBot(s, id, 120);
      assert(d.modelUsed === id, `fallback on turn ${turns}: ${d.reasoning}`);
      s = d.kind === 'placement' ? placePiece(s, d.placement) : applyAction(s, d.move);
      assert(++turns < 200, 'match did not end');
    }
    assert(s.winner !== null, 'no winner');
  });
}

await shutdownResearchWorkers();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
  console.error(failures.join('\n'));
}

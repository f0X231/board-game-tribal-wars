/**
 * research:guo-phased-uct
 * After Q. Guo, S. Li & H. Bao (2011), "The Research of Searching Algorithm in Amazons Game".
 *
 * Fire-count phase partitioning: the paper splits a 10x10 game by the number of
 * burnt squares (n_bars < 14, 14–50, ≥ 50 of 92 free squares). Scaled to any board,
 * the fire ratio thresholds are 14/92 ≈ 0.152 and 50/92 ≈ 0.543:
 *  - Opening  (phase 0): curated opening book for our first turn (central /
 *                        balanced "star point" squares with high mobility), then UCT
 *                        with K = 0.5, the widest move retention and a
 *                        mobility-dominant evaluation;
 *  - Midgame  (phase 1): UCT K = 0.4, balanced t1 + t2 + mobility evaluation;
 *  - Endgame  (phase 2): UCT K = 0.3 (exploit deeper), pure territory / filling
 *                        evaluation and longer playouts.
 *
 * Fast hierarchical rollout sampling: a playout turn samples
 * (1) a random totem that can move → (2) a random open direction →
 * (3) a random destination on it, then the same for the arrow — never
 * generating the full legal move list (thousands of moves on 12x12).
 */
import { MoveGroupMcts } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  EMPTY,
  Scratch,
  actionName,
  arrowValue,
  cellName,
  features,
  opponentMask,
  pack,
  prng,
  progress,
  queenDistance,
  statLine,
} from './evalUtils.js';

interface PhaseConfig {
  readonly name: 'Opening' | 'Midgame' | 'Endgame';
  readonly k: number;
  readonly rootMoves: number;
  readonly innerMoves: number;
  readonly arrows: number;
  readonly horizon: number;
}

const PHASES: readonly [PhaseConfig, PhaseConfig, PhaseConfig] = [
  { name: 'Opening', k: 0.5, rootMoves: 96, innerMoves: 28, arrows: 12, horizon: 8 },
  { name: 'Midgame', k: 0.4, rootMoves: 64, innerMoves: 20, arrows: 10, horizon: 8 },
  { name: 'Endgame', k: 0.3, rootMoves: 48, innerMoves: 14, arrows: 8, horizon: 16 },
];

/** Phase from the fire ratio (paper: n_bars < 14 / 14–50 / ≥ 50 on 92 free squares). */
export function guoPhase(fb: FastBoard): 0 | 1 | 2 {
  const p = progress(fb);
  return p < 14 / 92 ? 0 : p < 50 / 92 ? 1 : 2;
}

/** Phase-specific evaluation, root perspective, in [0, 1]. */
function phaseValue(fb: FastBoard, root: number, toMove: number, phase: 0 | 1 | 2, s: Scratch): number {
  if (!fb.hasAction(root)) return 0;
  const f = features(fb, root, s, toMove === root ? 0.2 : -0.2, phase !== 0);
  const L = Math.max(1, f.live);
  const mob = (f.mobMe - f.mobOpp) / (f.mobMe + f.mobOpp + 1);
  let v: number;
  if (phase === 0) v = 0.6 * mob + 0.4 * (f.t1 / L);
  else if (phase === 1) v = (f.t1 / L + f.t2 / L + mob) / 3;
  else v = 0.7 * (f.t1 / L) + 0.3 * (f.t2 / L) - 0.1 * f.trappedMe;
  for (const o of fb.opponents(root)) if (!fb.hasAction(o)) v += 0.3;
  return 1 / (1 + Math.exp(-6 * v));
}

/**
 * Hierarchical random action: random movable totem → random open direction →
 * random distance; arrow likewise from the destination. -1 if stuck.
 */
export function hierarchicalAction(fb: FastBoard, slot: number, rnd: () => number): number {
  const list = fb.pieces[slot]!;
  const ray = fb.g.ray;
  const cells = fb.cells;
  const movable: number[] = [];
  for (let p = 0; p < list.length; p++) {
    const c = list[p]!;
    for (let d = 0; d < 8; d++) {
      const v = ray[c * 8 + d]!;
      if (v >= 0 && cells[v] === EMPTY) {
        movable.push(c);
        break;
      }
    }
  }
  const dirs: number[] = [];
  for (let attempt = 0; attempt < 6 && movable.length > 0; attempt++) {
    const from = movable[Math.floor(rnd() * movable.length)]!;
    dirs.length = 0;
    for (let d = 0; d < 8; d++) {
      const v = ray[from * 8 + d]!;
      if (v >= 0 && cells[v] === EMPTY) dirs.push(d);
    }
    const d = dirs[Math.floor(rnd() * dirs.length)]!;
    let len = 0;
    for (let v = ray[from * 8 + d]!; v >= 0 && cells[v] === EMPTY; v = ray[v * 8 + d]!) len++;
    let to = from;
    for (let s = 1 + Math.floor(rnd() * len); s > 0; s--) to = ray[to * 8 + d]!;
    // Arrow: open directions from `to` once `from` has burnt.
    dirs.length = 0;
    for (let e = 0; e < 8; e++) {
      const v = ray[to * 8 + e]!;
      if (v >= 0 && v !== from && cells[v] === EMPTY) dirs.push(e);
    }
    if (dirs.length === 0) continue;
    const e = dirs[Math.floor(rnd() * dirs.length)]!;
    let alen = 0;
    for (let v = ray[to * 8 + e]!; v >= 0 && v !== from && cells[v] === EMPTY; v = ray[v * 8 + e]!) alen++;
    let sh = to;
    for (let s = 1 + Math.floor(rnd() * alen); s > 0; s--) sh = ray[sh * 8 + e]!;
    return pack(from, to, sh);
  }
  // Rare: every sampled destination was a dead end. Exhaustive fallback.
  const all = fb.allActions(slot);
  return all.length > 0 ? all[Math.floor(rnd() * all.length)]! : -1;
}

/** Opening-book squares: the four "star points" (thirds of the board) and the central 2x2. */
export function bookSquares(n: number): number[] {
  const a = Math.round((n - 1) / 3);
  const b = n - 1 - a;
  const c0 = Math.floor((n - 1) / 2);
  const c1 = Math.ceil((n - 1) / 2);
  const sq = [
    [a, a], [a, b], [b, a], [b, b],
    [c0, c0], [c0, c1], [c1, c0], [c1, c1],
  ];
  return [...new Set(sq.map(([r, c]) => r! * n + c!))];
}

/** First battle turn of `me` (no fire from our own moves yet). */
function isFirstTurn(fb: FastBoard): boolean {
  let fire = 0;
  for (let i = 0; i < fb.size; i++) if (fb.cells[i] === 1) fire++;
  return fire < 2 * fb.order.length;
}

/** Book move: best reachable book square by territory + mobility, arrow by the standard arrow heuristic. */
function bookMove(fb: FastBoard, me: number, s: Scratch): { action: number; square: number; score: number } | null {
  const book = new Set(bookSquares(fb.n));
  let best: { action: number; square: number; score: number } | null = null;
  const dMe = new Uint8Array(fb.size);
  const dOp = new Uint8Array(fb.size);
  for (const pair of fb.movePairs(me)) {
    const from = pair & 0xff;
    const to = (pair >>> 8) & 0xff;
    if (!book.has(to)) continue;
    const k = fb.move(me, from, to);
    const f = features(fb, me, s, 0, false);
    queenDistance(fb, 1 << me, dMe, s.queue);
    queenDistance(fb, opponentMask(fb, me), dOp, s.queue);
    const arrows: number[] = [];
    fb.rays(to, arrows, 0);
    let arrow = -1;
    let av = -Infinity;
    for (const c of arrows) {
      const v = arrowValue(fb, me, c, dMe, dOp);
      if (v > av) {
        av = v;
        arrow = c;
      }
    }
    fb.unmove(me, from, to, k);
    if (arrow < 0) continue;
    const score = f.t1 + 0.5 * f.mobMe - 0.3 * f.mobOpp + av;
    if (!best || score > best.score) best = { action: pack(from, to, arrow), square: to, score };
  }
  return best;
}

export function createGuoPhasedUct(): ResearchBot {
  return {
    id: 'research:guo-phased-uct',
    label: 'Guo Phased UCT',
    paper: 'Guo, Li & Bao 2011',
    description: 'Fire-count phases (opening book → UCT K 0.5 / 0.4 / 0.3 with phase evaluations) and fast hierarchical rollout sampling.',

    place(input) {
      const s = new Scratch(input.fb.size);
      const book = new Set(bookSquares(input.fb.n));
      return runPlacement(
        input,
        (fb, p) => {
          const f = features(fb, p, s, 0, false);
          let onBook = 0;
          const mine = fb.pieces[p]!;
          for (let i = 0; i < mine.length; i++) if (book.has(mine[i]!)) onBook++;
          // Opening philosophy: mobility first, balanced territory, star points.
          return 0.6 * f.mobMe - 0.4 * f.mobOpp + 0.4 * f.t1 + 3 * onBook;
        },
        'Phase-0 draft: high-mobility star points and balanced territory.',
      );
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const phase = guoPhase(fb);
      const cfg = PHASES[phase];
      if (phase === 0 && isFirstTurn(fb)) {
        const book = bookMove(fb, me, s);
        if (book) {
          return {
            action: book.action,
            reasoning:
              `Opening book (phase 0): star point ${cellName(fb, book.square)} — central, balanced territory and high mobility: ${actionName(fb, book.action)}. ` +
              statLine([['Phase', 'Opening'], ['', 'book move'], ['Score', `+${book.score.toFixed(1)}`]]),
          };
        }
      }
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      let plies = 0;
      const mcts = new MoveGroupMcts(
        fb,
        {
          evaluate: (b, root, toMove) => phaseValue(b, root, toMove, phase, s),
          movePairs: (b, slot, isRoot) =>
            b
              .movePairs(slot)
              .map((p) => ({ p, v: b.reach((p >>> 8) & 0xff) - 0.3 * b.g.centre[(p >>> 8) & 0xff]! }))
              .sort((x, y) => y.v - x.v)
              .slice(0, isRoot ? cfg.rootMoves : cfg.innerMoves)
              .map((x) => x.p),
          arrows: (b, slot, _from, to) => {
            queenDistance(b, 1 << slot, dMe, s.queue);
            queenDistance(b, opponentMask(b, slot), dOp, s.queue);
            const cells: number[] = [];
            b.rays(to, cells, 0);
            return cells
              .map((c) => ({ c, v: arrowValue(b, slot, c, dMe, dOp) }))
              .sort((x, y) => y.v - x.v)
              .slice(0, cfg.arrows)
              .map((x) => x.c);
          },
          simulate: (b, root, toMove, rnd) => {
            const undo: Array<{ slot: number; a: number; k: number }> = [];
            const mask = b.aliveMask;
            let slot = toMove;
            for (let ply = 0; ply < cfg.horizon && b.aliveCount() > 1; ply++) {
              const a = hierarchicalAction(b, slot, rnd);
              if (a < 0) {
                if (slot === root) break;
                b.aliveMask &= ~(1 << slot);
                slot = b.nextAlive(slot);
                continue;
              }
              undo.push({ slot, a, k: b.make(slot, a) });
              slot = b.nextAlive(slot);
              plies++;
            }
            const v = b.aliveCount() <= 1 ? (b.isAlive(root) ? 1 : 0) : phaseValue(b, root, slot, phase, s);
            for (let i = undo.length - 1; i >= 0; i--) b.unmake(undo[i]!.slot, undo[i]!.a, undo[i]!.k);
            b.aliveMask = mask;
            return v;
          },
        },
        cfg.k,
        prng(fb.hashHi ^ 0x6a09e667 ^ (me * 0x165667b1)),
      );
      const res = mcts.run(me, clock);
      const elapsed = Math.max(1, input.budgetMs - Math.max(0, clock.remaining()));
      return {
        action: res.action,
        reasoning:
          `Phased UCT (${cfg.name}, K=${cfg.k}, ${cfg.rootMoves}/${cfg.innerMoves} moves kept): ${actionName(fb, res.action)} ` +
          `won ${(res.value * 100).toFixed(0)}% of hierarchical playouts. ` +
          statLine([
            ['', `${res.simulations.toLocaleString('en-US')} playouts`],
            ['Depth', res.maxDepth],
            ['Win', `${(res.value * 100).toFixed(1)}%`],
            ['', `${Math.round((res.simulations * 1000) / elapsed).toLocaleString('en-US')} playouts/s`],
            ['', `${(plies / Math.max(1, res.simulations)).toFixed(1)} plies/playout`],
          ]),
      };
    },
  };
}

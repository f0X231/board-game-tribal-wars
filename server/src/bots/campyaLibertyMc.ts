/**
 * research:campya-liberty-mc
 * After J. Kloetzer, H. Iida & B. Bouzy (2007), "The Monte-Carlo Approach in Amazons" (CAMPYA).
 *
 * Split-action UCT: the totem movement and the arrow shot are separate tree
 * levels, each selected by Score = Eval + C · sqrt(ln N_parent / N_child).
 *
 * Knowledge-guided playouts:
 *  - Liberty rule — liberties are a totem's empty adjacent squares. A playout
 *    turn first rescues an own totem with 1–2 liberties (moves it to the
 *    sampled square with the most liberties), otherwise it tries to enclose an
 *    enemy totem with 1–2 liberties (arrow onto one of its last liberties);
 *    only then does it play a random move.
 *  - Isolated pruning — totems whose every neighbouring region is closed and
 *    single-tribe are "isolated": their moves do not affect the contest, so
 *    they are pruned (in the tree and in playouts) while contested regions
 *    still exist.
 * Accessibility cutoff: in the opening and middle game playouts stop after a
 * fixed ply horizon and are scored by Queen-move accessibility (squares with
 * D1_me < D1_opp) plus totem mobility; endgame playouts run much longer.
 */
import { MoveGroupMcts } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  EMPTY,
  INF,
  Scratch,
  actionName,
  arrowValue,
  opponentMask,
  pack,
  popcount,
  prng,
  progress,
  queenDistance,
  randomAction,
  regions,
  statLine,
} from './evalUtils.js';

const C_UCT = 0.4;
/** Playout horizon (plies) before the accessibility evaluation. */
const HORIZON_OPEN = 6;
const HORIZON_END = 24;

/** Empty king-neighbours of a totem. */
const liberties = (fb: FastBoard, cell: number): number => fb.emptyNeighbours(cell);

/**
 * Cells of totems that border no contested region (isolated), or an empty set
 * when no contested region exists any more (then nothing is pruned).
 */
export function isolatedPieces(fb: FastBoard, s: Scratch): Set<number> {
  const rs = regions(fb, s);
  const contestedPieces = new Set<number>();
  let anyContested = false;
  for (const r of rs) {
    if (popcount(r.tribes) < 2) continue;
    anyContested = true;
    for (const p of r.pieces) contestedPieces.add(p.cell);
  }
  const out = new Set<number>();
  if (!anyContested) return out;
  for (const slot of fb.order) {
    if (!fb.isAlive(slot)) continue;
    const list = fb.pieces[slot]!;
    for (let p = 0; p < list.length; p++) if (!contestedPieces.has(list[p]!)) out.add(list[p]!);
  }
  return out;
}

/** Accessibility evaluation: (D1_me < D1_opp) − (D1_opp < D1_me) + mobility, mapped to [0, 1]. */
function accessibility(fb: FastBoard, root: number, s: Scratch): number {
  if (!fb.hasAction(root)) return 0;
  queenDistance(fb, 1 << root, s.q1me, s.queue);
  queenDistance(fb, opponentMask(fb, root), s.q1op, s.queue);
  let acc = 0;
  let live = 0;
  for (let i = 0; i < fb.size; i++) {
    if (fb.cells[i] !== EMPTY) continue;
    const a = s.q1me[i]!;
    const b = s.q1op[i]!;
    if (a === INF && b === INF) continue;
    live++;
    if (a < b) acc++;
    else if (b < a) acc--;
  }
  let mob = 0;
  const mine = fb.pieces[root]!;
  for (let p = 0; p < mine.length; p++) mob += fb.reach(mine[p]!);
  let oppMob = 0;
  const opps = fb.opponents(root);
  for (const o of opps) {
    const list = fb.pieces[o]!;
    for (let p = 0; p < list.length; p++) oppMob += fb.reach(list[p]!);
  }
  oppMob /= Math.max(1, opps.length);
  let v = acc / Math.max(1, live) + 0.4 * ((mob - oppMob) / (mob + oppMob + 1));
  for (const o of opps) if (!fb.hasAction(o)) v += 0.3;
  return 1 / (1 + Math.exp(-5 * v));
}

/** Liberty-rule playout move for `slot`; returns -1 if the player is stuck. */
export function libertyMove(fb: FastBoard, slot: number, rnd: () => number, isolated: Set<number>): number {
  const list = fb.pieces[slot]!;
  const ray = fb.g.ray;
  // 1) Rescue an own totem with 1-2 liberties: sampled destination with the most liberties.
  for (let p = 0; p < list.length; p++) {
    const from = list[p]!;
    const lib = liberties(fb, from);
    if (lib < 1 || lib > 2 || isolated.has(from)) continue;
    const dests: number[] = [];
    fb.rays(from, dests, 0);
    let best = -1;
    let bestLib = lib;
    for (let k = 0; k < Math.min(8, dests.length); k++) {
      const to = dests[Math.floor(rnd() * dests.length)]!;
      const l = liberties(fb, to); // `from` is a totem now, so it is never counted
      if (l > bestLib) {
        bestLib = l;
        best = to;
      }
    }
    if (best >= 0) {
      const kk = fb.move(slot, from, best);
      const arrows: number[] = [];
      const na = fb.rays(best, arrows, 0);
      fb.unmove(slot, from, best, kk);
      if (na > 0) return pack(from, best, arrows[Math.floor(rnd() * na)]!);
    }
  }
  // 2) Enclose an enemy totem with 1-2 liberties: shoot onto one of its last liberties.
  for (const o of fb.opponents(slot)) {
    const enemy = fb.pieces[o]!;
    for (let e = 0; e < enemy.length; e++) {
      const lib = liberties(fb, enemy[e]!);
      if (lib < 1 || lib > 2) continue;
      // target = one of the enemy's empty neighbours
      let target = -1;
      for (let d = 0; d < 8 && target < 0; d++) {
        const v = ray[enemy[e]! * 8 + d]!;
        if (v >= 0 && fb.cells[v] === EMPTY) target = v;
      }
      if (target < 0) continue;
      for (let tries = 0; tries < 6; tries++) {
        const from = list[Math.floor(rnd() * list.length)]!;
        if (isolated.has(from)) continue;
        const dests: number[] = [];
        const nd = fb.rays(from, dests, 0);
        if (nd === 0) continue;
        const to = dests[Math.floor(rnd() * nd)]!;
        if (to === target) continue;
        const kk = fb.move(slot, from, to);
        const ok = lineClear(fb, to, target);
        fb.unmove(slot, from, to, kk);
        if (ok) return pack(from, to, target);
      }
    }
  }
  // 3) Random move, isolated totems pruned.
  return randomAction(fb, slot, rnd, isolated.size > 0 ? (c) => !isolated.has(c) : undefined);
}

/** True when `b` is reachable from `a` by an unobstructed queen line over empty squares. */
function lineClear(fb: FastBoard, a: number, b: number): boolean {
  const g = fb.g;
  const dr = g.row[b]! - g.row[a]!;
  const dc = g.col[b]! - g.col[a]!;
  if (!(dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc))) return false;
  const step = Math.sign(dr) * fb.n + Math.sign(dc);
  for (let v = a + step; ; v += step) {
    if (fb.cells[v] !== EMPTY) return false;
    if (v === b) return true;
  }
}

export function createCampyaLibertyMc(): ResearchBot {
  return {
    id: 'research:campya-liberty-mc',
    label: 'CAMPYA Liberty MC',
    paper: 'Kloetzer, Iida & Bouzy 2007',
    description: 'Split-action UCT (move / arrow levels) with liberty-rule playouts, isolated-piece pruning and accessibility cut-off.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(
        input,
        (fb, p) => {
          let lib = 0;
          const mine = fb.pieces[p]!;
          for (let i = 0; i < mine.length; i++) lib += Math.min(4, liberties(fb, mine[i]!));
          let oppLow = 0;
          for (const o of fb.opponents(p)) {
            const list = fb.pieces[o]!;
            for (let i = 0; i < list.length; i++) if (liberties(fb, list[i]!) <= 2) oppLow++;
          }
          return 100 * accessibility(fb, p, s) + 2 * lib + 4 * oppLow;
        },
        'Accessibility draft: squares we reach first, keeping our liberties and squeezing theirs.',
      );
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const rs = new Scratch(fb.size);
      const ps = new Scratch(fb.size);
      const endgame = progress(fb) >= 0.6;
      const horizon = endgame ? HORIZON_END : HORIZON_OPEN;
      const rootIsolated = isolatedPieces(fb, ps);
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      let playoutPlies = 0;
      const value = (b: FastBoard, root: number) => accessibility(b, root, s);
      const mcts = new MoveGroupMcts(
        fb,
        {
          evaluate: (b, root) => value(b, root),
          movePairs: (b, slot, isRoot) => {
            const iso = isRoot ? rootIsolated : isolatedPieces(b, ps);
            let pairs = b.movePairs(slot);
            if (iso.size > 0) {
              const pruned = pairs.filter((p) => !iso.has(p & 0xff));
              if (pruned.length > 0) pairs = pruned;
            }
            return pairs
              .map((p) => ({ p, v: liberties(b, (p >>> 8) & 0xff) + 0.1 * b.reach((p >>> 8) & 0xff) }))
              .sort((x, y) => y.v - x.v)
              .slice(0, isRoot ? 64 : 20)
              .map((x) => x.p);
          },
          arrows: (b, slot, _from, to) => {
            queenDistance(b, 1 << slot, dMe, s.queue);
            queenDistance(b, opponentMask(b, slot), dOp, s.queue);
            const cells: number[] = [];
            b.rays(to, cells, 0);
            return cells
              .map((c) => ({ c, v: arrowValue(b, slot, c, dMe, dOp) }))
              .sort((x, y) => y.v - x.v)
              .slice(0, 10)
              .map((x) => x.c);
          },
          simulate: (b, root, toMove, rnd) => {
            const iso = isolatedPieces(b, rs);
            const undo: Array<{ slot: number; a: number; k: number }> = [];
            const mask = b.aliveMask;
            let slot = toMove;
            for (let ply = 0; ply < horizon && b.aliveCount() > 1; ply++) {
              const a = libertyMove(b, slot, rnd, iso);
              if (a < 0) {
                if (slot === root) break;
                b.aliveMask &= ~(1 << slot);
                slot = b.nextAlive(slot);
                continue;
              }
              undo.push({ slot, a, k: b.make(slot, a) });
              slot = b.nextAlive(slot);
              playoutPlies++;
            }
            const v = b.aliveCount() <= 1 ? (b.isAlive(root) ? 1 : 0) : value(b, root);
            for (let i = undo.length - 1; i >= 0; i--) b.unmake(undo[i]!.slot, undo[i]!.a, undo[i]!.k);
            b.aliveMask = mask;
            return v;
          },
        },
        C_UCT,
        prng(fb.hashLo ^ 0xca3b7a ^ (me * 0x27d4eb2d)),
      );
      const res = mcts.run(me, clock);
      const elapsed = Math.max(1, input.budgetMs - Math.max(0, clock.remaining()));
      return {
        action: res.action,
        reasoning:
          `Split-action UCT with liberty-rule playouts (horizon ${horizon} plies, ${rootIsolated.size} isolated totem(s) pruned): ` +
          `${actionName(fb, res.action)} scored ${(res.value * 100).toFixed(0)}% accessibility-weighted. ` +
          statLine([
            ['', `${res.simulations.toLocaleString('en-US')} playouts`],
            ['Depth', res.maxDepth],
            ['Win', `${(res.value * 100).toFixed(1)}%`],
            ['', `${Math.round((res.simulations * 1000) / elapsed).toLocaleString('en-US')} playouts/s`],
            ['', `avg ${(playoutPlies / Math.max(1, res.simulations)).toFixed(1)} plies`],
          ]),
      };
    },
  };
}

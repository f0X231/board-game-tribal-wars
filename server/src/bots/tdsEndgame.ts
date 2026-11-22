/**
 * research:tds-endgame
 * After J. Kloetzer, H. Iida & B. Bouzy (2009), "Playing Amazons Endgames".
 *
 * Subgame decomposition: the board is split into independent subgames
 * (8-connected empty regions with the totems bordering them).
 *
 * Temperature discovery (Hotstrat): for every contested subgame we estimate
 *   LeftStop  = best local score when WE move first in it,
 *   RightStop = best local score when an OPPONENT moves first in it,
 * with a shallow local minimax over the most promising local moves; the
 * subgame temperature (urgency) is (LeftStop − RightStop) / 2. The hottest
 * contested subgame is played first — cold or decided subgames can wait.
 *
 * Search inside the hottest subgame: UCT Monte-Carlo tree search (Move Groups,
 * shallow random playouts + territory evaluation) for ~60% of the budget, then
 * a deep local alpha-beta verifies the most visited candidates with the rest.
 * Before the board splits there is one subgame (the whole board); once every
 * subgame is single-tribe, a single-agent filling search finishes the game.
 */
import { AlphaBeta, MoveGroupMcts, shallowRollout } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  type Region,
  Scratch,
  actionName,
  arrowValue,
  bestFillAction,
  cellName,
  eliminationTerm,
  features,
  opponentMask,
  popcount,
  prng,
  queenDistance,
  regions,
  signed,
  statLine,
  twoStage,
} from './evalUtils.js';

/** Local score of a region (root perspective): Σ sign(D_opp − D_me) over its still-empty squares. */
function localScore(fb: FastBoard, me: number, cells: ReadonlyArray<number>, s: Scratch): number {
  queenDistance(fb, 1 << me, s.q1me, s.queue);
  queenDistance(fb, opponentMask(fb, me), s.q1op, s.queue);
  let v = 0;
  for (const c of cells) {
    if (fb.cells[c] !== 0) continue;
    const a = s.q1me[c]!;
    const b = s.q1op[c]!;
    if (a < b) v++;
    else if (b < a) v--;
  }
  return v;
}

interface SubgameTemp {
  region: Region;
  left: number;
  right: number;
  temperature: number;
}

/** Hotstrat temperatures of the contested subgames that involve `me`. */
function temperatures(fb: FastBoard, me: number, rs: ReadonlyArray<Region>, comp: Int16Array, s: Scratch): SubgameTemp[] {
  const out: SubgameTemp[] = [];
  for (const r of rs) {
    if (popcount(r.tribes) < 2 || !(r.tribes & (1 << me))) continue;
    const id = r.id;
    const localMoves = (slot: number) =>
      twoStage(
        fb,
        slot,
        {
          filter: (_f, to) => comp[to] === id,
          moveScore: (b, sl) => localScore(b, sl, r.cells, s),
          arrowScore: (_b, _sl, _to, sh) => (comp[sh] === id ? 1 : 0),
          moveKeep: 6,
          arrowsPerMove: 3,
          keep: 6,
        },
        null,
      );
    let left = -Infinity;
    for (const a of localMoves(me)) {
      const k = fb.make(me, a);
      left = Math.max(left, localScore(fb, me, r.cells, s));
      fb.unmake(me, a, k);
    }
    let right = Infinity;
    for (const o of fb.opponents(me)) {
      if (!(r.tribes & (1 << o))) continue;
      for (const a of localMoves(o)) {
        const k = fb.make(o, a);
        right = Math.min(right, localScore(fb, me, r.cells, s));
        fb.unmake(o, a, k);
      }
    }
    const base = localScore(fb, me, r.cells, s);
    if (left === -Infinity) left = base;
    if (right === Infinity) right = base;
    out.push({ region: r, left, right, temperature: (left - right) / 2 });
  }
  return out.sort((a, b) => b.temperature - a.temperature || b.region.cells.length - a.region.cells.length);
}

export function createTdsEndgame(): ResearchBot {
  return {
    id: 'research:tds-endgame',
    label: 'TDS Hotstrat Endgame',
    paper: 'Kloetzer, Iida & Bouzy 2009',
    description: 'Subgame decomposition + temperature discovery ((LeftStop − RightStop)/2), UCT in the hottest subgame verified by local alpha-beta.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(
        input,
        (fb, p) => {
          const f = features(fb, p, s, 0, false);
          // Hot squares first: territory plus contested influence (where temperature will be highest).
          return f.t1 + 0.3 * f.c1 + 0.5 * f.contested;
        },
        'Hotstrat draft: claim territory where the contest (temperature) will be hottest.',
      );
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const rs = regions(fb, s);
      const comp = s.comp.slice();
      const ts = new Scratch(fb.size);
      const temps = temperatures(fb, me, rs, comp, ts);
      if (temps.length === 0) {
        const fill = bestFillAction(fb, me, clock);
        return {
          action: fill.action,
          reasoning:
            `All our subgames are cold (no contest): single-agent filling, ${actionName(fb, fill.action)}. ` +
            statLine([['Fill', `${fill.turns} turns${fill.proven ? ' (optimal)' : ''}`], ['nodes', fill.nodes], ['', `${rs.length} subgames`]]),
        };
      }
      const hot = temps[0]!;
      const hotId = hot.region.id;

      const es = new Scratch(fb.size);
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      const value01 = (b: FastBoard, root: number, toMove: number): number => {
        if (!b.hasAction(root)) return 0;
        const f = features(b, root, es, toMove === root ? 0.2 : -0.2, false);
        let v = (f.t1 + 0.05 * (f.mobMe - f.mobOpp)) / (0.12 * Math.max(1, f.live) + 2);
        for (const o of b.order) if (o !== root && b.isAlive(o) && !b.hasAction(o)) v += 0.5;
        return 1 / (1 + Math.exp(-v));
      };
      const mcts = new MoveGroupMcts(
        fb,
        {
          evaluate: value01,
          movePairs: (b, slot, isRoot) => {
            const scored = b.movePairs(slot).map((p) => {
              const to = (p >>> 8) & 0xff;
              return { p, v: b.reach(to) };
            });
            scored.sort((x, y) => y.v - x.v);
            return scored.slice(0, isRoot ? 64 : 20).map((x) => x.p);
          },
          arrows: (b, slot, _from, to) => {
            queenDistance(b, 1 << slot, dMe, es.queue);
            queenDistance(b, opponentMask(b, slot), dOp, es.queue);
            const cells: number[] = [];
            b.rays(to, cells, 0);
            return cells
              .map((c) => ({ c, v: arrowValue(b, slot, c, dMe, dOp) }))
              .sort((x, y) => y.v - x.v)
              .slice(0, 8)
              .map((x) => x.c);
          },
          simulate: (b, root, toMove, r) => shallowRollout(b, root, toMove, 6, r, value01),
        },
        Math.sqrt(2) / 2,
        prng(fb.hashHi ^ (me * 0x85ebca6b)),
      );
      // Hotstrat: the root only considers moves into the hottest subgame.
      const mres = mcts.run(me, clock.slice(0.6), (pair) => comp[(pair >>> 8) & 0xff] === hotId);

      // Local alpha-beta verification of the most visited candidates.
      let action = mres.action;
      let verified = '';
      const candidates = mres.top.map((t) => t[0]).filter((a) => a >= 0);
      if (candidates.length > 1 && !clock.expired()) {
        const ab = new AlphaBeta(
          fb,
          {
            evaluate: (b, rt, toMove) => {
              const f = features(b, rt, es, toMove === rt ? 0.2 : -0.2, false);
              return f.t1 + 0.05 * (f.mobMe - f.mobOpp) + eliminationTerm(b, rt, 20);
            },
            candidates: (b, slot) =>
              twoStage(
                b,
                slot,
                {
                  moveScore: (bb, sl) => features(bb, sl, ts, 0, false).t1,
                  prepareArrows: (bb, sl) => {
                    queenDistance(bb, 1 << sl, dMe, ts.queue);
                    queenDistance(bb, opponentMask(bb, sl), dOp, ts.queue);
                  },
                  arrowScore: (bb, sl, _to, sh) => arrowValue(bb, sl, sh, dMe, dOp),
                  moveKeep: 8,
                  arrowsPerMove: 3,
                  keep: 10,
                },
                clock,
              ),
            rootCandidates: () => candidates,
          },
          { maxDepth: 32, tt: true, aspiration: null, pvs: true, killers: true, epsilon: 0.01 },
        );
        const r = ab.run(me, clock);
        if (r.depth >= 2 && r.action >= 0) {
          action = r.action;
          verified = ` α-β verified ${candidates.length} candidates to depth ${r.depth} (score ${signed(r.score)}).`;
        }
      }
      const cold = temps.length - 1;
      return {
        action,
        reasoning:
          `Hotstrat: hottest subgame ${cellName(fb, hot.region.cells[0]!)}… (${hot.region.cells.length} sq, ` +
          `temperature ${hot.temperature.toFixed(1)} = (L ${hot.left} − R ${hot.right})/2${cold ? `; ${cold} cooler contested subgame(s)` : ''}) → ` +
          `${actionName(fb, action)}.${verified} ` +
          statLine([
            ['', `${mres.simulations.toLocaleString('en-US')} rollouts`],
            ['Depth', mres.maxDepth],
            ['Win', `${(mres.value * 100).toFixed(1)}%`],
            ['', `${rs.length} subgames`],
          ]),
      };
    },
  };
}

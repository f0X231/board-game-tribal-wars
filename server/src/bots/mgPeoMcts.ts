/**
 * research:mg-peo-mcts
 * After Zhang et al. (2024), "An Efficient Optimization of the MCTS Algorithm for Amazons".
 *
 * Tree — Move Groups (MG): one turn is split into two tree layers,
 * Layer 1 = totem movement (from → to), Layer 2 = arrow shot. UCT selection with
 * C = sqrt(0.5). Simulation = 2-pass shallow rollouts: play 4 random turns and
 * evaluate, play a 5th and evaluate again, back up the mean (cancels the
 * side-to-move parity bias of a single cut-off depth).
 *
 * Phased Situation Evaluation (Table 1 of the paper):
 *   Value = k1·t1 + k2·t2 + k3·p1 + k4·p2 + k5·mobility
 *   t1/t2  = Queen / King territory, p1 = 2·Σ(2^-D1me − 2^-D1opp),
 *   p2 = Σ clamp((D2opp − D2me)/6, −1, 1),
 *   weights Opening (0.14, 0.37, 0.13, 0.13, 0.20) → Middle (0.30, 0.25, 0.20,
 *   0.20, 0.05) → Ending (0.80, 0.10, 0.05, 0.05, 0.00), interpolated by game
 *   progress. Each feature is normalised by the live squares so the weighted sum
 *   is in [−1, 1], then mapped to a win probability with a logistic.
 *
 * Tribal Wars adaptation: progress is the share of free squares burned (two
 * squares burn per turn), paranoid values for 3-4 tribes.
 */
import { MoveGroupMcts } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  Scratch,
  actionName,
  arrowValue,
  features,
  opponentMask,
  prng,
  progress,
  queenDistance,
  randomAction,
  statLine,
} from './evalUtils.js';

type Weights = readonly [number, number, number, number, number];
const OPENING: Weights = [0.14, 0.37, 0.13, 0.13, 0.2];
const MIDDLE: Weights = [0.3, 0.25, 0.2, 0.2, 0.05];
const ENDING: Weights = [0.8, 0.1, 0.05, 0.05, 0.0];
const C_UCT = Math.sqrt(0.5);

function lerp(a: Weights, b: Weights, t: number): Weights {
  const f = (i: 0 | 1 | 2 | 3 | 4) => a[i] + (b[i] - a[i]) * t;
  return [f(0), f(1), f(2), f(3), f(4)];
}

/** Phase weights from progress p in [0, 1]: opening < 0.2, middle ~0.45, ending > 0.7. */
export function phaseWeights(p: number): { w: Weights; phase: 'Opening' | 'Middle' | 'Ending' } {
  if (p < 0.2) return { w: OPENING, phase: 'Opening' };
  if (p < 0.45) return { w: lerp(OPENING, MIDDLE, (p - 0.2) / 0.25), phase: 'Middle' };
  if (p < 0.7) return { w: lerp(MIDDLE, ENDING, (p - 0.45) / 0.25), phase: 'Middle' };
  return { w: ENDING, phase: 'Ending' };
}

/** Raw phased value (Table 1), normalised to about [−1, 1]. */
export function phasedValue(fb: FastBoard, me: number, toMove: number, s: Scratch, w: Weights): number {
  const tie = toMove === me ? 0.2 : -0.2;
  const f = features(fb, me, s, tie, true);
  const L = Math.max(1, f.live);
  const mob = (f.mobMe - f.mobOpp) / (f.mobMe + f.mobOpp + 1);
  return w[0] * (f.t1 / L) + w[1] * (f.t2 / L) + w[2] * (f.c1 / L) + w[3] * (f.c2 / L) + w[4] * mob - 0.15 * f.trappedMe + 0.1 * f.trappedOpp;
}

export function createMgPeoMcts(): ResearchBot {
  return {
    id: 'research:mg-peo-mcts',
    label: 'MG-PEO MCTS',
    paper: 'Zhang et al. 2024',
    description: 'UCT with Move Groups (movement → arrow layers), 2-pass shallow rollouts (depth 4 & 5), phased Table-1 evaluation.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(input, (fb, p) => phasedValue(fb, p, p, s, OPENING) * 100, 'Phased evaluation (opening weights 0.14/0.37/0.13/0.13/0.20): king-territory heavy draft.');
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const { w, phase } = phaseWeights(progress(fb));
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      const value = (b: FastBoard, root: number, toMove: number): number => {
        if (!b.hasAction(root)) return 0;
        let v = phasedValue(b, root, toMove, s, w);
        for (const o of b.order) if (o !== root && b.isAlive(o) && !b.hasAction(o)) v += 0.15;
        return 1 / (1 + Math.exp(-6 * v));
      };
      const rnd = prng(fb.hashLo ^ (me * 0x9e3779b1));
      const mcts = new MoveGroupMcts(
        fb,
        {
          evaluate: value,
          movePairs: (b, slot, isRoot) => {
            const pairs = b.movePairs(slot);
            // Prior: destination mobility (cheap), best first; widen at the root.
            const scored = pairs.map((p) => {
              const to = (p >>> 8) & 0xff;
              return { p, v: b.reach(to) - 0.5 * b.g.centre[to]! };
            });
            scored.sort((x, y) => y.v - x.v);
            return scored.slice(0, isRoot ? 72 : 24).map((x) => x.p);
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
          simulate: (b, root, toMove, r) => twoPassRollout(b, root, toMove, r, value),
        },
        C_UCT,
        rnd,
      );
      const res = mcts.run(me, clock);
      const elapsed = Math.max(1, input.budgetMs - Math.max(0, clock.remaining()));
      return {
        action: res.action,
        reasoning:
          `Move-Group MCTS (${phase} weights ${w.map((x) => x.toFixed(2)).join('/')}): ${actionName(fb, res.action)} ` +
          `won ${(res.value * 100).toFixed(0)}% of its simulations. ` +
          statLine([
            ['', `${res.simulations.toLocaleString('en-US')} rollouts`],
            ['Depth', res.maxDepth],
            ['Win', `${(res.value * 100).toFixed(1)}%`],
            ['', `${Math.round((res.simulations * 1000) / elapsed).toLocaleString('en-US')} sims/s`],
            ['', `${res.width} move groups`],
          ]),
      };
    },
  };
}

/** 2-pass shallow rollout: random turns to depth 4 (evaluate) and 5 (evaluate), mean of both. */
function twoPassRollout(
  fb: FastBoard,
  root: number,
  toMove: number,
  rnd: () => number,
  value: (fb: FastBoard, root: number, toMove: number) => number,
): number {
  const undo: Array<{ slot: number; a: number; k: number }> = [];
  const mask = fb.aliveMask;
  let slot = toMove;
  let v4 = -1;
  for (let ply = 0; ply < 5; ply++) {
    if (ply === 4) v4 = value(fb, root, slot);
    if (fb.aliveCount() <= 1) break;
    const a = randomAction(fb, slot, rnd);
    if (a < 0) {
      if (slot === root) break;
      fb.aliveMask &= ~(1 << slot);
      slot = fb.nextAlive(slot);
      continue;
    }
    undo.push({ slot, a, k: fb.make(slot, a) });
    slot = fb.nextAlive(slot);
  }
  const v5 = value(fb, root, slot);
  for (let i = undo.length - 1; i >= 0; i--) fb.unmake(undo[i]!.slot, undo[i]!.a, undo[i]!.k);
  fb.aliveMask = mask;
  return v4 < 0 ? v5 : (v4 + v5) / 2;
}

/**
 * research:arrow-lsg
 * After M. Müller & T. Tegos (2002), "Experiments in Computer Amazons" (program ARROW).
 *
 * Layered forward pruning:
 *  stage 1 — every totem movement is scored with the ultra-fast min-distance
 *            evaluation and only the top 50% of destinations survive;
 *  stage 2 — arrows of the survivors are ranked, and the best candidates get
 *            the full evaluation before the final top-K cut.
 * Fast min-distance: two typed-array Queen BFS passes; a square belongs to the
 * side with the smaller distance (`db < dw`).
 *
 * Endgame awareness: once regions separate, exclusive regions are valued by
 * fillable squares — dead-end squares (defect count) are subtracted — and a
 * zugzwang/tempo term (equal turns → the side to move runs out first) plus
 * corridor articulation points in contested areas are counted.
 *
 * Search: iterative-deepening NegaScout (principal-variation search with null
 * windows) + transposition table + killer moves, paranoid for 3-4 tribes.
 */
import { AlphaBeta } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  Scratch,
  actionName,
  arrowValue,
  eliminationTerm,
  opponentMask,
  popcount,
  progress,
  queenDistance,
  regions,
  signed,
  statLine,
  twoStage,
} from './evalUtils.js';

/** Min-distance territory (cells): Σ sign(D_opp − D_me). */
export function minDistance(fb: FastBoard, me: number, s: Scratch): number {
  queenDistance(fb, 1 << me, s.q1me, s.queue);
  queenDistance(fb, opponentMask(fb, me), s.q1op, s.queue);
  let v = 0;
  for (let i = 0; i < fb.size; i++) {
    if (fb.cells[i] !== 0) continue;
    const a = s.q1me[i]!;
    const b = s.q1op[i]!;
    if (a < b) v++;
    else if (b < a) v--;
  }
  return v;
}

/** Full Arrow evaluation (root perspective, in turns). */
function arrowEval(fb: FastBoard, me: number, toMove: number, s: Scratch): number {
  const md = minDistance(fb, me, s);
  const p = progress(fb);
  if (p < 0.45) return md / 2 + mobilityTerm(fb, me);
  // Endgame: defect-aware territory, articulation corridors, tempo.
  const opps = fb.opponents(me);
  let own = 0;
  let theirs = 0;
  let contestedMine = 0;
  let contestedTheirs = 0;
  let artic = 0;
  let anyActive = false;
  for (const r of regions(fb, s)) {
    const k = popcount(r.tribes);
    if (k === 1) {
      const fill = Math.max(0, r.cells.length - r.deadEnds) / 2;
      if (r.tribes === 1 << me) own += fill;
      else theirs += fill;
    } else if (k >= 2) {
      anyActive = true;
      for (const c of r.cells) {
        const a = s.q1me[c]!;
        const b = s.q1op[c]!;
        if (a < b) contestedMine++;
        else if (b < a) contestedTheirs++;
        if (isCorridorArticulation(fb, c)) artic += a < b ? 1 : b < a ? -1 : 0;
      }
    }
  }
  theirs /= Math.max(1, opps.length);
  const tempo = anyActive ? 0 : toMove === me ? -0.5 : 0.5;
  return own - theirs + (contestedMine - contestedTheirs) / 2 + 0.25 * artic + tempo + 0.5 * mobilityTerm(fb, me);
}

function mobilityTerm(fb: FastBoard, me: number): number {
  let m = 0;
  const mine = fb.pieces[me]!;
  for (let p = 0; p < mine.length; p++) m += Math.min(8, fb.reach(mine[p]!));
  let o = 0;
  const opps = fb.opponents(me);
  for (const s of opps) {
    const list = fb.pieces[s]!;
    for (let p = 0; p < list.length; p++) o += Math.min(8, fb.reach(list[p]!));
  }
  return 0.05 * (m - o / Math.max(1, opps.length));
}

/** Corridor articulation: exactly two empty neighbours that are not adjacent to each other. */
function isCorridorArticulation(fb: FastBoard, c: number): boolean {
  const ray = fb.g.ray;
  let a = -1;
  let b = -1;
  for (let d = 0; d < 8; d++) {
    const v = ray[c * 8 + d]!;
    if (v >= 0 && fb.cells[v] === 0) {
      if (a < 0) a = v;
      else if (b < 0) b = v;
      else return false;
    }
  }
  if (a < 0 || b < 0) return false;
  return Math.max(Math.abs(fb.g.row[a]! - fb.g.row[b]!), Math.abs(fb.g.col[a]! - fb.g.col[b]!)) > 1;
}

export function createArrowLsg(): ResearchBot {
  return {
    id: 'research:arrow-lsg',
    label: 'ARROW Layered Search',
    paper: 'Müller & Tegos 2002',
    description: '2-stage layered forward pruning (top 50% by fast min-distance, then full eval), NegaScout + TT, endgame defect/zugzwang awareness.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(input, (fb, p) => minDistance(fb, p, s) + 0.1 * mobilityTerm(fb, p) * 20, 'Min-distance draft (db < dw), top 50% squares re-checked against the next drafter.', 0.5);
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const ms = new Scratch(fb.size);
      const fs = new Scratch(fb.size);
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      let fullEvals = 0;
      const gen = (fraction: number, keep: number) => (b: FastBoard, slot: number) => {
        const pre = twoStage(
          b,
          slot,
          {
            moveScore: (bb, sl) => minDistance(bb, sl, ms),
            prepareArrows: (bb, sl) => {
              queenDistance(bb, 1 << sl, dMe, ms.queue);
              queenDistance(bb, opponentMask(bb, sl), dOp, ms.queue);
            },
            arrowScore: (bb, sl, _to, sh) => arrowValue(bb, sl, sh, dMe, dOp),
            moveKeep: fraction,
            arrowsPerMove: 3,
            keep: keep * 2,
          },
          clock,
        );
        // Layer 2: full evaluation of the surviving candidates.
        const next = b.nextAlive(slot);
        const scored = pre.map((a) => {
          const k = b.make(slot, a);
          const v = arrowEval(b, slot, next, fs);
          b.unmake(slot, a, k);
          fullEvals++;
          return { a, v };
        });
        scored.sort((x, y) => y.v - x.v);
        return scored.slice(0, keep).map((x) => x.a);
      };
      const root = gen(0.5, 20);
      const ply1 = gen(0.5, 12);
      const deep = gen(0.3, 10);
      const ab = new AlphaBeta(
        fb,
        {
          evaluate: (b, rt, toMove) => arrowEval(b, rt, toMove, s) + eliminationTerm(b, rt, 15),
          candidates: (b, slot, ply) => (ply <= 1 ? ply1(b, slot) : deep(b, slot)),
          rootCandidates: (b, slot) => root(b, slot),
        },
        { maxDepth: 32, tt: true, aspiration: null, pvs: true, killers: true, epsilon: 0.01 },
      );
      const r = ab.run(me, clock);
      return {
        action: r.action,
        reasoning:
          `Layered-pruning NegaScout (50% min-distance cut → full eval): ${actionName(fb, r.action)}. ` +
          statLine([['Depth', r.depth], ['', `${r.nodes.toLocaleString('en-US')} nodes`], ['Score', `${signed(r.score)} turns`], ['full evals', fullEvals], ['TT hits', r.ttHits]]),
      };
    },
  };
}


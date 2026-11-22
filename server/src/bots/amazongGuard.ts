/**
 * research:amazong-guard
 * After J. Lieberum (2005), "An Evaluation Function for the Game of Amazons" (AMAZONG).
 *
 * Evaluation  E = t + m + g − s
 *  t — territory & position, weighted by board openness
 *      w = Σ 2^-|D1me − D1opp| (squares both sides reach):
 *        t = f1(w)·t1 + f2(w)·c1 + f3(w)·c2 + f4(w)·t2
 *      with c1 = 2·Σ(2^-D1me − 2^-D1opp), c2 = Σ clamp((D2opp − D2me)/6, −1, 1).
 *      Open boards weight the positional terms c1/c2/t2; as w shrinks the queen
 *      territory t1 takes over (Lieberum's f_i, linearised in ρ = w / live squares).
 *  m — Individual Amazon Enclosure: for each totem A,
 *        α_A = Σ_{b one queen move from A} 2^-d2(A,b) · N(b)
 *      (d2 = king distance along the line, N(b) = empty neighbours of b).
 *      A non-linear penalty for α_A = 0 (trapped) and α_A ≤ 5 (nearly enclosed)
 *      — positive for enemy totems, negative for ours — so rival totems get
 *      trapped early.
 *  g — n-Guard correction: a totem guarding an exclusive territory of n squares
 *      keeps it only by staying; its credit is g_A = min(n, n_A / 2), where n_A
 *      is the totem's own reach.
 *  s — Filling Defect Avoidance (endgame weight): dead-end squares inside our
 *      territories cannot all be filled.
 *
 * Search: iterative-deepening alpha-beta with aspiration windows, a
 * transposition table, killer moves and evaluation-ordered selective candidates.
 */
import { AlphaBeta } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  POW2NEG,
  Scratch,
  actionName,
  arrowValue,
  eliminationTerm,
  features,
  opponentMask,
  popcount,
  queenDistance,
  regions,
  signed,
  statLine,
  twoStage,
} from './evalUtils.js';

/** α_A for the totem at `cell` (Lieberum's enclosure measure). */
export function enclosureAlpha(fb: FastBoard, cell: number): number {
  const ray = fb.g.ray;
  let alpha = 0;
  for (let d = 0; d < 8; d++) {
    let v = ray[cell * 8 + d]!;
    let dist = 1;
    while (v >= 0 && fb.cells[v] === 0) {
      alpha += POW2NEG[dist]! * fb.emptyNeighbours(v);
      v = ray[v * 8 + d]!;
      dist++;
    }
  }
  return alpha;
}

/** Non-linear enclosure penalty. */
function enclosurePenalty(alpha: number): number {
  if (alpha === 0) return 30;
  if (alpha <= 5) return 6 + (5 - alpha) * 3;
  return 12 / (alpha + 1);
}

interface AmazongTerms {
  value: number;
  rho: number;
  enclosure: number;
}

export function amazongEval(fb: FastBoard, me: number, toMove: number, s: Scratch, withRegions: boolean): AmazongTerms {
  const tie = toMove === me ? 0.15 : -0.15;
  const f = features(fb, me, s, tie, true);
  const rho = f.live > 0 ? Math.min(1, f.w / f.live) : 0;
  const t = (0.4 + 0.6 * (1 - rho)) * f.t1 + 0.6 * rho * f.c1 + 0.4 * rho * f.c2 + 0.3 * rho * f.t2;

  // m: enclosure of individual totems.
  let mMe = 0;
  const mine = fb.pieces[me]!;
  for (let p = 0; p < mine.length; p++) mMe += enclosurePenalty(enclosureAlpha(fb, mine[p]!));
  let mOpp = 0;
  const opps = fb.opponents(me);
  for (const o of opps) {
    const list = fb.pieces[o]!;
    for (let p = 0; p < list.length; p++) mOpp += enclosurePenalty(enclosureAlpha(fb, list[p]!));
  }
  if (opps.length > 0) mOpp /= opps.length;
  const phaseW = 0.4 + 0.6 * rho; // enclosure matters most while the board is open
  const m = phaseW * (mOpp - mMe);

  let g = 0;
  let sDef = 0;
  if (withRegions) {
    for (const r of regions(fb, s)) {
      if (popcount(r.tribes) !== 1) continue;
      const owner = Math.log2(r.tribes);
      const sign = owner === me ? 1 : -1 / Math.max(1, opps.length);
      const n = r.cells.length;
      for (const p of r.pieces) g += sign * Math.min(n, fb.reach(p.cell) / 2);
      sDef += sign * r.deadEnds;
    }
  }
  const value = t + m + 0.1 * g - 0.5 * (1 - rho) * sDef;
  return { value, rho, enclosure: mOpp - mMe };
}

export function createAmazongGuard(): ResearchBot {
  return {
    id: 'research:amazong-guard',
    label: 'AMAZONG Guard Eval',
    paper: 'Lieberum 2005',
    description: 'Evaluation t + m + g − s: openness-weighted territory, individual enclosure α_A, n-guard and filling defects; aspiration alpha-beta.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(input, (fb, p) => amazongEval(fb, p, p, s, false).value, 'AMAZONG draft: open positional squares that crowd rival totems (lower their α).');
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock } = input;
      const s = new Scratch(fb.size);
      const ms = new Scratch(fb.size);
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      const gen = (moveKeep: number, keep: number) => (b: FastBoard, slot: number) =>
        twoStage(
          b,
          slot,
          {
            moveScore: (bb, sl) => {
              const f = features(bb, sl, ms, 0, false);
              return f.t1 + 0.3 * f.c1 - 2 * f.trappedMe + 2 * f.trappedOpp;
            },
            prepareArrows: (bb, sl) => {
              queenDistance(bb, 1 << sl, dMe, ms.queue);
              queenDistance(bb, opponentMask(bb, sl), dOp, ms.queue);
            },
            arrowScore: (bb, sl, _to, sh) => arrowValue(bb, sl, sh, dMe, dOp) * 1.5,
            moveKeep,
            arrowsPerMove: 5,
            keep,
          },
          clock,
        );
      const root = gen(12, 18);
      const inner = gen(8, 12);
      const ab = new AlphaBeta(
        fb,
        {
          evaluate: (b, rt, toMove) => amazongEval(b, rt, toMove, s, true).value + eliminationTerm(b, rt, 30),
          candidates: (b, slot) => inner(b, slot),
          rootCandidates: (b, slot) => root(b, slot),
        },
        { maxDepth: 32, tt: true, aspiration: 4, pvs: false, killers: true, epsilon: 0.01 },
      );
      const r = ab.run(me, clock);
      const k = fb.make(me, r.action);
      const after = amazongEval(fb, me, fb.nextAlive(me), s, false);
      fb.unmake(me, r.action, k);
      return {
        action: r.action,
        reasoning:
          `AMAZONG t+m+g−s α-β with aspiration windows: ${actionName(fb, r.action)} ` +
          `(openness ρ=${after.rho.toFixed(2)}, enclosure balance ${signed(after.enclosure)}). ` +
          statLine([['Depth', r.depth], ['', `${r.nodes.toLocaleString('en-US')} nodes`], ['Score', signed(r.score)], ['re-searches', r.researches], ['TT hits', r.ttHits]]),
      };
    },
  };
}

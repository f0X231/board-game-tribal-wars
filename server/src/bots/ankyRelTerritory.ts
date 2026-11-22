/**
 * research:anky-rel-territory
 * After P. P. L. M. Hensgens (2001), "A Knowledge-based Approach of the Game of Amazons".
 *
 * Evaluation — Relative Territory: for every empty square, compare the Queen-move
 * distance of the nearest own totem with the nearest enemy totem
 * (`D_opp(sq) − D_me(sq)`, multi-source BFS). A square counts +1 when we are
 * strictly closer, −1 when they are; equal squares are "hot" — a 1-step
 * lookahead gives the side to move half of them. A clipped relative-distance
 * term grades margins, so both totem moves and fire-barricade arrows (which
 * change distances) are optimised.
 *
 * Search — iterative-deepening alpha-beta with Selective Search: actions are
 * sorted by relative territory and only the top K (16 at the root, 14 inside)
 * are expanded per ply. When every region belongs to a single tribe the areas
 * are independent and a single-agent endgame search fills our territory.
 *
 * Tribal Wars adaptation: a turn consumes two empty squares (destination +
 * arrow) and the vacated square becomes fire; paranoid search for 3-4 tribes.
 */
import { AlphaBeta } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  INF,
  Scratch,
  actionName,
  arrowValue,
  bestFillAction,
  eliminationTerm,
  features,
  isDecomposed,
  opponentMask,
  queenDistance,
  regions,
  signed,
  statLine,
  twoStage,
} from './evalUtils.js';

const K_ROOT = 16;
const K_INNER = 14;

function relativeTerritory(fb: FastBoard, me: number, toMove: number, s: Scratch): number {
  const f = features(fb, me, s, 0, false);
  let margin = 0;
  let hot = 0;
  for (let i = 0; i < fb.size; i++) {
    if (fb.cells[i] !== 0) continue;
    const a = s.q1me[i]!;
    const b = s.q1op[i]!;
    if (a === INF && b === INF) continue;
    const d = (b === INF ? 4 : b) - (a === INF ? 4 : a);
    margin += d > 3 ? 3 : d < -3 ? -3 : d;
    if (a !== INF && b !== INF && Math.abs(a - b) <= 1) hot++;
  }
  // 1-step lookahead on hot territory: the side to move claims about half of it first.
  const hotShare = (toMove === me ? 0.5 : -0.5) * (f.contested + 0.25 * (hot - f.contested));
  return f.t1 + hotShare + 0.15 * margin + 0.05 * (f.mobMe - f.mobOpp) - 1.5 * f.trappedMe + 1.0 * f.trappedOpp;
}

export function createAnkyRelTerritory(): ResearchBot {
  return {
    id: 'research:anky-rel-territory',
    label: 'ANKY Relative Territory',
    paper: 'Hensgens 2001',
    description: 'Relative-territory evaluation (Queen BFS) + iterative-deepening selective alpha-beta (top-K) + endgame single-agent search.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(
        input,
        (fb, p) => {
          const f = features(fb, p, s, 0, false);
          return f.t1 + 0.25 * f.c1 - 0.2 * centrePenalty(fb, p);
        },
        'Relative territory draft: claim the most squares we reach first, away from crowded lines.',
      );
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock, state } = input;
      const s = new Scratch(fb.size);
      const rs = regions(fb, s);
      if (isDecomposed(rs)) {
        const fill = bestFillAction(fb, me, clock);
        return {
          action: fill.action,
          reasoning:
            `Areas are independent: single-agent endgame search fills our territory, ${actionName(fb, fill.action)}. ` +
            statLine([['Fill', `${fill.turns} turns${fill.proven ? ' (optimal)' : ''}`], ['nodes', fill.nodes]]),
        };
      }
      const ms = new Scratch(fb.size);
      const dMe = new Uint8Array(fb.size);
      const dOp = new Uint8Array(fb.size);
      const gen = (keepMoves: number, keep: number) => (b: FastBoard, slot: number) =>
        twoStage(
          b,
          slot,
          {
            moveScore: (bb, sl) => {
              const f = features(bb, sl, ms, 0, false);
              return f.t1 + 0.05 * (f.mobMe - f.mobOpp);
            },
            prepareArrows: (bb, sl) => {
              queenDistance(bb, 1 << sl, dMe, ms.queue);
              queenDistance(bb, opponentMask(bb, sl), dOp, ms.queue);
            },
            arrowScore: (bb, sl, _to, sh) => arrowValue(bb, sl, sh, dMe, dOp),
            moveKeep: keepMoves,
            arrowsPerMove: 5,
            keep,
          },
          clock,
        );
      const root = gen(12, K_ROOT);
      const inner = gen(8, K_INNER);
      const ab = new AlphaBeta(
        fb,
        {
          evaluate: (b, rt, toMove) => relativeTerritory(b, rt, toMove, s) + eliminationTerm(b, rt, 25),
          candidates: (b, slot) => inner(b, slot),
          rootCandidates: (b, slot) => root(b, slot),
        },
        { maxDepth: 32, tt: true, aspiration: null, pvs: false, killers: true, epsilon: 0.01 },
      );
      const r = ab.run(me, clock);
      const elapsed = Math.max(1, input.budgetMs - Math.max(0, clock.remaining()));
      return {
        action: r.action,
        reasoning:
          `Relative territory α-β (selective top-${K_ROOT}/${K_INNER}): ${actionName(fb, r.action)} maximises squares we reach first. ` +
          statLine([
            ['Depth', r.depth],
            ['', `${r.nodes.toLocaleString('en-US')} nodes`],
            ['Score', signed(r.score)],
            ['', `${Math.round((r.nodes * 1000) / elapsed).toLocaleString('en-US')} n/s`],
          ]) +
          (state.players.length > 2 ? ' (paranoid search vs all tribes)' : ''),
      };
    },
  };
}

/** Small centre preference (distance of our totems from the centre). */
export function centrePenalty(fb: FastBoard, slot: number): number {
  let d = 0;
  const list = fb.pieces[slot]!;
  for (let p = 0; p < list.length; p++) d += fb.g.centre[list[p]!]!;
  return d;
}

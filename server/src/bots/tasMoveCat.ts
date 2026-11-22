/**
 * research:tas-move-cat
 * After Y. Higashiuchi & R. Grimbergen (2005), "Enhancing Search Efficiency by
 * Using Move Categorization Based on Game Progress in Amazons".
 *
 * Move categorization: EVERY legal action is classified by 10 tactical features
 *   1-4  opponent totems blocked by the move: 0 / 1 / 2 / 3+
 *   5-8  opponent totems blocked by the arrow: 0 / 1 / 2 / 3+
 *        ("blocked" = the square lies on one of the totem's open queen lines)
 *   9    move adjacent to an opponent totem      10  arrow adjacent to an opponent totem
 *   +    multiple-block threat (≥ 2 lines cut), rescue of a previously blocked
 *        own totem (reach ≤ 4 → more), blocking the opponent totem that just moved.
 * Categorisation is O(1) per action after one pass over the opponents' lines,
 * so the whole move list (thousands on 12x12) is ordered without evaluation.
 *
 * Progress-adjusted ordering: the category weights change with game progress
 * (fire ratio): blocking-by-arrow and rescue gain weight towards the endgame,
 * blocking the last-moved totem matters most in the opening. Only the best
 * categories are expanded (realisation-probability style), so iterative-
 * deepening alpha-beta with a transposition table and killers searches deeper.
 *
 * Evaluation: minimum-distance territory + mobility (as in the TAS program).
 */
import { AlphaBeta } from './search.js';
import { type BotMove, type BotTurnInput, type ResearchBot, runPlacement } from './common.js';
import {
  type FastBoard,
  Clock,
  Scratch,
  actionName,
  eliminationTerm,
  features,
  pack,
  progress,
  signed,
  statLine,
  toOf,
} from './evalUtils.js';

/** Stage-dependent category weights: [opening, middle, ending]. */
const W = {
  blockMove: [
    [0, 1.0, 2.2, 3.0],
    [0, 1.4, 2.8, 3.8],
    [0, 1.2, 2.4, 3.2],
  ],
  blockArrow: [
    [0, 1.1, 2.3, 3.1],
    [0, 1.5, 3.0, 4.0],
    [0, 1.8, 3.4, 4.5],
  ],
  moveAdj: [0.3, 0.8, 1.0],
  arrowAdj: [0.6, 1.2, 1.6],
  multi: [0.8, 1.0, 0.6],
  rescue: [1.0, 1.6, 2.2],
  blockLast: [1.2, 0.8, 0.4],
} as const;

const stageOf = (p: number): 0 | 1 | 2 => (p < 0.25 ? 0 : p < 0.55 ? 1 : 2);
export const STAGE_NAMES = ['opening', 'middle', 'ending'] as const;

export interface Categorized {
  action: number;
  score: number;
  bm: number;
  ba: number;
  adjMove: boolean;
  adjArrow: boolean;
  rescue: boolean;
  blockLast: boolean;
}

/** Categorises all legal actions of `slot` and returns them best-first (top `keep`). */
export function categorize(fb: FastBoard, slot: number, last: number, keep: number, clock: Clock | null): Categorized[] {
  const stage = stageOf(progress(fb));
  const size = fb.size;
  const cnt = new Uint8Array(size);
  const lastLines = new Uint8Array(size);
  const oppAdj = new Uint8Array(size);
  const ray = fb.g.ray;
  const buf: number[] = [];
  const lastCell = last >= 0 ? toOf(last) : -1;
  const lastIsOpp = lastCell >= 0 && fb.cells[lastCell]! >= 2 && fb.cells[lastCell]! - 2 !== slot;
  for (const o of fb.opponents(slot)) {
    const list = fb.pieces[o]!;
    for (let p = 0; p < list.length; p++) {
      const c = list[p]!;
      buf.length = 0;
      const n = fb.rays(c, buf, 0);
      for (let i = 0; i < n; i++) {
        cnt[buf[i]!]!++;
        if (lastIsOpp && c === lastCell) lastLines[buf[i]!] = 1;
      }
      for (let d = 0; d < 8; d++) {
        const v = ray[c * 8 + d]!;
        if (v >= 0) oppAdj[v] = 1;
      }
    }
  }
  const ownAdj = (cell: number, from: number) => {
    for (let d = 0; d < 8; d++) {
      const v = ray[cell * 8 + d]!;
      if (v >= 0 && v !== from && fb.cells[v] === slot + 2) return true;
    }
    return false;
  };
  const out: Categorized[] = [];
  const pairs = fb.movePairs(slot);
  const arrows: number[] = [];
  for (const pair of pairs) {
    const from = pair & 0xff;
    const to = (pair >>> 8) & 0xff;
    const reachBefore = fb.reach(from);
    const k = fb.move(slot, from, to);
    const reachTo = fb.reach(to);
    arrows.length = 0;
    const na = fb.rays(to, arrows, 0);
    const bm = Math.min(3, cnt[to]!);
    const rescue = reachBefore <= 4 && reachTo > reachBefore;
    for (let j = 0; j < na; j++) {
      const sh = arrows[j]!;
      const ba = Math.min(3, cnt[sh]!);
      const adjMove = oppAdj[to] === 1;
      const adjArrow = oppAdj[sh] === 1;
      const blockLast = lastLines[to] === 1 || lastLines[sh] === 1;
      let score = W.blockMove[stage][bm]! + W.blockArrow[stage][ba]!;
      if (adjMove) score += W.moveAdj[stage];
      if (adjArrow) score += W.arrowAdj[stage];
      if (cnt[to]! + cnt[sh]! >= 2 && bm > 0 && ba > 0) score += W.multi[stage];
      if (rescue) score += W.rescue[stage];
      if (blockLast) score += W.blockLast[stage];
      if (ownAdj(sh, to)) score -= 0.6; // self-blocking arrow
      score += 0.03 * reachTo;
      out.push({ action: pack(from, to, sh), score, bm, ba, adjMove, adjArrow, rescue, blockLast });
    }
    fb.unmove(slot, from, to, k);
    clock?.tick();
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, keep);
}

export function describeCategory(c: Categorized): string {
  const parts: string[] = [];
  if (c.bm) parts.push(`move blocks ${c.bm}${c.bm === 3 ? '+' : ''}`);
  if (c.ba) parts.push(`arrow blocks ${c.ba}${c.ba === 3 ? '+' : ''}`);
  if (c.adjMove) parts.push('move adjacent');
  if (c.adjArrow) parts.push('arrow adjacent');
  if (c.rescue) parts.push('rescue');
  if (c.blockLast) parts.push('blocks last mover');
  return parts.length ? parts.join(', ') : 'quiet move';
}

export function createTasMoveCat(): ResearchBot {
  return {
    id: 'research:tas-move-cat',
    label: 'TAS Move Categorization',
    paper: 'Higashiuchi & Grimbergen 2005',
    description: '10-feature move categorization with progress-adjusted ordering; iterative-deepening alpha-beta + transposition table.',

    place(input) {
      const s = new Scratch(input.fb.size);
      return runPlacement(
        input,
        (fb, p) => {
          const f = features(fb, p, s, 0, false);
          return f.mobMe - 1.5 * f.mobOpp + 0.5 * f.t1;
        },
        'Categorization draft: squares whose lines cut the most rival lines while staying mobile.',
      );
    },

    play(input: BotTurnInput): BotMove {
      const { fb, me, clock, state } = input;
      const s = new Scratch(fb.size);
      const la = state.lastAction;
      const rootLast = la ? pack(la.from.row * fb.n + la.from.col, la.to.row * fb.n + la.to.col, la.shoot.row * fb.n + la.shoot.col) : -1;
      const ab = new AlphaBeta(
        fb,
        {
          evaluate: (b, rt, toMove) => {
            const f = features(b, rt, s, toMove === rt ? 0.2 : -0.2, false);
            return f.t1 + 0.12 * (f.mobMe - f.mobOpp) - 2 * f.trappedMe + 1.5 * f.trappedOpp + eliminationTerm(b, rt, 25);
          },
          candidates: (b, slot, _ply, ck, last) => categorize(b, slot, last, 14, ck).map((c) => c.action),
          rootCandidates: (b, slot, ck, last) => categorize(b, slot, last, 24, ck).map((c) => c.action),
        },
        { maxDepth: 32, tt: true, aspiration: null, pvs: false, killers: true, epsilon: 0.01 },
      );
      const r = ab.run(me, clock, rootLast);
      const chosen = categorize(fb, me, rootLast, Infinity, null).find((c) => c.action === r.action);
      const stage = STAGE_NAMES[stageOf(progress(fb))];
      return {
        action: r.action,
        reasoning:
          `Move categorization (${stage} weights) + α-β/TT: ${actionName(fb, r.action)} — ${chosen ? describeCategory(chosen) : 'searched move'}. ` +
          statLine([['Depth', r.depth], ['', `${r.nodes.toLocaleString('en-US')} nodes`], ['Score', signed(r.score)], ['TT hits', r.ttHits]]),
      };
    },
  };
}


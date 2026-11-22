/**
 * Research-bot contract and shared snake-draft placement search.
 */
import type { GameState, PlayerId } from '../../../shared/gameEngine.js';
import { Clock, EMPTY, FastBoard, TIMEOUT, cellName, signed, slotOf, statLine } from './evalUtils.js';

export interface BotTurnInput {
  readonly state: GameState;
  readonly fb: FastBoard;
  /** Slot (0..3) of the tribe to move. */
  readonly me: number;
  readonly clock: Clock;
  readonly budgetMs: number;
}

export interface BotPlacement {
  cell: number;
  reasoning: string;
}

export interface BotMove {
  /** Packed action (from | to << 8 | shoot << 16). */
  action: number;
  reasoning: string;
}

export interface ResearchBot {
  readonly id: string;
  readonly label: string;
  /** Short citation shown in the lobby / logs. */
  readonly paper: string;
  readonly description: string;
  place(input: BotTurnInput): BotPlacement;
  play(input: BotTurnInput): BotMove;
}

/** Share of the turn budget spent on a placement (the draft has many picks). */
export const PLACEMENT_BUDGET_SHARE = 0.5;

/** Remaining drafters after the current pick, as slots (snake order). */
export function upcomingDrafters(state: GameState): number[] {
  return state.placementOrder.slice(state.placementIndex + 1).map((p: PlayerId) => slotOf(p));
}

export interface PlacementResult {
  cell: number;
  score: number;
  /** Deepest completed stage: 1 = static, 2 = with best reply of the next drafter. */
  depth: number;
  evaluated: number;
  candidates: number;
}

/**
 * Anytime snake-draft placement search with a bot-specific evaluation:
 *  stage 1 — evaluate every empty square for `me`;
 *  stage 2 — for the best `beam` squares, let the next drafter answer with
 *            their best square (by the same evaluation from their side) and
 *            keep the maximin square; the beam widens while time remains.
 * `prune` keeps only the best fraction after stage 1 (layered forward pruning).
 */
export function placementSearch(
  fb: FastBoard,
  me: number,
  drafters: ReadonlyArray<number>,
  evaluate: (fb: FastBoard, perspective: number) => number,
  clock: Clock,
  prune = 1,
): PlacementResult {
  const empties: number[] = [];
  for (let i = 0; i < fb.size; i++) if (fb.cells[i] === EMPTY) empties.push(i);
  const stage1: Array<{ cell: number; score: number }> = [];
  for (const cell of empties) {
    fb.place(me, cell);
    stage1.push({ cell, score: evaluate(fb, me) });
    fb.unplace(me, cell);
    clock.nodes++;
    if (clock.expired() && stage1.length > 0) break;
  }
  stage1.sort((a, b) => b.score - a.score);
  const result: PlacementResult = { cell: stage1[0]!.cell, score: stage1[0]!.score, depth: 1, evaluated: stage1.length, candidates: empties.length };
  const replier = drafters[0];
  if (replier === undefined || clock.expired()) return result;
  const pool = stage1.slice(0, Math.max(2, Math.ceil(stage1.length * prune)));
  const snap = fb.snapshot();

  for (let beam = 6; beam <= pool.length * 2; beam *= 2) {
    let best = -Infinity;
    let bestCell = -1;
    const mine = pool.slice(0, Math.min(beam, pool.length));
    try {
      for (const { cell } of mine) {
        fb.place(me, cell);
        // Next drafter's reply: best squares by their own evaluation (beam-limited).
        const replies: Array<{ cell: number; score: number }> = [];
        for (const r of pool) {
          if (r.cell === cell) continue;
          fb.place(replier, r.cell);
          replies.push({ cell: r.cell, score: evaluate(fb, replier) });
          fb.unplace(replier, r.cell);
          clock.nodes++;
          if (clock.expired()) throw TIMEOUT;
        }
        replies.sort((a, b) => b.score - a.score);
        const reply = replies[0];
        let v: number;
        if (reply) {
          fb.place(replier, reply.cell);
          v = evaluate(fb, me);
          fb.unplace(replier, reply.cell);
        } else v = evaluate(fb, me);
        fb.unplace(me, cell);
        if (v > best) {
          best = v;
          bestCell = cell;
        }
      }
    } catch {
      // Out of time: the board may still hold tentative totems; restore and keep the last full stage.
      fb.restore(snap);
      break;
    }
    result.cell = bestCell;
    result.score = best;
    result.depth = 2;
    if (beam >= pool.length) break;
  }
  return result;
}

/** Runs `placementSearch` with a snapshot so an interrupted stage can be rolled back. */
export function runPlacement(
  input: BotTurnInput,
  evaluate: (fb: FastBoard, perspective: number) => number,
  philosophy: string,
  prune = 1,
): BotPlacement {
  const { fb, me, clock, state } = input;
  const r = placementSearch(fb, me, upcomingDrafters(state), evaluate, clock.slice(PLACEMENT_BUDGET_SHARE), prune);
  const last = state.placementIndex === state.placementOrder.length - 1;
  return {
    cell: r.cell,
    reasoning:
      `${philosophy} Totem to ${cellName(fb, r.cell)}${last ? ' (last totem: we move first)' : ''}. ` +
      statLine([
        ['Depth', r.depth],
        ['', `${r.evaluated.toLocaleString('en-US')}/${r.candidates} squares`],
        ['Score', signed(r.score)],
      ]),
  };
}

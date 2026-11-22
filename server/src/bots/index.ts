/**
 * Registry of the 9 research bots + synchronous entry point (runs inside the
 * bot worker thread, see `runner.ts`, or directly in tests).
 */
import { getValidActions, getValidPlacements, validateAction, validatePlacement, type GameState } from '../../../shared/gameEngine.js';
import { heuristicAction, heuristicPlacement } from '../../../shared/aiBots.js';
import type { AiDecision } from '../../../shared/apiTypes.js';
import { createAmazongGuard } from './amazongGuard.js';
import { createAnkyRelTerritory } from './ankyRelTerritory.js';
import { createArrowLsg } from './arrowLsg.js';
import { createCampyaLibertyMc } from './campyaLibertyMc.js';
import { createCgtSubgame } from './cgtSubgame.js';
import type { ResearchBot } from './common.js';
import { Clock, FastBoard, Timeout, slotOf } from './evalUtils.js';
import { createGuoPhasedUct } from './guoPhasedUct.js';
import { createMgPeoMcts } from './mgPeoMcts.js';
import { createTasMoveCat } from './tasMoveCat.js';
import { createTdsEndgame } from './tdsEndgame.js';

export const RESEARCH_BOTS: ReadonlyArray<ResearchBot> = [
  createAnkyRelTerritory(),
  createMgPeoMcts(),
  createCgtSubgame(),
  createAmazongGuard(),
  createTasMoveCat(),
  createArrowLsg(),
  createTdsEndgame(),
  createCampyaLibertyMc(),
  createGuoPhasedUct(),
];

export const RESEARCH_BOT_IDS = RESEARCH_BOTS.map((b) => b.id);

/** Per-turn thinking budget limits (ms). The hard ceiling for a whole turn is `HARD_CEILING_MS`. */
export const MIN_BOT_BUDGET_MS = 100;
export const MAX_BOT_BUDGET_MS = 5000;
export const DEFAULT_BOT_BUDGET_MS = 3500;
export const HARD_CEILING_MS = 5000;

export function clampBudget(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_BOT_BUDGET_MS;
  return Math.round(Math.min(MAX_BOT_BUDGET_MS, Math.max(MIN_BOT_BUDGET_MS, ms)));
}

/**
 * Search deadline inside a turn: the budget minus a safety margin for board
 * conversion, result formatting and worker hand-off, so even a 5000 ms budget
 * returns before the 5000 ms hard ceiling.
 */
export function searchDeadlineMs(budgetMs: number): number {
  const b = clampBudget(budgetMs);
  return Math.max(30, Math.min(b * 0.92, HARD_CEILING_MS - 450) - 25);
}

export function findResearchBot(id: string): ResearchBot | undefined {
  return RESEARCH_BOTS.find((b) => b.id === id);
}

/**
 * Decides one turn for `state.currentPlayer` with a research bot (synchronous, CPU-bound).
 * The result is validated by the engine; a bot bug falls back to the heuristic with a note.
 */
export function runResearchBot(state: GameState, botId: string, budgetMs: number): AiDecision {
  const bot = findResearchBot(botId);
  if (!bot) throw new Error(`Unknown research bot "${botId}".`);
  const budget = clampBudget(budgetMs);
  const clock = Clock.fromBudget(searchDeadlineMs(budget));
  const fb = FastBoard.fromState(state);
  const me = slotOf(state.currentPlayer);
  const input = { state, fb, me, clock, budgetMs: budget };

  if (state.phase === 'PLACEMENT') {
    try {
      const r = bot.place(input);
      const placement = fb.toPosition(r.cell);
      if (validatePlacement(state, placement) === null) return { kind: 'placement', placement, reasoning: r.reasoning, modelUsed: bot.id };
      throw new Error('illegal placement');
    } catch (err) {
      const p = heuristicPlacement(state) ?? getValidPlacements(state)[0];
      if (!p) throw new Error('No legal placement available.', { cause: err });
      return { kind: 'placement', placement: p, reasoning: `(${bot.label}: ${describe(err)}; heuristic placement)`, modelUsed: 'offline:heuristic' };
    }
  }
  try {
    const r = bot.play(input);
    if (r.action < 0) throw new Error('no action found');
    const move = fb.toAction(r.action);
    // `fb` is restored after search; validate against the real engine state.
    if (validateAction(state, move) === null) return { kind: 'move', move, reasoning: r.reasoning, modelUsed: bot.id };
    throw new Error('illegal action');
  } catch (err) {
    const move = heuristicAction(state) ?? getValidActions(state)[0];
    if (!move) throw new Error('Current player has no legal action.', { cause: err });
    return { kind: 'move', move, reasoning: `(${bot.label}: ${describe(err)}; heuristic move)`, modelUsed: 'offline:heuristic' };
  }
}

function describe(err: unknown): string {
  if (err instanceof Timeout) return 'out of time before a first result';
  return err instanceof Error ? err.message : 'error';
}

/**
 * Worker-thread entry: research searches are CPU-bound for 3-5 s, so they run
 * off the main thread and the Express event loop stays responsive.
 */
import { parentPort } from 'node:worker_threads';
import type { GameState } from '../../../shared/gameEngine.js';
import { runResearchBot } from './index.js';

export interface BotJob {
  id: number;
  state: GameState;
  botId: string;
  budgetMs: number;
}

parentPort?.on('message', (job: BotJob) => {
  try {
    parentPort!.postMessage({ id: job.id, ok: true, decision: runResearchBot(job.state, job.botId, job.budgetMs) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

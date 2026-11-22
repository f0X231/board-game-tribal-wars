/**
 * Runs research bots in a small pool of worker threads with a hard per-turn
 * ceiling. If a worker misses the ceiling it is terminated and replaced, and
 * the caller gets `null` (→ heuristic fallback), so a turn never exceeds 5 s.
 */
import { Worker } from 'node:worker_threads';
import type { GameState } from '../../../shared/gameEngine.js';
import type { AiDecision } from '../../../shared/apiTypes.js';
import { HARD_CEILING_MS, clampBudget, runResearchBot } from './index.js';
import type { BotJob } from './worker.js';

type Reply = { id: number; ok: true; decision: AiDecision } | { id: number; ok: false; error: string };

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

const POOL_SIZE = 2;
const pool: PoolWorker[] = [];
const waiting: Array<() => void> = [];
let nextId = 1;
let workersUnavailable = false;

/** Under tsx the sources are `.ts`; after `tsc` they are `.js`. */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./worker${ext}`, import.meta.url);
}

/** Parent flags that make no sense for a worker module (e.g. from `node -e`). */
const WORKER_EXEC_ARGV = process.execArgv.filter((a) => !a.startsWith('--input-type') && a !== '-e' && a !== '--eval');
/** Set once any worker has answered; until then a crash means workers cannot run here. */
let workersProven = false;

function spawn(): PoolWorker {
  const w: PoolWorker = { worker: new Worker(workerUrl(), { execArgv: WORKER_EXEC_ARGV }), busy: false };
  w.worker.unref();
  return w;
}

async function acquire(): Promise<PoolWorker> {
  for (;;) {
    const free = pool.find((w) => !w.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (pool.length < POOL_SIZE) {
      const w = spawn();
      w.busy = true;
      pool.push(w);
      return w;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
}

function release(w: PoolWorker): void {
  w.busy = false;
  waiting.shift()?.();
}

function replace(w: PoolWorker): void {
  void w.worker.terminate();
  const i = pool.indexOf(w);
  if (i >= 0) pool.splice(i, 1);
  waiting.shift()?.();
}

export interface ResearchTurn {
  decision: AiDecision | null;
  /** Why `decision` is null (ceiling missed / worker error). */
  error: string | null;
  elapsedMs: number;
}

/**
 * Decides a research-bot turn. Queue time for a busy pool is not counted against
 * the ceiling; the search itself is limited to `budgetMs` and killed at 5000 ms.
 */
export async function runResearchTurn(state: GameState, botId: string, budgetMs: number): Promise<ResearchTurn> {
  const budget = clampBudget(budgetMs);
  if (workersUnavailable) return inProcess(state, botId, budget);
  let w: PoolWorker;
  try {
    w = await acquire();
  } catch {
    workersUnavailable = true;
    return inProcess(state, botId, budget);
  }
  const started = performance.now();
  const id = nextId++;
  return new Promise<ResearchTurn>((resolve) => {
    let settled = false;
    const finish = (r: ResearchTurn, healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.worker.off('message', onMessage);
      w.worker.off('error', onError);
      if (healthy) release(w);
      else replace(w);
      resolve(r);
    };
    const onMessage = (msg: Reply) => {
      if (msg.id !== id) return;
      const elapsedMs = performance.now() - started;
      workersProven = true;
      if (msg.ok) finish({ decision: msg.decision, error: null, elapsedMs }, true);
      else finish({ decision: null, error: msg.error, elapsedMs }, true);
    };
    const onError = (err: Error) => {
      if (!workersProven) {
        // Workers cannot start in this runtime: run research bots on the main thread from now on.
        workersUnavailable = true;
        console.warn(`[bots] worker threads unavailable (${err.message}); running research bots in-process`);
        settled = true;
        clearTimeout(timer);
        replace(w);
        resolve(inProcess(state, botId, budget));
        return;
      }
      finish({ decision: null, error: `worker crashed: ${err.message}`, elapsedMs: performance.now() - started }, false);
    };
    const timer = setTimeout(
      () => finish({ decision: null, error: `exceeded the ${HARD_CEILING_MS} ms ceiling`, elapsedMs: performance.now() - started }, false),
      HARD_CEILING_MS,
    );
    w.worker.on('message', onMessage);
    w.worker.on('error', onError);
    const job: BotJob = { id, state, botId, budgetMs: budget };
    w.worker.postMessage(job);
  });
}

/** Fallback when worker threads cannot start (e.g. unusual runtimes): run on the main thread. */
function inProcess(state: GameState, botId: string, budget: number): ResearchTurn {
  const started = performance.now();
  try {
    return { decision: runResearchBot(state, botId, budget), error: null, elapsedMs: performance.now() - started };
  } catch (err) {
    return { decision: null, error: err instanceof Error ? err.message : String(err), elapsedMs: performance.now() - started };
  }
}

/** Stops all bot workers (tests / graceful shutdown). */
export async function shutdownResearchWorkers(): Promise<void> {
  await Promise.all(pool.splice(0).map((w) => w.worker.terminate()));
}

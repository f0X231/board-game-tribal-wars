/**
 * Headless batch experiments: N full matches between bots/LLMs, every match saved
 * as research telemetry in the match archive (`server/data/matches/` by default).
 *
 *   npm run experiment -- --models offline:heuristic,groq:openai/gpt-oss-20b --games 20
 *   npm run experiment -- --models research:arrow-lsg,research:mg-peo-mcts --games 10 --jsonl out.jsonl --csv out.csv
 *   npm run experiment -- --round-robin --models all-research --board 10 --tag rr-9bots
 *
 * Options:
 *   --models     2-4 comma-separated model ids, one per seat (P1, P2, ...)       (required)
 *                `all-research` expands to every research:* bot (can be mixed with other ids)
 *   --round-robin  every unique 1v1 pair of --models (2+ models; 9 bots = 36 pairs), --games per pair;
 *                prints a Round-Robin Leaderboard and saves a summary JSON next to the match archive
 *   --games      number of matches (per pair with --round-robin)     (default 10; 2 with --round-robin)
 *   --board      6 | 10 | 12                                                        (default 10)
 *   --pieces     totems per tribe                                 (default: minimum for the board)
 *   --placement  MANUAL (models draft) | RANDOM (random snake spawn)            (default MANUAL)
 *   --no-rotate  keep seats fixed (default: rotate models across seats every game)
 *   --seed       seed for RANDOM spawns, for reproducible openings                  (optional)
 *   --pause-ms   wait between LLM calls (free-tier rate limits)                     (default 0)
 *   --tag        experiment name stored in every match log                         (optional)
 *   --bot-budget-ms  thinking budget per turn for research:* bots, 100-5000  (default BOT_TIME_BUDGET_MS or 3500)
 *   --jsonl      also append every match (full telemetry, one JSON per line) to this file   (optional)
 *   --csv        also write every decision of the tournament as CSV rows to this file      (optional)
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { AiRequestError, chooseAiTurn } from './aiService.js';
import { MatchStore } from './matchRecorder.js';
import { getModelCatalog, resolveModel } from './models.js';
import { RESEARCH_BOT_IDS, clampBudget } from './bots/index.js';
import { shutdownResearchWorkers } from './bots/runner.js';
import {
  ALL_PLAYERS,
  createGame,
  getPieceLimits,
  isBoardSize,
  validateConfig,
  type BoardSize,
  type GameState,
  type PlacementMode,
  type PlayerCount,
} from '../../shared/gameEngine.js';
import {
  applyDecision,
  buildMatchTelemetry,
  createMatchId,
  describeTransition,
  matchToCsv,
  replayDecisions,
  spawnDecisions,
  type Decision,
  type MatchConfigRecord,
  type MatchSeat,
  type MatchSummary,
  type TelemetryEvent,
} from '../../shared/telemetry.js';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`experiment: ${message}\nUsage: npm run experiment -- --models a,b[,c,d]|all-research [--round-robin] [--games N] [--board 6|10|12] [--pieces N] [--placement MANUAL|RANDOM] [--no-rotate] [--seed N] [--pause-ms N] [--tag name] [--bot-budget-ms 100-5000] [--jsonl file] [--csv file]`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    games: { type: 'string' },
    'round-robin': { type: 'boolean', default: false },
    board: { type: 'string', default: '10' },
    pieces: { type: 'string' },
    placement: { type: 'string', default: 'MANUAL' },
    'no-rotate': { type: 'boolean', default: false },
    seed: { type: 'string' },
    'pause-ms': { type: 'string', default: '0' },
    tag: { type: 'string' },
    'bot-budget-ms': { type: 'string' },
    jsonl: { type: 'string' },
    csv: { type: 'string' },
  },
});

// Warm the live model catalog (capabilities drive per-model request parameters).
const catalog = await getModelCatalog();
for (const [provider, d] of Object.entries(catalog.discovery ?? {})) {
  if (d.status !== 'no-key') console.log(`models: ${provider} ${d.status} (${d.count} free models)${d.error ? ` - ${d.error}` : ''}`);
}

const roundRobin = values['round-robin'] === true;
const models = [
  ...new Set(
    (values.models ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .flatMap((m) => (m === 'all-research' ? RESEARCH_BOT_IDS : [m])),
  ),
];
if (roundRobin) {
  if (models.length < 2) fail('--round-robin needs at least 2 distinct models (or --models all-research)');
} else if (models.length < 2 || models.length > 4) fail('--models needs 2-4 comma-separated model ids (or use --round-robin)');
for (const m of models) {
  const info = resolveModel(m);
  if (!info) fail(`unknown model "${m}"`);
  if (!info.available) console.warn(`warning: ${m} has no API key configured; its turns will fall back to offline:heuristic`);
}
const games = Number(values.games ?? (roundRobin ? 2 : 10));
const board = Number(values.board);
if (!Number.isInteger(games) || games < 1 || games > 10_000) fail('--games must be 1-10000');
if (!isBoardSize(board)) fail('--board must be 6, 10 or 12');
const boardSize: BoardSize = board;
const piecesPerPlayer = values.pieces === undefined ? getPieceLimits(boardSize).min : Number(values.pieces);
const placement = values.placement?.toUpperCase();
if (placement !== 'MANUAL' && placement !== 'RANDOM') fail('--placement must be MANUAL or RANDOM');
const placementMode: PlacementMode = placement;
const playerCount = (roundRobin ? 2 : models.length) as PlayerCount;
const matchConfig: MatchConfigRecord = { boardSize, playerCount, piecesPerPlayer, placementMode };
const configErrors = validateConfig(matchConfig);
if (configErrors.length > 0) fail(configErrors.join(' '));
const pauseMs = Math.max(0, Number(values['pause-ms']) || 0);
const rotate = !values['no-rotate'];
const spawnRandom = values.seed === undefined ? Math.random : seeded(Number(values.seed));
const store = new MatchStore(config.matchDataDir);
const rawBudget = values['bot-budget-ms'] === undefined ? config.botTimeBudgetMs : Number(values['bot-budget-ms']);
if (!Number.isFinite(rawBudget) || rawBudget < 100 || rawBudget > 5000) fail('--bot-budget-ms must be 100-5000');
const botBudgetMs = clampBudget(rawBudget);
const usesResearch = models.some((m) => m.startsWith('research:'));
let csvHeaderWritten = false;
if (values.csv) await writeFile(values.csv, '');
if (values.jsonl) await writeFile(values.jsonl, '');

/** Appends one finished match to the optional tournament exports. */
async function exportMatch(telemetry: Parameters<typeof matchToCsv>[0]): Promise<void> {
  if (values.jsonl) await appendFile(values.jsonl, JSON.stringify(telemetry) + '\n');
  if (values.csv) {
    const csv = matchToCsv(telemetry);
    const body = csvHeaderWritten ? csv.slice(csv.indexOf('\n') + 1) : csv;
    csvHeaderWritten = true;
    await appendFile(values.csv, body.endsWith('\n') ? body : body + '\n');
  }
}

/** Plays one match; `lineup[i]` is the model id for seat `ALL_PLAYERS[i]`. */
async function playMatch(lineup: ReadonlyArray<string>): Promise<MatchSummary> {
  const startedAt = new Date();
  const seats: MatchSeat[] = lineup.map((modelId, i) => ({
    player: ALL_PLAYERS[i]!,
    controller: 'ai',
    modelId,
    label: resolveModel(modelId)?.label ?? modelId,
  }));

  let state: GameState = createGame(matchConfig, spawnRandom);
  let events: TelemetryEvent[] = [];
  if (placementMode === 'RANDOM') {
    const replay = replayDecisions(matchConfig, spawnDecisions(state));
    state = replay.state;
    events = replay.events;
  }

  while (state.status === 'PLAYING') {
    const seatIndex = ALL_PLAYERS.indexOf(state.currentPlayer);
    const modelId = lineup[seatIndex]!;
    const t0 = performance.now();
    const res = await chooseAiTurn(state, modelId, { botBudgetMs });
    const meta = {
      player: state.currentPlayer,
      controller: modelId,
      modelUsed: res.modelUsed,
      fallback: res.fallback,
      reasoning: res.reasoning,
      thinkTimeMs: Math.round(performance.now() - t0),
    };
    maxThink.set(modelId, Math.max(maxThink.get(modelId) ?? 0, meta.thinkTimeMs));
    const decision: Decision = res.kind === 'placement' ? { ...meta, kind: 'placement', placement: res.placement } : { ...meta, kind: 'move', move: res.move };
    const next = applyDecision(state, decision);
    events.push(describeTransition(state, next, decision, events.length));
    state = next;
    if (pauseMs > 0 && !modelId.startsWith('offline:') && !modelId.startsWith('research:')) await sleep(pauseMs);
  }

  const telemetry = buildMatchTelemetry(
    {
      matchId: createMatchId(startedAt, Math.random),
      source: 'experiment',
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      config: matchConfig,
      seats,
      ...(values.tag ? { tag: values.tag } : {}),
    },
    events,
    state,
  );
  await store.save(telemetry);
  await exportMatch(telemetry);
  return telemetry.summary;
}

/** Match schedule: one lineup (model per seat) per game. */
const schedule: string[][] = [];
const pairs: Array<[string, string]> = [];
if (roundRobin) {
  for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) pairs.push([models[i]!, models[j]!]);
  for (const [a, b] of pairs) for (let g = 0; g < games; g++) schedule.push(rotate && g % 2 === 1 ? [b, a] : [a, b]);
} else {
  for (let g = 0; g < games; g++) {
    const shift = rotate ? g % models.length : 0;
    schedule.push(models.map((_, i) => models[(i + shift) % models.length]!));
  }
}

console.log(
  (roundRobin
    ? `Round-robin: ${models.length} models, ${pairs.length} pairs x ${games} game(s) = ${schedule.length} matches, `
    : `Experiment: ${games} game(s), `) +
    `${boardSize}x${boardSize}, ${piecesPerPlayer} totems, ${placementMode} placement, ` +
    `seats ${rotate ? 'rotated' : 'fixed'}${usesResearch ? `, research bot budget ${botBudgetMs} ms/turn` : ''}\n` +
    `Models: ${models.join(roundRobin ? ', ' : ' vs ')}\nSaving to ${config.matchDataDir}` +
    `${values.tag ? `\nTag: ${values.tag}` : ''}${values.jsonl ? `\nJSONL: ${values.jsonl}` : ''}${values.csv ? `\nCSV: ${values.csv}` : ''}\n`,
);

/** Slowest single decision per model (checks the research bots' 5 s ceiling). */
const maxThink = new Map<string, number>();

interface Tally {
  games: number;
  wins: number;
  losses: number;
  queen: number;
  exclusive: number;
  fallbacks: number;
  decisions: number;
  thinkMs: number;
  timed: number;
}

const tally = new Map<string, Tally>(
  models.map((m) => [m, { games: 0, wins: 0, losses: 0, queen: 0, exclusive: 0, fallbacks: 0, decisions: 0, thinkMs: 0, timed: 0 }]),
);
/** Head-to-head wins: `h2h.get(a)?.get(b)` = games a won against b. */
const h2h = new Map<string, Map<string, number>>(models.map((m) => [m, new Map<string, number>()]));
const matchIds: string[] = [];
let aborted = 0;
const started = Date.now();
const startedIso = new Date(started).toISOString();

for (const [g, lineup] of schedule.entries()) {
  let summary: MatchSummary;
  try {
    summary = await playMatch(lineup);
  } catch (err) {
    if (err instanceof AiRequestError) {
      aborted++;
      console.error(`game ${g + 1}: aborted (${err.message})`);
      continue;
    }
    throw err;
  }
  matchIds.push(summary.matchId);
  const winnerModel = summary.seats.find((s) => s.placing === 1)?.modelId ?? null;
  for (const seat of summary.seats) {
    const t = tally.get(seat.modelId ?? '')!;
    t.games++;
    if (seat.placing === 1) t.wins++;
    else t.losses++;
    t.queen += seat.finalQueenVoronoi;
    t.exclusive += seat.finalExclusiveSafe;
    t.fallbacks += seat.fallbacks;
    t.decisions += seat.decisions;
    if (seat.avgThinkTimeMs !== null) {
      t.thinkMs += seat.avgThinkTimeMs * seat.decisions;
      t.timed += seat.decisions;
    }
    if (winnerModel && seat.modelId && seat.modelId !== winnerModel) {
      const row = h2h.get(winnerModel)!;
      row.set(seat.modelId, (row.get(seat.modelId) ?? 0) + 1);
    }
  }
  console.log(
    `game ${String(g + 1).padStart(3)}/${schedule.length}  ${summary.matchId}  ${lineup.map((m, i) => `${ALL_PLAYERS[i]}=${m}`).join(' ')}  ` +
      `-> winner ${summary.winner ?? 'none'} (${winnerModel ?? '-'}) after ${summary.totalTurns} turns`,
  );
}

const durationS = (Date.now() - started) / 1000;
const rate = (t: Tally) => (t.games ? (100 * t.wins) / t.games : 0);
const row = (model: string, t: Tally) => ({
  model,
  games: t.games,
  wins: t.wins,
  losses: t.losses,
  'win %': +rate(t).toFixed(1),
  'avg queen voronoi': t.games ? +(t.queen / t.games).toFixed(1) : 0,
  'avg exclusive': t.games ? +(t.exclusive / t.games).toFixed(1) : 0,
  'avg think ms': t.timed ? Math.round(t.thinkMs / t.timed) : null,
  'max think ms': maxThink.get(model) ?? null,
  'fallback %': t.decisions ? +((100 * t.fallbacks) / t.decisions).toFixed(1) : 0,
});

if (!roundRobin) {
  console.log(`\nResults (${durationS.toFixed(1)}s)`);
  console.table([...tally.entries()].map(([model, t]) => row(model, t)));
} else {
  // Rank: win rate, then wins, then average final Queen Voronoi.
  const ranked = [...tally.entries()].sort(
    ([, a], [, b]) => rate(b) - rate(a) || b.wins - a.wins || (b.games ? b.queen / b.games : 0) - (a.games ? a.queen / a.games : 0),
  );
  const leaderboard = ranked.map(([model, t], i) => ({ rank: i + 1, ...row(model, t) }));
  console.log(`\nRound-Robin Leaderboard (${schedule.length - aborted}/${schedule.length} matches, ${(durationS / 60).toFixed(1)} min)`);
  console.table(leaderboard);

  // Head-to-head: wins of the row model against the column model.
  const short = (m: string) => m.replace(/^research:/, '');
  console.log('Head-to-head (row wins vs column):');
  console.table(
    Object.fromEntries(ranked.map(([a]) => [short(a), Object.fromEntries(ranked.map(([b]) => [short(b), a === b ? '-' : (h2h.get(a)!.get(b) ?? 0)]))])),
  );

  const summaryDir = path.dirname(path.resolve(config.matchDataDir));
  await mkdir(summaryDir, { recursive: true });
  const stamp = startedIso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const safeTag = values.tag ? `-${values.tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}` : '';
  const summaryPath = path.join(summaryDir, `round-robin-${stamp}${safeTag}.json`);
  const summaryJson = {
    type: 'round-robin',
    tag: values.tag ?? null,
    startedAt: startedIso,
    endedAt: new Date().toISOString(),
    durationSeconds: Math.round(durationS),
    config: { ...matchConfig, gamesPerPair: games, rotateSeats: rotate, botBudgetMs, seed: values.seed ?? null },
    models,
    pairs: pairs.length,
    matches: { scheduled: schedule.length, completed: schedule.length - aborted, aborted },
    leaderboard,
    headToHead: Object.fromEntries(models.map((a) => [a, Object.fromEntries(models.filter((b) => b !== a).map((b) => [b, h2h.get(a)!.get(b) ?? 0]))])),
    matchIds,
  };
  await writeFile(summaryPath, JSON.stringify(summaryJson, null, 2) + '\n');
  console.log(`Summary saved: ${summaryPath}`);
}
console.log('Export: GET /api/matches  ·  GET /api/matches/<id>/export?format=csv');
await shutdownResearchWorkers();

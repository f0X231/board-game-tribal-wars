/**
 * Headless batch experiments: N full matches between bots/LLMs, every match saved
 * as research telemetry in the match archive (`server/data/matches/` by default).
 *
 *   npm run experiment -- --models offline:heuristic,groq:llama-3.3-70b-versatile --games 20
 *
 * Options:
 *   --models     2-4 comma-separated model ids, one per seat (P1, P2, ...)       (required)
 *   --games      number of matches                                                 (default 10)
 *   --board      6 | 10 | 12                                                        (default 10)
 *   --pieces     totems per tribe                                 (default: minimum for the board)
 *   --placement  MANUAL (models draft) | RANDOM (random snake spawn)            (default MANUAL)
 *   --no-rotate  keep seats fixed (default: rotate models across seats every game)
 *   --seed       seed for RANDOM spawns, for reproducible openings                  (optional)
 *   --pause-ms   wait between LLM calls (free-tier rate limits)                     (default 0)
 *   --tag        experiment name stored in every match log                         (optional)
 */
import { parseArgs } from 'node:util';
import { config } from './config.js';
import { AiRequestError, chooseAiTurn } from './aiService.js';
import { MatchStore } from './matchRecorder.js';
import { resolveModel } from './models.js';
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
  console.error(`experiment: ${message}\nUsage: npm run experiment -- --models a,b[,c,d] [--games N] [--board 6|10|12] [--pieces N] [--placement MANUAL|RANDOM] [--no-rotate] [--seed N] [--pause-ms N] [--tag name]`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    games: { type: 'string', default: '10' },
    board: { type: 'string', default: '10' },
    pieces: { type: 'string' },
    placement: { type: 'string', default: 'MANUAL' },
    'no-rotate': { type: 'boolean', default: false },
    seed: { type: 'string' },
    'pause-ms': { type: 'string', default: '0' },
    tag: { type: 'string' },
  },
});

const models = (values.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
if (models.length < 2 || models.length > 4) fail('--models needs 2-4 comma-separated model ids');
for (const m of models) {
  const info = resolveModel(m);
  if (!info) fail(`unknown model "${m}"`);
  if (!info.available) console.warn(`warning: ${m} has no API key configured; its turns will fall back to offline:heuristic`);
}
const games = Number(values.games);
const board = Number(values.board);
if (!Number.isInteger(games) || games < 1 || games > 10_000) fail('--games must be 1-10000');
if (!isBoardSize(board)) fail('--board must be 6, 10 or 12');
const boardSize: BoardSize = board;
const piecesPerPlayer = values.pieces === undefined ? getPieceLimits(boardSize).min : Number(values.pieces);
const placement = values.placement?.toUpperCase();
if (placement !== 'MANUAL' && placement !== 'RANDOM') fail('--placement must be MANUAL or RANDOM');
const placementMode: PlacementMode = placement;
const playerCount = models.length as PlayerCount;
const matchConfig: MatchConfigRecord = { boardSize, playerCount, piecesPerPlayer, placementMode };
const configErrors = validateConfig(matchConfig);
if (configErrors.length > 0) fail(configErrors.join(' '));
const pauseMs = Math.max(0, Number(values['pause-ms']) || 0);
const rotate = !values['no-rotate'];
const spawnRandom = values.seed === undefined ? Math.random : seeded(Number(values.seed));
const store = new MatchStore(config.matchDataDir);

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
    const res = await chooseAiTurn(state, modelId);
    const meta = {
      player: state.currentPlayer,
      controller: modelId,
      modelUsed: res.modelUsed,
      fallback: res.fallback,
      reasoning: res.reasoning,
      thinkTimeMs: Math.round(performance.now() - t0),
    };
    const decision: Decision = res.kind === 'placement' ? { ...meta, kind: 'placement', placement: res.placement } : { ...meta, kind: 'move', move: res.move };
    const next = applyDecision(state, decision);
    events.push(describeTransition(state, next, decision, events.length));
    state = next;
    if (pauseMs > 0 && !modelId.startsWith('offline:')) await sleep(pauseMs);
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
  return telemetry.summary;
}

interface Tally {
  games: number;
  wins: number;
  queen: number;
  exclusive: number;
  fallbacks: number;
  decisions: number;
  thinkMs: number;
  timed: number;
}

console.log(
  `Experiment: ${games} game(s), ${boardSize}x${boardSize}, ${piecesPerPlayer} totems, ${placementMode} placement, ` +
    `seats ${rotate ? 'rotated' : 'fixed'}\nModels: ${models.join(' vs ')}\nSaving to ${config.matchDataDir}\n`,
);

const tally = new Map<string, Tally>(models.map((m) => [m, { games: 0, wins: 0, queen: 0, exclusive: 0, fallbacks: 0, decisions: 0, thinkMs: 0, timed: 0 }]));
const started = Date.now();
for (let g = 0; g < games; g++) {
  const shift = rotate ? g % models.length : 0;
  const lineup = models.map((_, i) => models[(i + shift) % models.length]!);
  let summary: MatchSummary;
  try {
    summary = await playMatch(lineup);
  } catch (err) {
    if (err instanceof AiRequestError) {
      console.error(`game ${g + 1}: aborted (${err.message})`);
      continue;
    }
    throw err;
  }
  for (const seat of summary.seats) {
    const t = tally.get(seat.modelId ?? '')!;
    t.games++;
    if (seat.placing === 1) t.wins++;
    t.queen += seat.finalQueenVoronoi;
    t.exclusive += seat.finalExclusiveSafe;
    t.fallbacks += seat.fallbacks;
    t.decisions += seat.decisions;
    if (seat.avgThinkTimeMs !== null) {
      t.thinkMs += seat.avgThinkTimeMs * seat.decisions;
      t.timed += seat.decisions;
    }
  }
  const winner = summary.seats.find((s) => s.placing === 1);
  console.log(
    `game ${String(g + 1).padStart(3)}  ${summary.matchId}  ${lineup.map((m, i) => `${ALL_PLAYERS[i]}=${m}`).join(' ')}  ` +
      `-> winner ${summary.winner ?? 'none'} (${winner?.modelId ?? '-'}) after ${summary.totalTurns} turns`,
  );
}

console.log(`\nResults (${((Date.now() - started) / 1000).toFixed(1)}s)`);
console.table(
  [...tally.entries()].map(([model, t]) => ({
    model,
    games: t.games,
    wins: t.wins,
    'win %': t.games ? Math.round((100 * t.wins) / t.games) : 0,
    'avg final queen voronoi': t.games ? +(t.queen / t.games).toFixed(1) : 0,
    'avg final exclusive': t.games ? +(t.exclusive / t.games).toFixed(1) : 0,
    'fallback %': t.decisions ? +((100 * t.fallbacks) / t.decisions).toFixed(1) : 0,
    'avg think ms': t.timed ? Math.round(t.thinkMs / t.timed) : null,
  })),
);
console.log('Export: GET /api/matches  ·  GET /api/matches/<id>/export?format=csv');

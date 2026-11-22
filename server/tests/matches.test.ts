/**
 * Match recorder + /api/matches tests. Run: `npx tsx tests/matches.test.ts`.
 * Spawns the real server (tsx) on a free port with a temporary MATCH_DATA_DIR.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from '../../shared/gameEngine.js';
import { heuristicAction, heuristicPlacement } from '../../shared/aiBots.js';
import {
  CSV_COLUMNS,
  applyDecision,
  buildMatchTelemetry,
  describeTransition,
  type Decision,
  type MatchMeta,
  type MatchSummary,
  type MatchTelemetry,
  type TelemetryEvent,
} from '../../shared/telemetry.js';
import { MatchStore } from '../src/matchRecorder.js';
import { parseMatchSubmission } from '../src/matchValidation.js';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** A complete heuristic-vs-heuristic 6x6 match, recorded like the client does. */
function recordMatch(matchId: string): MatchTelemetry {
  const config = { boardSize: 6, playerCount: 2, piecesPerPlayer: 2, placementMode: 'MANUAL' } as const;
  let s = createGame(config);
  const events: TelemetryEvent[] = [];
  while (s.status === 'PLAYING') {
    const meta = { player: s.currentPlayer, controller: 'offline:heuristic', modelUsed: 'offline:heuristic', fallback: false, reasoning: 'because, "reasons"', thinkTimeMs: 12 };
    const d: Decision = s.phase === 'PLACEMENT' ? { ...meta, kind: 'placement', placement: heuristicPlacement(s)! } : { ...meta, kind: 'move', move: heuristicAction(s)! };
    const next = applyDecision(s, d);
    events.push(describeTransition(s, next, d, events.length));
    s = next;
  }
  const meta: MatchMeta = {
    matchId,
    source: 'client',
    startedAt: '2026-11-21T10:00:00.000Z',
    endedAt: '2026-11-21T10:02:00.000Z',
    config,
    seats: [
      { player: 'P1', controller: 'human', modelId: null, label: 'Human' },
      { player: 'P2', controller: 'ai', modelId: 'offline:heuristic', label: 'Heuristic Shaman' },
    ],
  };
  return buildMatchTelemetry(meta, events, s);
}

const roundTrip = <T>(v: T) => JSON.parse(JSON.stringify(v)) as unknown;

/** Returns a JSON copy of `value` with the property at `path` replaced (for tampering tests). */
function tamper(value: unknown, path: ReadonlyArray<string | number>, replacement: unknown): unknown {
  const copy = roundTrip(value);
  let node: unknown = copy;
  for (const key of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[key];
  (node as Record<string | number, unknown>)[path.at(-1)!] = replacement;
  return copy;
}

console.log('\nsubmission validation');
await test('accepts a full telemetry log and a compact { meta, decisions } body', () => {
  const t = recordMatch('m-valid');
  assert(parseMatchSubmission(roundTrip(t)).ok, 'full log rejected');
  const compact = { meta: t.meta, decisions: t.events.map((e) => e.decision) };
  assert(parseMatchSubmission(roundTrip(compact)).ok, 'compact body rejected');
});

await test('rejects path-traversal ids, bad configs, bad seats and malformed decisions', () => {
  const t = recordMatch('m-x');
  const bad = (path: ReadonlyArray<string | number>, value: unknown, why: string) => {
    assert(!parseMatchSubmission(tamper(t, path, value)).ok, `accepted: ${why}`);
  };
  bad(['meta', 'matchId'], '../../etc/passwd', 'traversal id');
  bad(['meta', 'config', 'boardSize'], 8, 'board 8');
  bad(['meta', 'config', 'piecesPerPlayer'], 6, '6 pieces on 6x6');
  bad(['meta', 'seats'], t.meta.seats.slice(0, 1), 'missing seat');
  bad(['meta', 'seats', 1, 'player'], 'P3', 'seat out of order');
  bad(['events', 0, 'decision', 'placement'], { row: 9, col: 0 }, 'off-board placement');
  bad(['events', 3, 'decision', 'thinkTimeMs'], -5, 'negative think time');
  bad(['events', 3, 'decision', 'kind'], 'teleport', 'unknown kind');
  bad(['events'], [], 'empty log');
  bad(['meta', 'startedAt'], 'yesterday', 'bad date');
});

await test('client-supplied metrics are ignored (source forced to client, text clipped)', () => {
  let t = tamper(recordMatch('m-y'), ['meta', 'source'], 'experiment');
  t = tamper(t, ['events', 0, 'metrics', 'players', 0, 'queenVoronoiCells'], 9999);
  t = tamper(t, ['events', 5, 'decision', 'reasoning'], 'x'.repeat(5000));
  const r = parseMatchSubmission(t);
  assert(r.ok, 'rejected');
  assert(r.meta.source === 'client', 'source not forced');
  assert(r.decisions[5]!.reasoning!.length === 2000, 'reasoning not clipped');
});

console.log('\nmatch store');
const dir = await mkdtemp(path.join(tmpdir(), 'tw-matches-'));
await test('save / load / list round-trip and no overwrite', async () => {
  const store = new MatchStore(dir);
  const t = recordMatch('m-store-1');
  assert((await store.save(t)) === 'created', 'not created');
  assert((await store.save(t)) === 'exists', 'overwrote existing match');
  const loaded = await store.load('m-store-1');
  assert(JSON.stringify(loaded) === JSON.stringify(t), 'load mismatch');
  assert((await store.load('../secret')) === null, 'traversal load not refused');
  assert((await store.list()).length === 1, 'list');
});

console.log('\nHTTP API');
const port = await new Promise<number>((resolve) => {
  const srv = createServer().listen(0, () => {
    const p = (srv.address() as { port: number }).port;
    srv.close(() => resolve(p));
  });
});
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(port), MATCH_DATA_DIR: dir, OPENROUTER_API_KEY: '', GROQ_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const post = (body: unknown) =>
  fetch(`${base}/api/matches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

await test('POST /api/matches stores a replayed log (201), duplicate -> 409', async () => {
  const t = recordMatch('m-http-1');
  const res = await post(t);
  assert(res.status === 201, `status ${res.status}`);
  const body = (await res.json()) as { matchId: string; summary: MatchSummary };
  assert(body.matchId === 'm-http-1' && body.summary.winner === t.summary.winner, 'summary mismatch');
  assert((await post(t)).status === 409, 'duplicate not refused');
});

await test('POST /api/matches rejects tampered (illegal) and unfinished logs with 400', async () => {
  const t = tamper(recordMatch('m-http-bad'), ['events', 4, 'decision', 'move'], { from: { row: 0, col: 0 }, to: { row: 5, col: 5 }, shoot: { row: 1, col: 1 } });
  const illegal = await post(t);
  assert(illegal.status === 400, `illegal status ${illegal.status}`);
  assert(((await illegal.json()) as { error: string }).error.startsWith('Illegal match log'), 'error text');
  const full = recordMatch('m-http-unfinished');
  const unfinished = tamper(full, ['events'], full.events.slice(0, -1));
  assert((await post(unfinished)).status === 400, 'unfinished accepted');
});

await test('GET /api/matches lists summaries', async () => {
  const res = await fetch(`${base}/api/matches`);
  const body = (await res.json()) as { matches: MatchSummary[]; count: number };
  assert(res.ok && body.count === 2, `count ${body.count}`);
  const m = body.matches.find((x) => x.matchId === 'm-http-1')!;
  assert(m.boardSize === 6 && m.totalTurns > 0 && m.models === 'P1=human, P2=offline:heuristic', 'summary fields');
});

await test('GET /api/matches/:id/export returns JSON and CSV attachments', async () => {
  const json = await fetch(`${base}/api/matches/m-http-1/export?format=json`);
  assert(json.ok && json.headers.get('content-disposition')?.includes('tribal-wars-m-http-1.json'), 'json headers');
  const parsed = (await json.json()) as MatchTelemetry;
  assert(parsed.events.length > 0 && parsed.events[0]!.metrics.players.length === 2, 'json body');
  assert(parsed.meta.source === 'client', 'source');

  const csv = await fetch(`${base}/api/matches/m-http-1/export?format=csv`);
  assert(csv.ok && csv.headers.get('content-type')?.startsWith('text/csv'), 'csv type');
  const lines = (await csv.text()).trim().split('\n');
  assert(lines[0] === CSV_COLUMNS.join(','), 'csv header');
  assert(lines.length === parsed.events.length + 1, 'one row per decision');

  assert((await fetch(`${base}/api/matches/m-http-1/export?format=xml`)).status === 400, 'bad format');
  assert((await fetch(`${base}/api/matches/nope/export`)).status === 404, 'missing match');
  assert((await fetch(`${base}/api/matches/..%2F..%2Fpackage/export`)).status === 404, 'traversal');
});

await test('only server-written files exist in the data dir', async () => {
  const files = (await readdir(dir)).sort();
  assert(JSON.stringify(files) === JSON.stringify(['m-http-1.json', 'm-store-1.json']), files.join(','));
});

child.kill();
await rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
  console.error(failures.join('\n'));
}

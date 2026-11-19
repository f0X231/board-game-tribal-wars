/**
 * AI service tests. Run with:  npm test   (tsx tests/aiService.test.ts)
 *
 * Uses a local fake OpenAI-compatible server so the LLM path (success, bad JSON,
 * out-of-range index, timeout, HTTP error) is exercised without real API keys.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- fake LLM provider ------------------------------------------------------
type Mode = 'good' | 'think' | 'garbage' | 'out-of-range' | 'slow' | 'http-429';
let mode: Mode = 'good';
let lastPrompt = '';

const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    lastPrompt = parsed.messages.at(-1)?.content ?? '';
    const key = lastPrompt.includes('placementIndex') ? 'placementIndex' : 'actionIndex';
    const content: Record<Mode, string> = {
      good: JSON.stringify({ [key]: 2, reasoning: 'Fake model: open lines.' }),
      think: `<think>{"${key}": 99} hmm</think>\n\`\`\`json\n{"${key}": 1, "reasoning": "after thinking"}\n\`\`\``,
      garbage: 'I would move the red totem forward!',
      'out-of-range': JSON.stringify({ [key]: 500, reasoning: 'oops' }),
      slow: '',
      'http-429': '',
    };
    const send = () => {
      if (mode === 'http-429') {
        res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: content[mode] } }],
        }),
      );
    };
    if (mode === 'slow') setTimeout(send, 1500);
    else send();
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const port = (fake.address() as AddressInfo).port;

// Configure BEFORE importing the service (config is read at import time).
process.env.GROQ_API_KEY = 'test-key';
process.env.GROQ_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.OPENROUTER_API_KEY = '';
process.env.LLM_TIMEOUT_MS = '700';

const { chooseAiTurn, parseChoice, AiRequestError } = await import('../src/aiService.js');
const { parseGameState } = await import('../src/stateValidation.js');
const engine = await import('../../shared/gameEngine.js');
const bots = await import('../../shared/aiBots.js');

// ---- mini harness -----------------------------------------------------------
let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

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

const placementState = engine.createGame({ boardSize: 10, playerCount: 3, piecesPerPlayer: 4 });
const battleState = engine.createGame({ boardSize: 10, playerCount: 3, piecesPerPlayer: 4, placementMode: 'RANDOM' }, seeded(5));
const roundTrip = (s: unknown) => JSON.parse(JSON.stringify(s)) as unknown;

console.log('\nparseChoice');
await test('accepts clean JSON', () => {
  assert(parseChoice('{"actionIndex": 3, "reasoning": "x"}', 'actionIndex', 5).index === 3, 'index');
});
await test('strips <think> blocks and code fences', () => {
  const r = parseChoice('<think>{"actionIndex": 9}</think>```json\n{"actionIndex": 1, "reasoning": "ok"}\n```', 'actionIndex', 5);
  assert(r.index === 1 && r.reasoning === 'ok', JSON.stringify(r));
});
await test('rejects prose and out-of-range indexes', () => {
  let threw = 0;
  for (const raw of ['move the red one', '{"actionIndex": 7}', '{"actionIndex": -1}', '{"actionIndex": 1.5}']) {
    try {
      parseChoice(raw, 'actionIndex', 5);
    } catch {
      threw++;
    }
  }
  assert(threw === 4, `expected 4 rejections, got ${threw}`);
});

console.log('\nstate validation');
await test('accepts a JSON round-tripped engine state', () => {
  assert(parseGameState(roundTrip(battleState)).ok, 'battle state rejected');
  assert(parseGameState(roundTrip(placementState)).ok, 'placement state rejected');
});
await test('rejects malformed states', () => {
  const bad: unknown[] = [
    null,
    { ...battleState, boardSize: 8 },
    { ...battleState, board: battleState.board.slice(1) },
    { ...battleState, currentPlayer: 'P9' },
    { ...battleState, board: battleState.board.map((r, i) => (i === 0 ? [...r.slice(1), 'LAVA'] : r)) },
    { ...battleState, phase: 'SETUP' },
  ];
  for (const s of bad) assert(!parseGameState(roundTrip(s)).ok, `accepted ${JSON.stringify(s).slice(0, 60)}`);
});

console.log('\noffline bots');
await test('offline:heuristic returns a legal placement and a legal move', async () => {
  const p = await chooseAiTurn(placementState, 'offline:heuristic');
  assert(p.kind === 'placement' && engine.validatePlacement(placementState, p.placement) === null, 'bad placement');
  const m = await chooseAiTurn(battleState, 'offline:heuristic');
  assert(m.kind === 'move' && engine.validateAction(battleState, m.move) === null, 'bad move');
  assert(!m.fallback && m.modelUsed === 'offline:heuristic', 'metadata');
});
await test('offline:random returns legal choices', async () => {
  const m = await chooseAiTurn(battleState, 'offline:random');
  assert(m.kind === 'move' && engine.isValidAction(battleState, m.move), 'bad move');
});
await test('heuristic bot beats random bot in most 6x6 duels', () => {
  let wins = 0;
  const games = 20;
  for (let g = 0; g < games; g++) {
    const rng = seeded(100 + g);
    let s = engine.createGame({ boardSize: 6, playerCount: 2, piecesPerPlayer: 3, placementMode: 'RANDOM' }, rng);
    const heuristicSeat = g % 2 === 0 ? 'P1' : 'P2';
    while (s.status === 'PLAYING') {
      const a = s.currentPlayer === heuristicSeat ? bots.heuristicAction(s) : bots.randomAction(s, rng);
      s = engine.applyAction(s, a!);
    }
    if (s.winner === heuristicSeat) wins++;
  }
  console.log(`      heuristic won ${wins}/${games}`);
  assert(wins >= 15, `heuristic only won ${wins}/${games}`);
});

console.log('\nLLM path (fake provider) & fallback');
const groq = 'groq:llama-3.3-70b-versatile';
await test('valid JSON reply -> uses the LLM choice from the engine shortlist', async () => {
  mode = 'good';
  const r = await chooseAiTurn(battleState, groq);
  const shortlist = bots.rankActions(battleState).slice(0, 20).map((x) => x.choice);
  assert(r.kind === 'move' && !r.fallback && r.modelUsed === groq, JSON.stringify(r));
  assert(JSON.stringify(r.move) === JSON.stringify(shortlist[2]), 'did not map index 2 to the shortlist');
  assert(r.reasoning === 'Fake model: open lines.', 'reasoning');
  assert(lastPrompt.includes('2: move') && lastPrompt.includes('"actionIndex"'), 'prompt lists numbered legal options');
});
await test('placement phase uses placementIndex over engine candidates', async () => {
  mode = 'good';
  const r = await chooseAiTurn(placementState, groq);
  assert(r.kind === 'placement' && !r.fallback && engine.validatePlacement(placementState, r.placement) === null, JSON.stringify(r));
  assert(lastPrompt.includes('Placement phase'), 'placement prompt');
});
await test('<think> + fenced JSON (DeepSeek-R1 style) is parsed', async () => {
  mode = 'think';
  const r = await chooseAiTurn(battleState, groq);
  assert(!r.fallback && r.reasoning === 'after thinking', JSON.stringify(r));
});
for (const [m, needle] of [
  ['garbage', 'not valid JSON'],
  ['out-of-range', 'out of range'],
  ['slow', 'timed out'],
  ['http-429', 'API error 429'],
] as const) {
  await test(`fallback on ${m}`, async () => {
    mode = m;
    const r = await chooseAiTurn(battleState, groq);
    assert(r.fallback && r.modelUsed === 'offline:heuristic', JSON.stringify(r));
    assert(r.reasoning.startsWith('(Fallback:') && r.reasoning.includes(needle), r.reasoning);
    assert(r.kind === 'move' && engine.isValidAction(battleState, r.move), 'fallback move illegal');
    assert(r.latencyMs < 3000, `took ${r.latencyMs}ms`);
  });
}
await test('fallback when the provider has no API key', async () => {
  const r = await chooseAiTurn(placementState, 'openrouter:meta-llama/llama-3.3-70b-instruct:free');
  assert(r.fallback && r.reasoning.includes('no API key configured for openrouter'), r.reasoning);
  assert(r.kind === 'placement' && engine.validatePlacement(placementState, r.placement) === null, 'illegal placement');
});
await test('unknown model id / finished match are rejected', async () => {
  let codes: number[] = [];
  for (const [s, id] of [
    [battleState, 'gpt-nope'],
    [{ ...battleState, status: 'FINISHED' as const }, 'offline:heuristic'],
  ] as const) {
    try {
      await chooseAiTurn(s, id);
    } catch (e) {
      if (e instanceof AiRequestError) codes.push(e.status);
    }
  }
  assert(JSON.stringify(codes) === '[400,409]', JSON.stringify(codes));
});

fake.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`Failures: ${failures.join(', ')}`);

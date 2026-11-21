/**
 * AI service tests. Run with:  npm test   (tsx tests/aiService.test.ts)
 *
 * Uses a local fake OpenAI-compatible server so the LLM path (success, bad JSON,
 * out-of-range index, timeout, HTTP error) is exercised without real API keys.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- fake LLM provider ------------------------------------------------------
type Mode = 'good' | 'think' | 'garbage' | 'out-of-range' | 'slow' | 'http-429' | 'reasoning-only';
let mode: Mode = 'good';
let lastPrompt = '';
let lastBody: Record<string, unknown> = {};
let chatCalls = 0;
let modelsCalls = 0;
let modelsDown = false;
/** Groq-style /models payload (includes non-chat models that must be filtered out). */
const GROQ_MODELS_PAYLOAD = {
  data: [
    { id: 'openai/gpt-oss-120b', active: true, context_window: 131072 },
    { id: 'qwen/qwen3.8-27b', active: true, context_window: 131072 },
    { id: 'whisper-large-v3', active: true },
    { id: 'meta-llama/llama-prompt-guard-2-86m', active: true },
    { id: 'openai/gpt-oss-safeguard-20b', active: true },
    { id: 'canopylabs/orpheus-v1-english', active: true },
    { id: 'old-model', active: false },
  ],
};

const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      modelsCalls++;
      if (modelsDown) res.writeHead(503).end('down');
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(GROQ_MODELS_PAYLOAD));
      return;
    }
    chatCalls++;
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    lastBody = parsed as unknown as Record<string, unknown>;
    // Like Groq's allam-2-7b: reject reasoning_effort with HTTP 400.
    if ('reasoning_effort' in lastBody && String(lastBody.model).includes('rejects-effort')) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: '`reasoning_effort` is not supported with this model' } }));
      return;
    }
    lastPrompt = parsed.messages.at(-1)?.content ?? '';
    const key = lastPrompt.includes('placementIndex') ? 'placementIndex' : 'actionIndex';
    const content: Record<Mode, string> = {
      good: JSON.stringify({ [key]: 2, reasoning: 'Fake model: open lines.' }),
      think: `<think>{"${key}": 99} hmm</think>\n\`\`\`json\n{"${key}": 1, "reasoning": "after thinking"}\n\`\`\``,
      garbage: 'I would move the red totem forward!',
      'out-of-range': JSON.stringify({ [key]: 500, reasoning: 'oops' }),
      slow: '',
      'http-429': '',
      'reasoning-only': '',
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
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message:
                mode === 'reasoning-only'
                  ? { role: 'assistant', content: '', reasoning: `Thinking... option 3 looks best. {"${key}": 3, "reasoning": "from the trace"}` }
                  : { role: 'assistant', content: content[mode] },
            },
          ],
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

const { chooseAiTurn, parseChoice, AiRequestError, requestProfiles } = await import('../src/aiService.js');
const models = await import('../src/models.js');
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

console.log('\nmodel discovery & request compatibility');
await test('Groq filter keeps chat/reasoning models, drops whisper/orpheus/guard/safeguard/inactive', () => {
  const ids = models.filterGroqModels(GROQ_MODELS_PAYLOAD).map((m) => m.model);
  assert(JSON.stringify(ids) === JSON.stringify(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']), JSON.stringify(ids));
});
await test('OpenRouter filter: free text models only, openrouter/free first, expired dropped', () => {
  const payload = {
    data: [
      { id: 'z/zeta:free', name: 'Zeta (free)', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['reasoning'] },
      { id: 'a/alpha', name: 'Alpha', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'paid/model', name: 'Paid', pricing: { prompt: '0.000001', completion: '0.000002' } },
      { id: 'g/lyria:free', name: 'Lyria', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text', 'audio'] } },
      { id: 'old/gone:free', name: 'Gone', pricing: { prompt: '0', completion: '0' }, expiration_date: '2020-01-01' },
      { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' } },
    ],
  };
  const list = models.filterOpenRouterModels(payload);
  assert(JSON.stringify(list.map((m) => m.model)) === JSON.stringify(['openrouter/free', 'a/alpha', 'z/zeta:free']), JSON.stringify(list.map((m) => m.model)));
  assert(list[2]!.label === 'Zeta' && list[2]!.supportedParameters?.includes('reasoning'), 'label / params');
  const noRouter = models.filterOpenRouterModels({ data: [] });
  assert(noRouter.length === 1 && noRouter[0]!.model === 'openrouter/free', 'router always present');
});
await test('catalog: live discovery, 15-min cache, ?refresh, curated fallback when discovery fails', async () => {
  models.resetModelCatalog();
  modelsCalls = 0;
  modelsDown = true;
  const down = await models.getModelCatalog();
  assert(down.discovery?.groq.status === 'fallback' && down.discovery.groq.error === 'HTTP 503', JSON.stringify(down.discovery?.groq));
  assert(down.models.some((m) => m.id === 'groq:openai/gpt-oss-120b' && m.source === 'curated'), 'curated list served');
  modelsDown = false;
  const live = await models.getModelCatalog({ refresh: true });
  assert(live.discovery?.groq.status === 'live' && live.discovery.groq.count === 2, JSON.stringify(live.discovery?.groq));
  assert(live.discovery.openrouter.status === 'no-key', 'openrouter disabled without key');
  const groqIds = live.models.filter((m) => m.provider === 'groq').map((m) => m.id);
  assert(JSON.stringify(groqIds) === JSON.stringify(['groq:openai/gpt-oss-120b', 'groq:qwen/qwen3.8-27b']), JSON.stringify(groqIds));
  const calls = modelsCalls;
  await models.getModelCatalog();
  await models.getModelCatalog({ refresh: true }); // < 10s since the last fetch: served from cache
  assert(modelsCalls === calls, `cache not used (${modelsCalls - calls} extra calls)`);
  assert(models.resolveModel('groq:brand-new-model')?.source === 'custom', 'custom ids accepted');
  assert(models.resolveModel('groq:bad id with spaces') === null, 'invalid custom id rejected');
});
await test('request profiles: no response_format; reasoning disabled/capped/low per provider', () => {
  const p = (id: string) => requestProfiles(models.resolveModel(id)!);
  assert(p('groq:openai/gpt-oss-120b')[0]!.reasoning_effort === 'low', 'gpt-oss low effort');
  assert(p('groq:qwen/qwen3.8-27b')[0]!.reasoning_effort === 'none', 'qwen3 no thinking');
  assert(p('groq:allam-2-7b').every((x) => x.reasoning_effort === undefined), 'plain groq model: no reasoning params');
  const or = p('openrouter:some/model:free');
  assert(or[0]!.reasoning?.enabled === false && or[1]!.reasoning?.max_tokens === 512 && or.at(-1)!.name === 'bare', JSON.stringify(or));
  for (const id of ['groq:openai/gpt-oss-120b', 'openrouter:x/y:free']) {
    assert(p(id).every((x) => !('response_format' in x)), 'never sends response_format');
  }
});
await test('HTTP 400 for an unsupported parameter -> retries without it (no fallback), and remembers', async () => {
  mode = 'good';
  chatCalls = 0;
  const id = 'groq:openai/gpt-oss-rejects-effort';
  const r = await chooseAiTurn(battleState, id);
  assert(!r.fallback && r.modelUsed === id, r.reasoning);
  assert(chatCalls === 2 && !('reasoning_effort' in lastBody) && !('response_format' in lastBody), `calls ${chatCalls}`);
  chatCalls = 0;
  await chooseAiTurn(battleState, id);
  assert(chatCalls === 1, 'working profile not remembered');
});
await test('answer only in the reasoning trace (empty content) is still parsed', async () => {
  mode = 'reasoning-only';
  const r = await chooseAiTurn(battleState, 'groq:openai/gpt-oss-120b');
  assert(!r.fallback && r.reasoning === 'from the trace', JSON.stringify(r));
});

fake.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) throw new Error(`Failures: ${failures.join(', ')}`);

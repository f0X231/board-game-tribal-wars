import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { AiRequestError, chooseAiTurn } from './aiService.js';
import { listModels } from './models.js';
import { parseGameState } from './stateValidation.js';
import { MatchStore } from './matchRecorder.js';
import { parseMatchSubmission } from './matchValidation.js';
import type { ModelsResponse } from '../../shared/apiTypes.js';
import { GameRuleError } from '../../shared/gameEngine.js';
import { matchToCsv, rebuildMatchTelemetry } from '../../shared/telemetry.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.clientOrigins }));
// Match logs are larger than single game states; parse them first (the second parser then skips).
app.use('/api/matches', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '64kb' }));

const matches = new MatchStore(config.matchDataDir);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

/** Available AI models; `available: false` means the provider key is missing from server/.env. */
app.get('/api/models', (_req, res) => {
  const body: ModelsResponse = {
    models: listModels(),
    providers: {
      offline: true,
      openrouter: config.openRouterApiKey !== null,
      groq: config.groqApiKey !== null,
    },
  };
  res.json(body);
});

/**
 * Body: `{ state: GameState, modelId: string }`.
 * Returns `{ kind: 'placement', placement }` or `{ kind: 'move', move }` plus
 * `reasoning`, `modelUsed`, `modelRequested`, `fallback`, `latencyMs`.
 */
app.post('/api/ai-turn', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body: unknown = req.body;
    if (typeof body !== 'object' || body === null) {
      res.status(400).json({ error: 'Expected a JSON body { state, modelId }.' });
      return;
    }
    const { state: rawState, modelId } = body as { state?: unknown; modelId?: unknown };
    if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 160) {
      res.status(400).json({ error: 'modelId must be a non-empty string.' });
      return;
    }
    const parsed = parseGameState(rawState);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await chooseAiTurn(parsed.state, modelId);
    console.log(
      `[ai-turn] ${parsed.state.currentPlayer} ${parsed.state.phase} via ${result.modelUsed}` +
        `${result.fallback ? ` (fallback from ${modelId})` : ''} in ${result.latencyMs}ms`,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Saves a completed match. Body: a `MatchTelemetry` (or `{ meta, decisions }`).
 * The server replays the decisions through the engine and recomputes every metric;
 * client-computed numbers are never trusted. 201 created, 409 duplicate id, 400 invalid/illegal.
 */
app.post('/api/matches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = parseMatchSubmission(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    let telemetry;
    try {
      telemetry = rebuildMatchTelemetry(parsed.meta, parsed.decisions);
    } catch (err) {
      if (err instanceof GameRuleError) {
        res.status(400).json({ error: `Illegal match log: ${err.message}` });
        return;
      }
      throw err;
    }
    if ((await matches.save(telemetry)) === 'exists') {
      res.status(409).json({ error: `Match ${telemetry.matchId} is already recorded.` });
      return;
    }
    console.log(`[matches] saved ${telemetry.matchId} (${telemetry.events.length} decisions, winner ${telemetry.summary.winner ?? 'none'})`);
    res.status(201).json({ matchId: telemetry.matchId, summary: telemetry.summary });
  } catch (err) {
    next(err);
  }
});

/** Summary metadata of every recorded match, newest first. */
app.get('/api/matches', async (_req, res: Response, next: NextFunction) => {
  try {
    const list = await matches.list();
    res.json({ matches: list, count: list.length });
  } catch (err) {
    next(err);
  }
});

/** `?format=json` (default): full nested telemetry. `?format=csv`: flattened turn-by-turn rows. */
app.get('/api/matches/:id/export', async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
  try {
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (format !== 'json' && format !== 'csv') {
      res.status(400).json({ error: 'format must be json or csv' });
      return;
    }
    const match = await matches.load(req.params.id);
    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="tribal-wars-${match.matchId}.${format}"`);
    if (format === 'csv') res.type('text/csv; charset=utf-8').send(matchToCsv(match));
    else res.type('application/json').send(JSON.stringify(match, null, 2));
  } catch (err) {
    next(err);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AiRequestError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'Malformed JSON body.' });
    return;
  }
  // body-parser errors (e.g. 413 payload too large) carry an HTTP status.
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : 0;
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? 'Request body too large.' : 'Bad request.' });
    return;
  }
  console.error('[server] unexpected error', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  const keys = [config.openRouterApiKey ? 'OpenRouter' : null, config.groqApiKey ? 'Groq' : null].filter(Boolean);
  console.log(`Tribal Wars server listening on http://localhost:${config.port}`);
  console.log(`LLM providers: ${keys.length ? keys.join(', ') : 'none (offline bots only)'}`);
});

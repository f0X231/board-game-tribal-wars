import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { AiRequestError, chooseAiTurn } from './aiService.js';
import { listModels } from './models.js';
import { parseGameState } from './stateValidation.js';
import type { ModelsResponse } from '../../shared/apiTypes.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.clientOrigins }));
app.use(express.json({ limit: '64kb' }));

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
  console.error('[server] unexpected error', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  const keys = [config.openRouterApiKey ? 'OpenRouter' : null, config.groqApiKey ? 'Groq' : null].filter(Boolean);
  console.log(`Tribal Wars server listening on http://localhost:${config.port}`);
  console.log(`LLM providers: ${keys.length ? keys.join(', ') : 'none (offline bots only)'}`);
});

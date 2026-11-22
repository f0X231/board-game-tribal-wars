import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

function list(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === '') return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** `/server` package root, whether running from `src/` (tsx) or `dist/server/src/` (built). */
function serverRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distMarker = `${path.sep}dist${path.sep}`;
  const i = here.lastIndexOf(distMarker);
  return i >= 0 ? here.slice(0, i) : path.resolve(here, '..');
}

/** Server configuration. API keys stay in /server/.env and are never sent to the client. */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** Comma-separated list of browser origins allowed by CORS. */
  clientOrigins: list(process.env.CLIENT_ORIGIN) ?? ['http://localhost:3000'],
  openRouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || null,
  groqApiKey: process.env.GROQ_API_KEY?.trim() || null,
  /** Optional overrides for the advertised model lists (free-tier catalogs change often). */
  openRouterModels: list(process.env.OPENROUTER_MODELS),
  groqModels: list(process.env.GROQ_MODELS),
  /** Optional base-URL overrides (proxies / local test doubles). */
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
  groqBaseUrl: process.env.GROQ_BASE_URL?.trim() || 'https://api.groq.com/openai/v1',
  /**
   * Per-turn thinking budget of the `research:*` search bots (ms). Clamped to
   * 100-5000; every turn is also cut off at a hard 5000 ms ceiling.
   */
  botTimeBudgetMs: Number(process.env.BOT_TIME_BUDGET_MS ?? 3500),
  /** Hard limit for one LLM call before falling back to the offline heuristic. */
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 10_000),
  /** Where completed match telemetry is stored (gitignored). */
  matchDataDir: process.env.MATCH_DATA_DIR?.trim() || path.join(serverRoot(), 'data', 'matches'),
} as const;

import type { AiTurnResponse, ApiError, ModelInfo, ModelsResponse } from "@shared/apiTypes";
import type { GameState } from "@shared/gameEngine";
import type { MatchTelemetry } from "@shared/telemetry";

/** Public base URL of the AI Arena server (not a secret; API keys stay on the server). */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Client-side cap on one AI turn request (server already caps LLM calls at ~10s). */
const AI_TURN_TIMEOUT_MS = 15_000;

/** Offline bots, used in the lobby when the server is unreachable (they then run in the browser). */
export const LOCAL_BOTS: ModelInfo[] = [
  { id: "offline:heuristic", provider: "offline", model: "", label: "Heuristic Shaman", available: true, description: "Runs in your browser." },
  { id: "offline:random", provider: "offline", model: "", label: "Random Spirit", available: true, description: "Runs in your browser." },
];

export async function fetchModels(signal?: AbortSignal): Promise<ModelsResponse> {
  const res = await fetch(`${API_URL}/api/models`, { signal });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return (await res.json()) as ModelsResponse;
}

export async function requestAiTurn(state: GameState, modelId: string, signal: AbortSignal): Promise<AiTurnResponse> {
  const res = await fetch(`${API_URL}/api/ai-turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, modelId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(AI_TURN_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error ?? `Server responded ${res.status}`);
  }
  return (await res.json()) as AiTurnResponse;
}

/** Saves a completed match to the server's research archive (the server re-derives all metrics). */
export async function submitMatch(match: MatchTelemetry, signal?: AbortSignal): Promise<"saved" | "duplicate"> {
  const res = await fetch(`${API_URL}/api/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(match),
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
  });
  if (res.status === 409) return "duplicate";
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error ?? `Server responded ${res.status}`);
  }
  return "saved";
}

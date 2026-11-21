import { matchToCsv, type MatchTelemetry } from "@shared/telemetry";

function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Full nested research log (board snapshots, Voronoi progression, reasoning, think times). */
export function exportMatchJson(match: MatchTelemetry): void {
  download(`tribal-wars-${match.matchId}.json`, JSON.stringify(match, null, 2), "application/json");
}

/** Flattened turn-by-turn CSV (same columns as the server's `?format=csv`). */
export function exportMatchCsv(match: MatchTelemetry): void {
  download(`tribal-wars-${match.matchId}.csv`, matchToCsv(match), "text/csv;charset=utf-8");
}

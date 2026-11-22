"use client";

import { useEffect, useRef } from "react";
import type { GameState } from "@shared/gameEngine";
import type { MatchTelemetry } from "@shared/telemetry";
import { exportMatchCsv, exportMatchJson } from "@/lib/download";
import { TRIBES } from "@/lib/tribes";
import type { SaveStatus } from "@/lib/useLocalMatch";
import { FireToken, Totem } from "./art";

const SAVE_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "Saving to the research archive…",
  saved: "✓ Saved to the research archive (server/data/matches)",
  offline: "Server unreachable: not archived. Use the export buttons to keep this match.",
};

/** Final territory per tribe: Queen/King Voronoi cells and enemy-free (exclusive) regions. */
function AnalyticsSummary({ telemetry }: { telemetry: MatchTelemetry }) {
  const { seats } = telemetry.summary;
  const empty = telemetry.finalMetrics.emptyCells;
  const rows = [...seats].sort((a, b) => a.placing - b.placing);
  return (
    <section aria-labelledby="analytics-title" className="mt-5 rounded-lg border border-stone-700 bg-stone-950/60 p-3 text-left">
      <h3 id="analytics-title" className="font-display text-xs font-bold uppercase tracking-[0.3em] text-gold">
        Post-match analytics
      </h3>
      <table className="mt-2 w-full text-xs tabular-nums">
        <thead>
          <tr className="text-stone-400">
            <th scope="col" className="py-1 text-left font-semibold">Tribe</th>
            <th scope="col" className="py-1 text-right font-semibold" title="Empty squares reached in strictly fewer Queen moves than any rival">Queen</th>
            <th scope="col" className="py-1 text-right font-semibold" title="Empty squares reached in strictly fewer King steps than any rival">King</th>
            <th scope="col" className="py-1 text-right font-semibold" title="Empty squares in regions no rival totem borders">Exclusive</th>
            <th scope="col" className="py-1 text-right font-semibold" title="Average Queen territory over all battle turns">Avg Q</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const tribe = TRIBES[s.player];
            const share = empty > 0 ? Math.round((100 * s.finalExclusiveSafe) / empty) : 0;
            return (
              <tr key={s.player} className="border-t border-stone-800">
                <th scope="row" className="py-1.5 text-left font-semibold" style={{ color: tribe.accent }}>
                  <span className="flex items-center gap-1.5">
                    <Totem tribe={s.player} className="h-5 w-5 shrink-0" />
                    <span className="truncate">
                      {tribe.short}
                      <span className="ml-1 font-normal text-stone-500">{s.modelId ?? "human"}</span>
                    </span>
                  </span>
                </th>
                <td className="py-1.5 text-right text-stone-200">{s.finalQueenVoronoi}</td>
                <td className="py-1.5 text-right text-stone-200">{s.finalKingVoronoi}</td>
                <td className="py-1.5 text-right text-stone-200">
                  {s.finalExclusiveSafe}
                  <span className="ml-1 text-stone-500">({share}%)</span>
                </td>
                <td className="py-1.5 text-right text-stone-200">{s.avgQueenVoronoi}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-stone-500">
        {telemetry.events.length} decisions recorded · {telemetry.finalMetrics.fireTileCount} fire tiles (
        {Math.round(telemetry.finalMetrics.fireCoverageRatio * 100)}% of the board) · match {telemetry.matchId}
      </p>
    </section>
  );
}

export function VictoryModal({
  game,
  telemetry,
  saveStatus,
  saveError,
  onRematch,
  onLobby,
}: {
  game: GameState;
  telemetry: MatchTelemetry | null;
  saveStatus: SaveStatus;
  saveError?: string | undefined;
  onRematch: () => void;
  onLobby: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const winner = game.winner ? TRIBES[game.winner] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="victory-title">
      <div
        className="stone-frame relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl px-5 pb-6 pt-10 text-center sm:px-6"
        style={winner ? { boxShadow: `0 0 80px -10px ${winner.base}, inset 0 0 0 2px #3a302a, inset 0 0 0 8px rgba(231,184,80,0.35)` } : undefined}
      >
        <div className="absolute left-1/2 top-0 flex -translate-x-1/2 -translate-y-1/2 gap-2">
          <FireToken className="h-10 w-10" />
          <FireToken className="h-12 w-12" />
          <FireToken className="h-10 w-10" />
        </div>
        <p className="font-display text-xs font-bold uppercase tracking-[0.45em] text-orange-300">Fight for your tribe</p>
        <h2 id="victory-title" className="font-display mt-2 text-3xl font-black text-gold">
          {winner ? "Victory!" : "The fire consumed all"}
        </h2>
        {winner && (
          <>
            <Totem tribe={winner.id} className="totem-drop mx-auto mt-4 h-28 w-28" />
            <p className="font-display mt-2 text-2xl font-bold" style={{ color: winner.accent }}>
              {winner.name}
            </p>
          </>
        )}
        <p className="mt-2 text-sm text-stone-300">
          Last tribe standing after {game.turnNumber} turns of fire.
          {game.eliminated.length > 0 && (
            <>
              {" "}
              Fallen: {game.eliminated.map((p) => TRIBES[p].short).join(", ")}.
            </>
          )}
        </p>
        {telemetry && (
          <>
            <AnalyticsSummary telemetry={telemetry} />
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => exportMatchJson(telemetry)}
                className="rounded-md border border-gold/50 bg-amber-950/60 px-3 py-2 text-sm font-semibold text-gold transition hover:bg-amber-950/80"
              >
                ⤓ Export Research JSON
              </button>
              <button
                type="button"
                onClick={() => exportMatchCsv(telemetry)}
                className="rounded-md border border-gold/50 bg-amber-950/60 px-3 py-2 text-sm font-semibold text-gold transition hover:bg-amber-950/80"
              >
                ⤓ Export CSV
              </button>
            </div>
            <p role="status" className={`mt-2 text-xs ${saveStatus === "offline" ? "text-orange-300" : "text-stone-400"}`} title={saveError}>
              {SAVE_TEXT[saveStatus]}
            </p>
          </>
        )}
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            ref={ref}
            type="button"
            onClick={onRematch}
            className="font-display rounded-lg border-2 border-[#451a03] bg-gradient-to-b from-[#b45309] to-[#7c2d12] px-4 py-3 font-bold uppercase tracking-widest text-[#fde68a] transition hover:brightness-110"
          >
            Rematch
          </button>
          <button
            type="button"
            onClick={onLobby}
            className="font-display rounded-lg border-2 border-stone-600 bg-stone-800 px-4 py-3 font-bold uppercase tracking-widest text-stone-200 transition hover:bg-stone-700"
          >
            Lobby
          </button>
        </div>
      </div>
    </div>
  );
}

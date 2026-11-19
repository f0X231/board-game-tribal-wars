"use client";

import { useEffect, useRef } from "react";
import type { GameState } from "@shared/gameEngine";
import { TRIBES } from "@/lib/tribes";
import { FireToken, Totem } from "./art";

export function VictoryModal({ game, onRematch, onLobby }: { game: GameState; onRematch: () => void; onLobby: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const winner = game.winner ? TRIBES[game.winner] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="victory-title">
      <div
        className="stone-frame relative w-full max-w-md rounded-2xl px-6 pb-7 pt-10 text-center"
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
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
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

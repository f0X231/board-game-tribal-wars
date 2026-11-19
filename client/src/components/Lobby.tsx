"use client";

import { useState } from "react";
import {
  ALL_PLAYERS,
  BOARD_SIZES,
  getPieceLimits,
  validateConfig,
  type BoardSize,
  type GameConfig,
  type PlacementMode,
  type PlayerCount,
} from "@shared/gameEngine";
import { TRIBES } from "@/lib/tribes";
import { Totem } from "./art";

interface LobbyProps {
  initial: GameConfig;
  onStart: (config: GameConfig) => void;
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  render,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<T>;
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink/80">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={String(opt)}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt)}
              className={`font-display min-w-14 rounded-md border-2 px-4 py-2 text-base font-bold transition ${
                active
                  ? "border-[#7c2d12] bg-[#7c2d12] text-[#fde68a] shadow-[inset_0_-3px_0_rgba(0,0,0,0.35)]"
                  : "border-ink/30 bg-white/25 text-ink hover:border-[#7c2d12]/70 hover:bg-white/40"
              }`}
            >
              {render ? render(opt) : String(opt)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Lobby({ initial, onStart }: LobbyProps) {
  const [boardSize, setBoardSize] = useState<BoardSize>(initial.boardSize);
  const [playerCount, setPlayerCount] = useState<PlayerCount>(initial.playerCount);
  const [pieces, setPieces] = useState<number>(initial.piecesPerPlayer);
  const [mode, setMode] = useState<PlacementMode>(initial.placementMode ?? "MANUAL");

  const limits = getPieceLimits(boardSize);
  const pieceOptions = Array.from({ length: limits.max - limits.min + 1 }, (_, i) => limits.min + i);

  const changeBoard = (size: BoardSize) => {
    setBoardSize(size);
    const l = getPieceLimits(size);
    setPieces((p) => Math.min(l.max, Math.max(l.min, p)));
  };

  const config: GameConfig = { boardSize, playerCount, piecesPerPlayer: pieces, placementMode: mode };
  const errors = validateConfig(config);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <div className="scroll-rod mx-[-12px] h-5 rounded-full" />
      <section className="parchment relative px-6 py-8 sm:px-12 sm:py-10">
        <header className="text-center">
          <p className="font-display text-xs font-bold uppercase tracking-[0.45em] text-[#7c2d12]">The Ritual of Fire</p>
          <h1 className="font-display mt-2 text-4xl font-black tracking-wide text-ink sm:text-5xl">Tribal Wars</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink/80">
            Move like a queen, leave fire in your wake, and loose a burning arrow every turn. The last tribe that can still
            fight claims the land.
          </p>
        </header>

        <div className="my-6 flex items-end justify-center gap-3 sm:gap-6">
          {ALL_PLAYERS.map((p, i) => {
            const joined = i < playerCount;
            return (
              <div key={p} className={`flex flex-col items-center transition ${joined ? "" : "opacity-30 grayscale"}`}>
                <Totem tribe={p} className="h-14 w-14 sm:h-16 sm:w-16" />
                <span className="font-display mt-1 text-[11px] font-bold" style={{ color: TRIBES[p].dark }}>
                  {TRIBES[p].short}
                </span>
              </div>
            );
          })}
        </div>

        <div className="space-y-6">
          <Segmented
            label="Battleground"
            value={boardSize}
            options={BOARD_SIZES}
            onChange={changeBoard}
            render={(v) => `${v} × ${v}`}
          />
          <Segmented label="Tribes" value={playerCount} options={[2, 3, 4] as const} onChange={setPlayerCount} />
          <Segmented
            label={`Totems per tribe (${limits.min}–${limits.max} on ${boardSize}×${boardSize})`}
            value={pieces}
            options={pieceOptions}
            onChange={setPieces}
          />
          <fieldset>
            <legend className="font-display mb-2 text-sm font-bold uppercase tracking-[0.2em] text-ink/80">Totem placement</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["MANUAL", "Manual Snake Draft", "Tribes take turns raising one totem at a time in snake order. The last to place strikes first."],
                  ["RANDOM", "Quick Random Spawn", "The draft is completed for you at random. Jump straight into battle."],
                ] as const
              ).map(([value, title, desc]) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMode(value)}
                    className={`rounded-lg border-2 p-3 text-left transition ${
                      active ? "border-[#7c2d12] bg-[#7c2d12]/10 shadow-[inset_0_0_0_1px_#7c2d12]" : "border-ink/25 bg-white/20 hover:border-[#7c2d12]/60"
                    }`}
                  >
                    <span className="font-display block font-bold text-ink">{title}</span>
                    <span className="mt-1 block text-xs leading-snug text-ink/75">{desc}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {errors.length > 0 && <p className="mt-4 text-sm font-semibold text-red-800">{errors.join(" ")}</p>}

        <button
          type="button"
          disabled={errors.length > 0}
          onClick={() => onStart(config)}
          className="font-display mt-8 w-full rounded-lg border-2 border-[#451a03] bg-gradient-to-b from-[#b45309] via-[#9a3412] to-[#7c2d12] px-6 py-4 text-lg font-black uppercase tracking-[0.25em] text-[#fde68a] shadow-[0_6px_0_#451a03,0_10px_20px_rgba(0,0,0,0.35)] transition hover:brightness-110 active:translate-y-1 active:shadow-[0_2px_0_#451a03] disabled:opacity-50"
        >
          Begin the Ritual
        </button>
      </section>
      <div className="scroll-rod mx-[-12px] h-5 rounded-full" />
    </div>
  );
}

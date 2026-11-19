"use client";

import type { GameConfig } from "@shared/gameEngine";
import { useLocalMatch } from "@/lib/useLocalMatch";
import { Board } from "./Board";
import { BattleLog, PhaseBanner, TribeRoster } from "./Hud";
import { VictoryModal } from "./VictoryModal";

export function MatchScreen({ config, onLobby }: { config: GameConfig; onLobby: () => void }) {
  const match = useLocalMatch(config);
  const { game, turn, log } = match;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 lg:flex-row lg:items-start lg:py-10">
      <div className="flex flex-1 justify-center pt-4">
        <Board game={game} turn={turn} getHints={match.getHints} onCellClick={match.clickCell} />
      </div>

      <aside className="flex w-full flex-col gap-4 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-80">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-xl font-black tracking-wide text-gold">Tribal Wars</h1>
          <span className="text-xs text-stone-400">
            {game.boardSize}×{game.boardSize} · Turn {game.turnNumber}
          </span>
        </div>
        <PhaseBanner game={game} turn={turn} onCancel={match.cancel} />
        <TribeRoster game={game} />
        <BattleLog log={log} />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => match.start(match.config)}
            className="rounded-md border border-stone-600 bg-stone-800 px-3 py-2 text-sm font-semibold text-stone-200 transition hover:bg-stone-700"
          >
            ⟲ Reset
          </button>
          <button
            type="button"
            onClick={onLobby}
            className="rounded-md border border-stone-600 bg-stone-800 px-3 py-2 text-sm font-semibold text-stone-200 transition hover:bg-stone-700"
          >
            ← Back to Lobby
          </button>
        </div>
      </aside>

      {game.status === "FINISHED" && (
        <VictoryModal game={game} onRematch={() => match.start(match.config)} onLobby={onLobby} />
      )}
    </div>
  );
}

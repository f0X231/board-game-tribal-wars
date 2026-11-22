"use client";

import { useEffect, useRef } from "react";
import { isResearchModelId } from "@shared/apiTypes";
import { getPiecesToPlace, getPlayerPieces, hasValidAction, type GameState } from "@shared/gameEngine";
import type { LogEntry, TurnStep } from "@/lib/useLocalMatch";
import { controllerLabel, type SlotController } from "@/lib/matchConfig";
import type { PlayerId } from "@shared/gameEngine";
import { TRIBES } from "@/lib/tribes";
import { Totem } from "./art";

const STEP_HELP: Record<TurnStep["step"], { title: string; text: string }> = {
  SELECT_PIECE: { title: "Step 1 · Choose a totem", text: "Select one of your glowing totems that can still fight." },
  SELECT_MOVE: { title: "Step 2 · Move", text: "Pick a glowing rune. Totems move like a queen and cannot cross fire or other totems." },
  SELECT_SHOOT: { title: "Step 3 · Loose the fire arrow", text: "Your old square is now burning. Choose a fiery target to shoot." },
};

export function PhaseBanner({
  game,
  turn,
  onCancel,
  controller,
  aiThinking,
  paused,
}: {
  game: GameState;
  turn: TurnStep;
  onCancel: () => void;
  controller: SlotController;
  aiThinking: boolean;
  paused: boolean;
}) {
  const isAi = controller.type === "ai";
  const deep = isAi && isResearchModelId(controller.modelId);
  const finished = game.status === "FINISHED";
  const tribe = TRIBES[finished && game.winner ? game.winner : game.currentPlayer];
  const phaseLabel = finished ? "FINISHED" : game.phase === "PLACEMENT" ? "PLACEMENT" : "BATTLE";
  const help = isAi
    ? paused
      ? { title: "AI paused", text: `${controllerLabel(controller)} is waiting. Press "Resume AI" to continue.` }
      : deep
        ? {
            title: "Thinking deeply (3–5s)…",
            text:
              game.phase === "PLACEMENT"
                ? `${controllerLabel(controller)} is searching the snake draft for the best totem square.`
                : `${controllerLabel(controller)} is running its deep search (iterative deepening / MCTS) within the turn budget.`,
          }
        : {
            title: `${controllerLabel(controller)} is thinking…`,
            text: game.phase === "PLACEMENT" ? "Choosing where to raise a totem." : "Weighing moves and fire arrows from the engine's legal options.",
          }
    : game.phase === "PLACEMENT"
      ? {
          title: `Raise a totem (${game.placementIndex + 1} of ${game.placementOrder.length})`,
          text: "Click any empty square to deploy a totem. Draft order snakes back and forth.",
        }
      : STEP_HELP[turn.step];

  return (
    <div
      className="relative overflow-hidden rounded-xl border-2 p-4"
      style={{ borderColor: tribe.base, background: `linear-gradient(120deg, ${tribe.dark}, #1c1917 70%)` }}
    >
      <div className="flex items-center gap-3">
        <Totem tribe={tribe.id} className="h-14 w-14 shrink-0" />
        <div className="min-w-0 flex-1">
          <span
            className={`font-display inline-block rounded px-2 py-0.5 text-[10px] font-bold tracking-[0.3em] ${
              phaseLabel === "BATTLE" ? "bg-red-900/80 text-orange-200" : phaseLabel === "PLACEMENT" ? "bg-amber-900/80 text-amber-200" : "bg-stone-700 text-stone-200"
            }`}
          >
            {phaseLabel}
          </span>
          <p className="font-display mt-1 truncate text-lg font-bold" style={{ color: tribe.accent }}>
            {finished ? (game.winner ? `${tribe.name} wins` : "No survivors") : `${tribe.name}'s turn`}
          </p>
          {!finished && <p className="truncate text-[11px] text-stone-400">{isAi ? `🤖 ${controllerLabel(controller)}` : "🧑 Human"}</p>}
        </div>
      </div>
      {!finished && (
        <div className="mt-3 border-t border-white/10 pt-3">
          <p className="font-display flex items-center gap-2 text-sm font-bold text-gold">
            {aiThinking && <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gold border-t-transparent" aria-hidden="true" />}
            {help.title}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-300">{help.text}</p>
          {!isAi && turn.step === "SELECT_SHOOT" && (
            <button
              type="button"
              onClick={onCancel}
              className="mt-3 w-full rounded-md border border-stone-500 bg-stone-800 px-3 py-2 text-sm font-semibold text-stone-100 transition hover:bg-stone-700"
            >
              ↩ Cancel Move
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TribeRoster({ game, slots }: { game: GameState; slots: Record<PlayerId, SlotController> }) {
  return (
    <ul className="space-y-2">
      {game.players.map((p) => {
        const t = TRIBES[p];
        const out = game.eliminated.includes(p);
        const current = game.status === "PLAYING" && game.currentPlayer === p;
        const onBoard = getPlayerPieces(game.board, p);
        const mobile = game.phase === "PLAYING" ? onBoard.filter((pos) => hasValidActionFrom(game, pos)).length : onBoard.length;
        const toPlace = getPiecesToPlace(game, p);
        let status: string;
        if (game.winner === p) status = "Victorious";
        else if (out) status = "Eliminated";
        else if (game.phase === "PLACEMENT") status = `${toPlace} to place`;
        else status = `${mobile}/${onBoard.length} can fight`;

        return (
          <li
            key={p}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${
              current ? "border-gold/70 bg-white/[0.07]" : "border-white/10 bg-black/20"
            } ${out ? "opacity-45 grayscale" : ""}`}
          >
            <Totem tribe={p} className="h-9 w-9 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-display truncate text-sm font-bold" style={{ color: t.accent }}>
                {t.name}
              </p>
              <p className="truncate text-[11px] text-stone-400">
                {slots[p].type === "ai" ? "🤖" : "🧑"} {controllerLabel(slots[p])} · {status}
              </p>
            </div>
            {game.phase === "PLACEMENT" && !out && (
              <div className="flex gap-0.5" aria-label={`${toPlace} totems left to place`}>
                {Array.from({ length: game.piecesPerPlayer }, (_, i) => (
                  <span
                    key={i}
                    className="h-3 w-1.5 rounded-sm"
                    style={{ background: i < game.piecesPerPlayer - toPlace ? t.base : "rgba(255,255,255,0.15)" }}
                  />
                ))}
              </div>
            )}
            {current && <span className="text-gold" aria-label="Current turn">◆</span>}
            {out && <span aria-label="Eliminated">🔥</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** True if the piece at `pos` can make at least one complete turn (move + shot). */
function hasValidActionFrom(game: GameState, pos: { row: number; col: number }): boolean {
  const owner = game.board[pos.row]?.[pos.col];
  if (owner === undefined || owner === "EMPTY" || owner === "FIRE") return false;
  // Turn the owner's other pieces into fire: they block exactly the same squares,
  // but no longer count as this player's pieces, so only `pos` is evaluated.
  const board = game.board.map((row, r) =>
    row.map((cell, c) => (cell === owner && !(r === pos.row && c === pos.col) ? ("FIRE" as const) : cell)),
  );
  return hasValidAction(board, owner);
}

export function BattleLog({ log }: { log: LogEntry[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [log.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-white/10 bg-black/30">
      <h2 className="font-display border-b border-white/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.25em] text-gold/80">
        Battle Log
      </h2>
      <ol ref={listRef} className="max-h-64 min-h-24 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-xs lg:max-h-none" aria-live="polite">
        {log.map((e) =>
          e.kind === "ai-reasoning" ? (
            <li key={e.id} className="ml-4 border-l-2 pl-2 leading-snug" style={{ borderColor: e.player ? TRIBES[e.player].base : "#a8a29e" }}>
              <span className="mr-1 font-semibold text-stone-400">
                🤖 {e.model}
                {e.fallback && <span className="ml-1 rounded bg-orange-900/70 px-1 text-[10px] text-orange-200">fallback</span>}:
              </span>
              <span className="italic text-stone-300">“{e.text}”</span>
            </li>
          ) : (
          <li key={e.id} className="flex gap-2 leading-snug">
            <span
              className="mt-1 h-2 w-2 shrink-0 rounded-full"
              style={{ background: e.player ? TRIBES[e.player].base : "#a8a29e" }}
            />
            <span
              className={
                e.kind === "eliminated"
                  ? "font-semibold text-orange-300"
                  : e.kind === "victory"
                    ? "font-bold text-gold"
                    : e.kind === "battle-start"
                      ? "font-semibold text-amber-200"
                      : "text-stone-300"
              }
            >
              {e.text}
            </span>
          </li>
          ),
        )}
      </ol>
    </div>
  );
}

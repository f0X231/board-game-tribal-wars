"use client";

import type { Cell, GameState, Position } from "@shared/gameEngine";
import { isPlayerId, samePosition } from "@shared/gameEngine";
import type { CellHints, TurnStep } from "@/lib/useLocalMatch";
import { TRIBES, coord } from "@/lib/tribes";
import { ArrowGlyph, FireToken, Spear, Torch, Totem } from "./art";

interface BoardProps {
  game: GameState;
  turn: TurnStep;
  getHints: (pos: Position) => CellHints;
  onCellClick: (pos: Position) => void;
}

/** What a square shows, including the SELECT_SHOOT preview (totem at `to`, fire at `from`). */
function displayCell(game: GameState, turn: TurnStep, pos: Position): { cell: Cell; preview: boolean } {
  const actual = game.board[pos.row]![pos.col]!;
  if (turn.step === "SELECT_SHOOT") {
    if (samePosition(turn.from, pos)) return { cell: "FIRE", preview: true };
    if (samePosition(turn.to, pos)) return { cell: game.currentPlayer, preview: true };
  }
  return { cell: actual, preview: false };
}

export function Board({ game, turn, getHints, onCellClick }: BoardProps) {
  const n = game.boardSize;
  const last = game.lastAction;
  const labelSize = n >= 10 ? "text-[9px] sm:text-[10px]" : "text-[10px] sm:text-xs";

  return (
    <div className="stone-frame relative w-full max-w-[650px] rounded-2xl p-5 sm:p-8">
      {/* frame ornaments */}
      <div className="fret-band pointer-events-none absolute inset-x-10 top-1.5 h-2" />
      <div className="fret-band pointer-events-none absolute inset-x-10 bottom-1.5 h-2" />
      <Spear className="pointer-events-none absolute left-1/2 top-[-10px] h-4 w-2/3 -translate-x-1/2 opacity-90" />
      <Spear className="pointer-events-none absolute bottom-[-10px] left-1/2 h-4 w-2/3 -translate-x-1/2 rotate-180 opacity-90" />
      {[
        "left-[-14px] top-[-34px]",
        "right-[-14px] top-[-34px]",
        "left-[-14px] bottom-[-14px]",
        "right-[-14px] bottom-[-14px]",
      ].map((p) => (
        <Torch key={p} className={`pointer-events-none absolute hidden h-16 w-7 sm:block ${p}`} />
      ))}

      {/* column labels */}
      <div
        className={`font-display mb-1 ml-4 grid text-center text-gold/70 ${labelSize}`}
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: n }, (_, c) => (
          <span key={c}>{String.fromCharCode(65 + c)}</span>
        ))}
      </div>

      <div className="flex">
        {/* row labels */}
        <div className={`font-display mr-1 grid w-3 text-center text-gold/70 ${labelSize}`} style={{ gridTemplateRows: `repeat(${n}, minmax(0, 1fr))` }}>
          {Array.from({ length: n }, (_, r) => (
            <span key={r} className="flex items-center justify-center">
              {r + 1}
            </span>
          ))}
        </div>

        <div
          role="grid"
          aria-label={`${n} by ${n} battleground`}
          className="grid aspect-square w-full overflow-hidden rounded-md border-2 border-gold-deep/70 shadow-[0_0_0_3px_#0c0a09]"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {game.board.map((row, r) =>
            row.map((_, c) => {
              const pos = { row: r, col: c };
              const hints = getHints(pos);
              const { cell, preview } = displayCell(game, turn, pos);
              const dark = (r + c) % 2 === 1;
              const isLastTo = last !== null && samePosition(last.to, pos) && !preview;
              const isFreshFire =
                last !== null && cell === "FIRE" && !preview && (samePosition(last.from, pos) || samePosition(last.shoot, pos));
              const interactive = hints.placeable || hints.movable || hints.moveTarget || hints.shootTarget || hints.selected;

              const classes = [
                "tile group flex items-center justify-center outline-none transition-[filter] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-gold",
                dark ? "tile-obsidian" : "tile-ochre",
                interactive ? "cursor-pointer hover:brightness-110" : "cursor-default",
                hints.selected ? "selected-piece" : hints.movable && turn.step === "SELECT_PIECE" ? "movable" : "",
                hints.shootTarget ? "shoot-target" : "",
                isLastTo ? "shadow-[inset_0_0_0_2px_rgba(253,230,138,0.35)]" : "",
              ].join(" ");

              const label = [
                coord(pos),
                cell === "FIRE" ? "fire" : isPlayerId(cell) ? TRIBES[cell].name : "empty",
                hints.placeable ? "place totem" : "",
                hints.moveTarget ? "move here" : "",
                hints.shootTarget ? "shoot fire arrow here" : "",
              ]
                .filter(Boolean)
                .join(", ");

              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  role="gridcell"
                  aria-label={label}
                  className={classes}
                  onClick={() => onCellClick(pos)}
                  tabIndex={interactive ? 0 : -1}
                >
                  {cell === "FIRE" && (
                    <FireToken
                      key={isFreshFire ? `fresh-${game.turnNumber}` : "fire"}
                      className={`h-[86%] w-[86%] ${isFreshFire ? "ignite" : ""} ${preview ? "opacity-90" : ""}`}
                    />
                  )}
                  {isPlayerId(cell) && (
                    <Totem
                      key={preview ? "preview" : `${cell}-${isLastTo ? game.turnNumber : "still"}`}
                      tribe={cell}
                      className={`h-[92%] w-[92%] drop-shadow-[0_3px_3px_rgba(0,0,0,0.6)] ${preview || isLastTo ? "totem-drop" : ""}`}
                    />
                  )}
                  {cell === "EMPTY" && hints.placeable && (
                    <Totem
                      tribe={game.currentPlayer}
                      className="h-[88%] w-[88%] opacity-0 transition-opacity duration-150 group-hover:opacity-55 group-focus-visible:opacity-55"
                    />
                  )}
                  {hints.moveTarget && <span className="move-rune pointer-events-none" />}
                  {hints.shootTarget && <ArrowGlyph className="pointer-events-none h-[48%] w-[48%] drop-shadow-[0_0_6px_rgba(249,115,22,0.9)]" />}
                </button>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}

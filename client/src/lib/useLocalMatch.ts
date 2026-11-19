"use client";

import { useCallback, useMemo, useReducer } from "react";
import {
  applyAction,
  createGame,
  getValidActions,
  validatePlacement,
  placePiece,
  samePosition,
  type GameConfig,
  type GameState,
  type MoveAction,
  type PlayerId,
  type Position,
} from "@shared/gameEngine";
import { TRIBES, coord } from "./tribes";

/** Local 3-step turn UX state (only meaningful during the battle phase). */
export type TurnStep =
  | { step: "SELECT_PIECE" }
  | { step: "SELECT_MOVE"; from: Position }
  | { step: "SELECT_SHOOT"; from: Position; to: Position };

export type LogKind = "setup" | "place" | "battle-start" | "move" | "eliminated" | "victory";

export interface LogEntry {
  id: number;
  kind: LogKind;
  player: PlayerId | null;
  text: string;
}

interface MatchState {
  config: GameConfig;
  game: GameState;
  turn: TurnStep;
  log: LogEntry[];
  nextLogId: number;
}

type MatchEvent =
  | { type: "START"; config: GameConfig; game: GameState }
  | { type: "PLACE"; pos: Position }
  | { type: "SELECT_PIECE"; from: Position }
  | { type: "SELECT_MOVE"; to: Position }
  | { type: "SHOOT"; shoot: Position }
  | { type: "CANCEL" };

function withLog(state: MatchState, entries: Array<Omit<LogEntry, "id">>): Pick<MatchState, "log" | "nextLogId"> {
  let id = state.nextLogId;
  const added = entries.map((e) => ({ ...e, id: id++ }));
  return { log: [...state.log, ...added], nextLogId: id };
}

/** Log lines describing what changed between two engine states (eliminations, battle start, victory). */
function transitionLogs(prev: GameState, next: GameState): Array<Omit<LogEntry, "id">> {
  const out: Array<Omit<LogEntry, "id">> = [];
  if (prev.phase === "PLACEMENT" && next.phase === "PLAYING") {
    out.push({
      kind: "battle-start",
      player: next.currentPlayer,
      text: `All totems stand. The battle begins: the ${TRIBES[next.currentPlayer].name} placed the last totem and strikes first.`,
    });
  }
  for (const p of next.eliminated) {
    if (!prev.eliminated.includes(p)) {
      out.push({ kind: "eliminated", player: p, text: `The ${TRIBES[p].name} is trapped by fire and has fallen!` });
    }
  }
  if (prev.status === "PLAYING" && next.status === "FINISHED") {
    out.push(
      next.winner
        ? { kind: "victory", player: next.winner, text: `The ${TRIBES[next.winner].name} is the last tribe standing!` }
        : { kind: "victory", player: null, text: "No tribe survives the flames." },
    );
  }
  return out;
}

function startState(config: GameConfig, game: GameState): MatchState {
  const fresh: MatchState = { config, game, turn: { step: "SELECT_PIECE" }, log: [], nextLogId: 1 };
  const { boardSize, playerCount, piecesPerPlayer, placementMode } = config;
  const entries: Array<Omit<LogEntry, "id">> = [
    {
      kind: "setup",
      player: null,
      text: `${boardSize}x${boardSize} battleground, ${playerCount} tribes, ${piecesPerPlayer} totems each (${placementMode === "RANDOM" ? "quick random spawn" : "snake draft"}).`,
    },
  ];
  if (game.phase === "PLAYING") {
    entries.push({
      kind: "battle-start",
      player: game.currentPlayer,
      text: `Totems spawned at random. The ${TRIBES[game.currentPlayer].name} placed the last totem and strikes first.`,
    });
  }
  return { ...fresh, ...withLog(fresh, entries) };
}

function reducer(state: MatchState, event: MatchEvent): MatchState {
  const { game } = state;
  switch (event.type) {
    case "START":
      return startState(event.config, event.game);
    case "PLACE": {
      if (validatePlacement(game, event.pos) !== null) return state;
      const next = placePiece(game, event.pos);
      return {
        ...state,
        game: next,
        turn: { step: "SELECT_PIECE" },
        ...withLog(state, [
          { kind: "place", player: game.currentPlayer, text: `${TRIBES[game.currentPlayer].short} raised a totem at ${coord(event.pos)}.` },
          ...transitionLogs(game, next),
        ]),
      };
    }
    case "SELECT_PIECE":
      return { ...state, turn: { step: "SELECT_MOVE", from: event.from } };
    case "SELECT_MOVE":
      if (state.turn.step !== "SELECT_MOVE") return state;
      return { ...state, turn: { step: "SELECT_SHOOT", from: state.turn.from, to: event.to } };
    case "SHOOT": {
      if (state.turn.step !== "SELECT_SHOOT") return state;
      const action: MoveAction = { from: state.turn.from, to: state.turn.to, shoot: event.shoot };
      const next = applyAction(game, action);
      const mover = game.currentPlayer;
      return {
        ...state,
        game: next,
        turn: { step: "SELECT_PIECE" },
        ...withLog(state, [
          {
            kind: "move",
            player: mover,
            text: `${TRIBES[mover].short} moved ${coord(action.from)} → ${coord(action.to)}, fire arrow at ${coord(action.shoot)}.`,
          },
          ...transitionLogs(game, next),
        ]),
      };
    }
    case "CANCEL":
      return { ...state, turn: { step: "SELECT_PIECE" } };
  }
}

export interface CellHints {
  /** Own piece that has at least one legal full turn. */
  movable: boolean;
  selected: boolean;
  moveTarget: boolean;
  shootTarget: boolean;
  placeable: boolean;
}

/** Local pass-and-play match: engine state + 3-step turn UX + battle log. */
export function useLocalMatch(initialConfig: GameConfig) {
  // Lazy init: createGame (and its Math.random for RANDOM spawn) runs once on mount, never during SSR.
  const [state, dispatch] = useReducer(reducer, initialConfig, (config) => startState(config, createGame(config)));
  const { game, turn } = state;

  const actions = useMemo(() => getValidActions(game), [game]);

  const hints = useMemo(() => {
    const key = (p: Position) => p.row * game.boardSize + p.col;
    const movable = new Set<number>();
    const moveTargets = new Set<number>();
    const shootTargets = new Set<number>();
    for (const a of actions) {
      movable.add(key(a.from));
      if (turn.step !== "SELECT_PIECE" && samePosition(a.from, turn.from)) {
        moveTargets.add(key(a.to));
        if (turn.step === "SELECT_SHOOT" && samePosition(a.to, turn.to)) shootTargets.add(key(a.shoot));
      }
    }
    return { key, movable, moveTargets, shootTargets };
  }, [actions, turn, game.boardSize]);

  const getHints = useCallback(
    (pos: Position): CellHints => {
      const k = hints.key(pos);
      const playing = game.status === "PLAYING";
      return {
        movable: playing && game.phase === "PLAYING" && hints.movable.has(k),
        selected: turn.step !== "SELECT_PIECE" && samePosition(turn.from, pos),
        moveTarget: turn.step === "SELECT_MOVE" && hints.moveTargets.has(k),
        shootTarget: turn.step === "SELECT_SHOOT" && hints.shootTargets.has(k),
        placeable: playing && game.phase === "PLACEMENT" && game.board[pos.row]?.[pos.col] === "EMPTY",
      };
    },
    [hints, game, turn],
  );

  const clickCell = useCallback(
    (pos: Position) => {
      if (game.status !== "PLAYING") return;
      if (game.phase === "PLACEMENT") {
        dispatch({ type: "PLACE", pos });
        return;
      }
      const k = hints.key(pos);
      if (turn.step === "SELECT_SHOOT") {
        if (hints.shootTargets.has(k)) dispatch({ type: "SHOOT", shoot: pos });
        return; // during the shot, only targets or "Cancel Move" are accepted
      }
      if (turn.step === "SELECT_MOVE" && hints.moveTargets.has(k)) {
        dispatch({ type: "SELECT_MOVE", to: pos });
        return;
      }
      if (turn.step === "SELECT_MOVE" && samePosition(turn.from, pos)) {
        dispatch({ type: "CANCEL" });
        return;
      }
      if (hints.movable.has(k)) dispatch({ type: "SELECT_PIECE", from: pos });
    },
    [game, turn, hints],
  );

  const start = useCallback((config: GameConfig) => {
    dispatch({ type: "START", config, game: createGame(config) });
  }, []);

  const cancel = useCallback(() => dispatch({ type: "CANCEL" }), []);

  return { ...state, actions, getHints, clickCell, start, cancel };
}

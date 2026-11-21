"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  applyAction,
  createGame,
  getValidActions,
  validatePlacement,
  placePiece,
  samePosition,
  tryApplyAction,
  tryPlacePiece,
  type GameState,
  type MoveAction,
  type PlayerId,
  type Position,
} from "@shared/gameEngine";
import type { AiDecision } from "@shared/apiTypes";
import { explainAction, explainPlacement, heuristicAction, heuristicPlacement, randomAction, randomPlacement } from "@shared/aiBots";
import {
  buildMatchTelemetry,
  createMatchId,
  describeTransition,
  replayDecisions,
  spawnDecisions,
  type Decision,
  type DecisionMeta,
  type MatchMeta,
  type MatchTelemetry,
  type TelemetryEvent,
} from "@shared/telemetry";
import { requestAiTurn, submitMatch } from "./api";
import { controllerLabel, type MatchConfig, type SlotController } from "./matchConfig";
import { TRIBES, coord } from "./tribes";

/** Local 3-step turn UX state (only meaningful during the battle phase). */
export type TurnStep =
  | { step: "SELECT_PIECE" }
  | { step: "SELECT_MOVE"; from: Position }
  | { step: "SELECT_SHOOT"; from: Position; to: Position };

export type LogKind = "setup" | "place" | "battle-start" | "move" | "ai-reasoning" | "eliminated" | "victory";

export interface LogEntry {
  id: number;
  kind: LogKind;
  player: PlayerId | null;
  text: string;
  /** For `ai-reasoning`: which bot decided, and whether it was a fallback. */
  model?: string;
  fallback?: boolean;
}

type NewLog = Omit<LogEntry, "id">;

/** Research telemetry recorded alongside the match (one event per placement / turn). */
interface Recording {
  matchId: string;
  /** Epoch ms. */
  startedAt: number;
  /** When the current decision became available (epoch ms), for human think time. */
  turnStartedAt: number;
  /** Time of the last applied decision (epoch ms); the match end time once finished. */
  lastEventAt: number;
  events: TelemetryEvent[];
}

interface MatchState {
  config: MatchConfig;
  game: GameState;
  turn: TurnStep;
  log: LogEntry[];
  nextLogId: number;
  rec: Recording;
}

/** An AI decision plus presentation info, applied by the reducer. */
interface AiTurnEvent {
  type: "AI_TURN";
  /** The state the decision was computed for; stale decisions are dropped. */
  expected: GameState;
  decision: AiDecision;
  modelLabel: string;
  fallback: boolean;
  /** Request / compute latency of the decision, excluding spectator pacing. */
  thinkTimeMs: number;
  at: number;
}

type MatchEvent =
  | { type: "START"; config: MatchConfig; game: GameState; matchId: string; at: number }
  | { type: "PLACE"; pos: Position; at: number }
  | { type: "SELECT_PIECE"; from: Position }
  | { type: "SELECT_MOVE"; to: Position }
  | { type: "SHOOT"; shoot: Position; at: number }
  | { type: "CANCEL" }
  | AiTurnEvent;

function withLog(state: MatchState, entries: NewLog[]): Pick<MatchState, "log" | "nextLogId"> {
  let id = state.nextLogId;
  const added = entries.map((e) => ({ ...e, id: id++ }));
  return { log: [...state.log, ...added], nextLogId: id };
}

/** Log lines describing what changed between two engine states (eliminations, battle start, victory). */
function transitionLogs(prev: GameState, next: GameState): NewLog[] {
  const out: NewLog[] = [];
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

const placeLog = (player: PlayerId, pos: Position): NewLog => ({
  kind: "place",
  player,
  text: `${TRIBES[player].short} raised a totem at ${coord(pos)}.`,
});

const moveLog = (player: PlayerId, a: MoveAction): NewLog => ({
  kind: "move",
  player,
  text: `${TRIBES[player].short} moved ${coord(a.from)} → ${coord(a.to)}, fire arrow at ${coord(a.shoot)}.`,
});

/** Appends the telemetry event for one decision (pure; `at` comes from the dispatched event). */
function record(rec: Recording, prev: GameState, next: GameState, decision: Decision, at: number): Recording {
  return {
    ...rec,
    turnStartedAt: at,
    lastEventAt: at,
    events: [...rec.events, describeTransition(prev, next, decision, rec.events.length)],
  };
}

const HUMAN_META = (thinkTimeMs: number): DecisionMeta => ({
  controller: "human",
  modelUsed: null,
  fallback: false,
  reasoning: null,
  thinkTimeMs: Math.max(0, Math.round(thinkTimeMs)),
});

function startState(config: MatchConfig, game: GameState, matchId: string, at: number): MatchState {
  // A RANDOM spawn already ran the snake draft; recover those placements for the log.
  const events = game.phase === "PLAYING" && game.turnNumber === 0 && game.pieces.length > 0
    ? replayDecisions({ ...config, placementMode: "RANDOM" }, spawnDecisions(game)).events
    : [];
  const rec: Recording = { matchId, startedAt: at, turnStartedAt: at, lastEventAt: at, events };
  const fresh: MatchState = { config, game, turn: { step: "SELECT_PIECE" }, log: [], nextLogId: 1, rec };
  const { boardSize, playerCount, piecesPerPlayer, placementMode } = config;
  const seats = game.players
    .map((p) => `${TRIBES[p].short}: ${controllerLabel(config.slots[p])}`)
    .join(" · ");
  const entries: NewLog[] = [
    {
      kind: "setup",
      player: null,
      text: `${boardSize}x${boardSize} battleground, ${playerCount} tribes, ${piecesPerPlayer} totems each (${placementMode === "RANDOM" ? "quick random spawn" : "snake draft"}). ${seats}.`,
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

/** Last-resort decision computed in the browser (server unreachable or returned something illegal). */
function localDecision(game: GameState, modelId: string): AiDecision {
  const random = modelId === "offline:random";
  if (game.phase === "PLACEMENT") {
    const placement = (random ? randomPlacement(game, Math.random) : heuristicPlacement(game))!;
    return { kind: "placement", placement, reasoning: explainPlacement(game, placement), modelUsed: random ? "offline:random" : "offline:heuristic" };
  }
  const move = (random ? randomAction(game, Math.random) : heuristicAction(game))!;
  return { kind: "move", move, reasoning: explainAction(game, move), modelUsed: random ? "offline:random" : "offline:heuristic" };
}

function applyAiTurn(state: MatchState, event: AiTurnEvent): MatchState {
  const { game } = state;
  if (game !== event.expected || game.status !== "PLAYING") return state; // stale (reset, or already moved)
  const player = game.currentPlayer;

  let decision = event.decision;
  let fallback = event.fallback;
  let next: GameState | null = null;
  const attempt = (d: AiDecision) => {
    const r = d.kind === "placement" ? tryPlacePiece(game, d.placement) : tryApplyAction(game, d.move);
    return r.ok ? r.state : null;
  };
  next = attempt(decision);
  if (!next) {
    // Never trust remote input blindly: re-validate and fall back locally if needed.
    const local = localDecision(game, "offline:heuristic");
    decision = { ...local, reasoning: `(Fallback: server returned an illegal choice) ${local.reasoning}` };
    fallback = true;
    next = attempt(decision);
    if (!next) return state;
  }

  const actionLog = decision.kind === "placement" ? placeLog(player, decision.placement) : moveLog(player, decision.move);
  const slot = state.config.slots[player];
  const meta: DecisionMeta = {
    controller: slot.type === "ai" ? slot.modelId : "human",
    modelUsed: decision.modelUsed,
    fallback,
    reasoning: decision.reasoning,
    thinkTimeMs: Math.round(event.thinkTimeMs),
  };
  const recorded: Decision =
    decision.kind === "placement"
      ? { ...meta, kind: "placement", player, placement: decision.placement }
      : { ...meta, kind: "move", player, move: decision.move };
  return {
    ...state,
    game: next,
    rec: record(state.rec, game, next, recorded, event.at),
    turn: { step: "SELECT_PIECE" },
    ...withLog(state, [
      actionLog,
      { kind: "ai-reasoning", player, text: decision.reasoning, model: event.modelLabel, fallback },
      ...transitionLogs(game, next),
    ]),
  };
}

function reducer(state: MatchState, event: MatchEvent): MatchState {
  const { game } = state;
  const humanTurn = state.config.slots[game.currentPlayer].type === "human";
  switch (event.type) {
    case "START":
      return startState(event.config, event.game, event.matchId, event.at);
    case "AI_TURN":
      return applyAiTurn(state, event);
    case "PLACE": {
      if (!humanTurn || validatePlacement(game, event.pos) !== null) return state;
      const next = placePiece(game, event.pos);
      const decision: Decision = { ...HUMAN_META(event.at - state.rec.turnStartedAt), kind: "placement", player: game.currentPlayer, placement: event.pos };
      return {
        ...state,
        game: next,
        rec: record(state.rec, game, next, decision, event.at),
        turn: { step: "SELECT_PIECE" },
        ...withLog(state, [placeLog(game.currentPlayer, event.pos), ...transitionLogs(game, next)]),
      };
    }
    case "SELECT_PIECE":
      if (!humanTurn) return state;
      return { ...state, turn: { step: "SELECT_MOVE", from: event.from } };
    case "SELECT_MOVE":
      if (!humanTurn || state.turn.step !== "SELECT_MOVE") return state;
      return { ...state, turn: { step: "SELECT_SHOOT", from: state.turn.from, to: event.to } };
    case "SHOOT": {
      if (!humanTurn || state.turn.step !== "SELECT_SHOOT") return state;
      const action: MoveAction = { from: state.turn.from, to: state.turn.to, shoot: event.shoot };
      const next = applyAction(game, action);
      const decision: Decision = { ...HUMAN_META(event.at - state.rec.turnStartedAt), kind: "move", player: game.currentPlayer, move: action };
      return {
        ...state,
        game: next,
        rec: record(state.rec, game, next, decision, event.at),
        turn: { step: "SELECT_PIECE" },
        ...withLog(state, [moveLog(game.currentPlayer, action), ...transitionLogs(game, next)]),
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

const NO_HINTS: CellHints = { movable: false, selected: false, moveTarget: false, shootTarget: false, placeable: false };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Match meta for the research log (seats, config, timing). */
function matchMeta(config: MatchConfig, game: GameState, rec: Recording): MatchMeta {
  return {
    matchId: rec.matchId,
    source: "client",
    startedAt: new Date(rec.startedAt).toISOString(),
    endedAt: new Date(rec.lastEventAt).toISOString(),
    config: {
      boardSize: config.boardSize,
      playerCount: config.playerCount,
      piecesPerPlayer: config.piecesPerPlayer,
      placementMode: config.placementMode ?? "MANUAL",
    },
    seats: game.players.map((p) => {
      const slot = config.slots[p];
      return slot.type === "ai"
        ? { player: p, controller: "ai" as const, modelId: slot.modelId, label: slot.label }
        : { player: p, controller: "human" as const, modelId: null, label: "Human" };
    }),
  };
}

export type SaveStatus = "idle" | "saving" | "saved" | "offline";

const newMatchId = () => createMatchId(new Date(), Math.random);

/** Local match (pass-and-play + AI seats): engine state, 3-step turn UX, AI turns, battle log, telemetry. */
export function useLocalMatch(initialConfig: MatchConfig) {
  // Lazy init: createGame (and its Math.random for RANDOM spawn) runs once on mount, never during SSR.
  const [state, dispatch] = useReducer(reducer, initialConfig, (config) => startState(config, createGame(config), newMatchId(), Date.now()));
  const [paused, setPaused] = useState(false);
  const { game, turn, config } = state;

  const currentSlot: SlotController = config.slots[game.currentPlayer];
  const humanTurn = game.status === "PLAYING" && currentSlot.type === "human";
  const aiThinking = game.status === "PLAYING" && currentSlot.type === "ai" && !paused;
  const hasAi = game.players.some((p) => config.slots[p].type === "ai");

  // --- automated AI turns ---------------------------------------------------
  useEffect(() => {
    if (game.status !== "PLAYING" || paused || currentSlot.type !== "ai") return;
    const slot = currentSlot;
    const controller = new AbortController();
    const started = performance.now();

    (async () => {
      let decision: AiDecision;
      let fallback = false;
      let thinkTimeMs = 0;
      try {
        const res = await requestAiTurn(game, slot.modelId, controller.signal);
        decision = res;
        fallback = res.fallback;
      } catch (err) {
        if (controller.signal.aborted) return;
        // Server unreachable / error: decide locally so the match never stalls.
        const local = localDecision(game, slot.modelId.startsWith("offline:") ? slot.modelId : "offline:heuristic");
        const why = err instanceof Error ? err.message : "server error";
        decision = { ...local, reasoning: `(Fallback: ${why}; decided in browser) ${local.reasoning}` };
        fallback = !slot.modelId.startsWith("offline:");
      }
      thinkTimeMs = performance.now() - started;
      await sleep(config.aiDelayMs - (performance.now() - started), controller.signal);
      if (controller.signal.aborted) return;
      dispatch({ type: "AI_TURN", expected: game, decision, modelLabel: slot.label, fallback, thinkTimeMs, at: Date.now() });
    })();

    return () => controller.abort();
  }, [game, paused, currentSlot, config.aiDelayMs]);

  // --- human interaction ------------------------------------------------------
  const actions = useMemo(() => (humanTurn ? getValidActions(game) : []), [game, humanTurn]);

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
      if (!humanTurn) return NO_HINTS;
      const k = hints.key(pos);
      return {
        movable: game.phase === "PLAYING" && hints.movable.has(k),
        selected: turn.step !== "SELECT_PIECE" && samePosition(turn.from, pos),
        moveTarget: turn.step === "SELECT_MOVE" && hints.moveTargets.has(k),
        shootTarget: turn.step === "SELECT_SHOOT" && hints.shootTargets.has(k),
        placeable: game.phase === "PLACEMENT" && game.board[pos.row]?.[pos.col] === "EMPTY",
      };
    },
    [hints, game, turn, humanTurn],
  );

  const clickCell = useCallback(
    (pos: Position) => {
      if (!humanTurn) return;
      if (game.phase === "PLACEMENT") {
        dispatch({ type: "PLACE", pos, at: Date.now() });
        return;
      }
      const k = hints.key(pos);
      if (turn.step === "SELECT_SHOOT") {
        if (hints.shootTargets.has(k)) dispatch({ type: "SHOOT", shoot: pos, at: Date.now() });
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
    [game, turn, hints, humanTurn],
  );

  const start = useCallback((config: MatchConfig) => {
    dispatch({ type: "START", config, game: createGame(config), matchId: newMatchId(), at: Date.now() });
  }, []);

  // --- research telemetry -------------------------------------------------------
  const { rec } = state;
  const telemetry: MatchTelemetry | null = useMemo(
    () => (game.status === "FINISHED" ? buildMatchTelemetry(matchMeta(config, game, rec), rec.events, game) : null),
    [game, config, rec],
  );
  const [save, setSave] = useState<{ matchId: string; status: "saved" | "offline"; error?: string } | null>(null);
  const submitted = useRef(new Set<string>());

  // Auto-submit each finished match once (the server replays and re-derives every metric).
  useEffect(() => {
    if (!telemetry || submitted.current.has(telemetry.matchId)) return;
    const matchId = telemetry.matchId;
    submitted.current.add(matchId);
    submitMatch(telemetry)
      .then(() => setSave({ matchId, status: "saved" }))
      .catch((err: unknown) => setSave({ matchId, status: "offline", error: err instanceof Error ? err.message : "server unreachable" }));
  }, [telemetry]);

  const result = telemetry && save?.matchId === telemetry.matchId ? save : null;
  const saveStatus: SaveStatus = !telemetry ? "idle" : (result?.status ?? "saving");
  const saveError = result?.error;

  const cancel = useCallback(() => dispatch({ type: "CANCEL" }), []);
  const togglePause = useCallback(() => setPaused((p) => !p), []);

  return {
    ...state,
    currentSlot,
    humanTurn,
    aiThinking,
    hasAi,
    paused,
    togglePause,
    getHints,
    clickCell,
    start,
    cancel,
    telemetry,
    saveStatus,
    saveError,
  };
}

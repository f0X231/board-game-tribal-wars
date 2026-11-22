/**
 * Tribal Wars - research telemetry & Voronoi analytics.
 *
 * Pure and deterministic: every metric is derived from engine states, so the
 * client (live recording), the server (authoritative replay of submitted logs)
 * and the headless experiment runner all produce identical numbers.
 *
 * Coordinates: algebraic notation, file `a`..`l` = column 0..11, rank `1`..`12`
 * = row 0..11 (`a1` = row 0, col 0). Directions are compass points in that
 * notation: `N` = towards higher ranks (row + 1), `E` = towards later files (col + 1).
 */
import {
  QUEEN_DIRECTIONS,
  GameRuleError,
  applyAction,
  createGame,
  getCell,
  getPieceIdAt,
  getQueenReachable,
  getValidPlacements,
  isPlayerId,
  placePiece,
  type Board,
  type BoardSize,
  type GamePhase,
  type GameState,
  type MoveAction,
  type PlacementMode,
  type PlayerCount,
  type PlayerId,
  type Position,
} from './gameEngine.ts';

export const TELEMETRY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Direction = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** Who/what decided, how long it took, and why. `controller` is `human`, a model id, or `random-spawn`. */
export interface DecisionMeta {
  readonly controller: string;
  /** Bot that actually decided (differs from `controller` after a fallback); `null` for humans. */
  readonly modelUsed: string | null;
  readonly fallback: boolean;
  readonly reasoning: string | null;
  /** Wall-clock decision time (ms); for AI seats the request latency, excluding spectator pacing. */
  readonly thinkTimeMs: number | null;
}

export type Decision =
  | (DecisionMeta & { readonly kind: 'placement'; readonly player: PlayerId; readonly placement: Position })
  | (DecisionMeta & { readonly kind: 'move'; readonly player: PlayerId; readonly move: MoveAction });

export interface PlayerMetrics {
  readonly player: PlayerId;
  /** Still in the match (not eliminated). */
  readonly active: boolean;
  readonly pieceCount: number;
  /** Totems with at least one complete legal turn (move + arrow). */
  readonly activePiecesCount: number;
  /** Totems with no complete legal turn. */
  readonly trappedPiecesCount: number;
  /** Number of legal (move, arrow) pairs on this board. */
  readonly legalActions: number;
  /** Empty squares this tribe reaches in strictly fewer Queen moves than any opponent. */
  readonly queenVoronoiCells: number;
  /** Empty squares this tribe reaches in strictly fewer King steps than any opponent. */
  readonly kingVoronoiCells: number;
  /** Empty squares where this tribe ties for the minimum Queen distance with 1+ other tribes. */
  readonly contestedCells: number;
  /** Same as `contestedCells` with King distance. */
  readonly kingContestedCells: number;
  /** Empty squares in connected regions bordered only by this tribe's totems (enemy-free). */
  readonly exclusiveSafeCells: number;
}

export interface BoardMetrics {
  readonly emptyCells: number;
  readonly fireTileCount: number;
  /** fireTileCount / boardSize^2 */
  readonly fireCoverageRatio: number;
  /** Empty squares tied (Queen distance) between 2+ tribes. */
  readonly queenContestedCells: number;
  readonly kingContestedCells: number;
  /** Empty squares no active tribe can reach. */
  readonly neutralCells: number;
  /** One entry per player in the match, in turn order. */
  readonly players: ReadonlyArray<PlayerMetrics>;
}

export interface TelemetryEvent {
  /** 0-based index of the decision in the match. */
  readonly seq: number;
  /** Phase the decision was made in. */
  readonly phase: GamePhase;
  readonly kind: 'placement' | 'move';
  /** 1-based draft pick number (placements only). */
  readonly placementNumber: number | null;
  /** 1-based battle turn number (moves only). */
  readonly turnNumber: number | null;
  readonly player: PlayerId;
  /** Persistent id of the totem that was placed or moved, e.g. `P2_3`. */
  readonly pieceId: string;
  readonly decision: Decision;
  /** `d4` (placement) or `d4-g7/g2` (move to g7, arrow at g2). */
  readonly notation: string;
  readonly from: string | null;
  readonly to: string;
  readonly shoot: string | null;
  readonly moveDistance: number | null;
  readonly moveDirection: Direction | null;
  readonly shootDistance: number | null;
  readonly shootDirection: Direction | null;
  /** Euclidean distance of the placed / arrived totem from the board centre. */
  readonly distanceFromCenter: number;
  /** Legal options the decider had (placement squares, or move-arrow pairs). */
  readonly branchingFactor: number;
  /** Mover's legal move-arrow pairs before the decision (board-based, also during the draft). */
  readonly totalValidActionsBefore: number;
  /** Mover's legal move-arrow pairs after the decision. */
  readonly playerMobilityAfter: number;
  /** Sum of legal move-arrow pairs of the mover's active opponents, before / after. */
  readonly opponentsMobilityBefore: number;
  readonly opponentsMobilityAfter: number;
  /** after - before (negative = the decision took that many options away from opponents). */
  readonly opponentsMobilityDelta: number;
  /** Players eliminated as a result of this decision. */
  readonly eliminated: ReadonlyArray<PlayerId>;
  readonly phaseAfter: GamePhase;
  /** Next player to act, or `null` when the match ended. */
  readonly nextPlayer: PlayerId | null;
  /** Board analytics after the decision. */
  readonly metrics: BoardMetrics;
  /** Board after the decision, one string per row (row 0 first): `.` empty, `#` fire, `1`-`4` tribes. */
  readonly board: ReadonlyArray<string>;
}

export interface MatchConfigRecord {
  readonly boardSize: BoardSize;
  readonly playerCount: PlayerCount;
  readonly piecesPerPlayer: number;
  readonly placementMode: PlacementMode;
}

export interface MatchSeat {
  readonly player: PlayerId;
  readonly controller: 'human' | 'ai';
  /** Model id for AI seats (`offline:heuristic`, `groq:...`), `null` for humans. */
  readonly modelId: string | null;
  readonly label: string;
}

export interface MatchMeta {
  readonly matchId: string;
  readonly source: 'client' | 'experiment';
  /** ISO-8601 timestamps. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly config: MatchConfigRecord;
  readonly seats: ReadonlyArray<MatchSeat>;
  /** Experiment name / free-form tag (optional). */
  readonly tag?: string | undefined;
}

export interface SeatSummary {
  readonly player: PlayerId;
  readonly label: string;
  readonly modelId: string | null;
  /** 1 = winner, then reverse elimination order (last eliminated = 2). */
  readonly placing: number;
  readonly finalQueenVoronoi: number;
  readonly finalKingVoronoi: number;
  readonly finalExclusiveSafe: number;
  /** Mean Queen Voronoi cells over all battle decisions (any player's). */
  readonly avgQueenVoronoi: number;
  readonly decisions: number;
  readonly fallbacks: number;
  readonly avgThinkTimeMs: number | null;
}

export interface MatchSummary {
  readonly matchId: string;
  readonly source: 'client' | 'experiment';
  readonly tag: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly boardSize: BoardSize;
  readonly playerCount: PlayerCount;
  readonly piecesPerPlayer: number;
  readonly placementMode: PlacementMode;
  readonly winner: PlayerId | null;
  readonly winnerModel: string | null;
  readonly eliminationOrder: ReadonlyArray<PlayerId>;
  readonly totalTurns: number;
  readonly totalPlacements: number;
  /** `P1=Human, P2=offline:heuristic, ...` */
  readonly models: string;
  readonly seats: ReadonlyArray<SeatSummary>;
}

export interface MatchTelemetry {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly matchId: string;
  readonly meta: MatchMeta;
  readonly summary: MatchSummary;
  readonly events: ReadonlyArray<TelemetryEvent>;
  readonly finalMetrics: BoardMetrics;
  readonly finalBoard: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Notation & geometry
// ---------------------------------------------------------------------------

/** `{row: 3, col: 0}` -> `a4`. */
export function toAlgebraic(pos: Position): string {
  return `${String.fromCharCode(97 + pos.col)}${pos.row + 1}`;
}

/** Number of squares travelled along a Queen line (Chebyshev distance). */
export function lineDistance(a: Position, b: Position): number {
  return Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
}

const DIRECTION_NAMES: Record<string, Direction> = {
  '1,0': 'N', '1,1': 'NE', '0,1': 'E', '-1,1': 'SE', '-1,0': 'S', '-1,-1': 'SW', '0,-1': 'W', '1,-1': 'NW',
};

/** Compass direction of a Queen line from `a` to `b` (see module doc), or `null` if not a line. */
export function directionOf(a: Position, b: Position): Direction | null {
  const dr = b.row - a.row;
  const dc = b.col - a.col;
  if ((dr === 0 && dc === 0) || (dr !== 0 && dc !== 0 && Math.abs(dr) !== Math.abs(dc))) return null;
  return DIRECTION_NAMES[`${Math.sign(dr)},${Math.sign(dc)}`] ?? null;
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Euclidean distance from the geometric centre of the board. */
export function distanceFromCenter(size: number, pos: Position): number {
  const c = (size - 1) / 2;
  return round(Math.hypot(pos.row - c, pos.col - c), 3);
}

/** Compact board snapshot: one string per row (row 0 first), `.` empty, `#` fire, `1`-`4` tribes. */
export function encodeBoard(board: Board): string[] {
  return board.map((row) => row.map((c) => (c === 'EMPTY' ? '.' : c === 'FIRE' ? '#' : c.slice(1))).join(''));
}

// ---------------------------------------------------------------------------
// Distance maps (multi-source BFS)
// ---------------------------------------------------------------------------

/**
 * Minimum number of Queen moves from any of `sources` to every square
 * (`-1` = unreachable / not empty). Only `EMPTY` squares are traversable.
 */
export function queenDistanceMap(board: Board, sources: ReadonlyArray<Position>): Int16Array {
  const n = board.length;
  const dist = new Int16Array(n * n).fill(-1);
  const queue: number[] = [];
  for (const s of sources) queue.push(s.row * n + s.col);
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const d = head < sources.length ? 0 : dist[u]!;
    const r0 = Math.floor(u / n);
    const c0 = u % n;
    for (const [dr, dc] of QUEEN_DIRECTIONS) {
      let r = r0 + dr;
      let c = c0 + dc;
      // Keep sliding through already-visited squares: farther ones may still be new.
      while (getCell(board, { row: r, col: c }) === 'EMPTY') {
        const v = r * n + c;
        if (dist[v] === -1) {
          dist[v] = d + 1;
          queue.push(v);
        }
        r += dr;
        c += dc;
      }
    }
  }
  return dist;
}

/** Minimum number of King steps (1 square, 8 directions) from any of `sources` to every square. */
export function kingDistanceMap(board: Board, sources: ReadonlyArray<Position>): Int16Array {
  const n = board.length;
  const dist = new Int16Array(n * n).fill(-1);
  const queue: number[] = [];
  for (const s of sources) queue.push(s.row * n + s.col);
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const d = head < sources.length ? 0 : dist[u]!;
    const r0 = Math.floor(u / n);
    const c0 = u % n;
    for (const [dr, dc] of QUEEN_DIRECTIONS) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (getCell(board, { row: r, col: c }) !== 'EMPTY') continue;
      const v = r * n + c;
      if (dist[v] === -1) {
        dist[v] = d + 1;
        queue.push(v);
      }
    }
  }
  return dist;
}

interface Territory {
  owned: Map<PlayerId, number>;
  contestedBy: Map<PlayerId, number>;
  contested: number;
  neutral: number;
}

/** Voronoi partition of the empty squares given one distance map per tribe. */
function voronoi(board: Board, maps: ReadonlyArray<readonly [PlayerId, Int16Array]>): Territory {
  const n = board.length;
  const owned = new Map<PlayerId, number>(maps.map(([p]) => [p, 0]));
  const contestedBy = new Map<PlayerId, number>(maps.map(([p]) => [p, 0]));
  let contested = 0;
  let neutral = 0;
  for (let i = 0; i < n * n; i++) {
    if (board[Math.floor(i / n)]![i % n] !== 'EMPTY') continue;
    let best = Infinity;
    let leaders: PlayerId[] = [];
    for (const [p, dist] of maps) {
      const d = dist[i]!;
      if (d < 0) continue;
      if (d < best) {
        best = d;
        leaders = [p];
      } else if (d === best) {
        leaders.push(p);
      }
    }
    if (leaders.length === 0) neutral++;
    else if (leaders.length === 1) owned.set(leaders[0]!, owned.get(leaders[0]!)! + 1);
    else {
      contested++;
      for (const p of leaders) contestedBy.set(p, contestedBy.get(p)! + 1);
    }
  }
  return { owned, contestedBy, contested, neutral };
}

/**
 * Connected-component analysis of the empty squares (8-connectivity, which equals
 * Queen connectivity). A region is exclusive to a tribe if that tribe is the only
 * active tribe with a totem adjacent to it.
 */
function exclusiveRegions(board: Board, active: ReadonlyArray<PlayerId>): Map<PlayerId, number> {
  const n = board.length;
  const result = new Map<PlayerId, number>(active.map((p) => [p, 0]));
  const seen = new Uint8Array(n * n);
  for (let start = 0; start < n * n; start++) {
    if (seen[start] || board[Math.floor(start / n)]![start % n] !== 'EMPTY') continue;
    const stack = [start];
    seen[start] = 1;
    let size = 0;
    const borders = new Set<PlayerId>();
    while (stack.length > 0) {
      const u = stack.pop()!;
      size++;
      const r0 = Math.floor(u / n);
      const c0 = u % n;
      for (const [dr, dc] of QUEEN_DIRECTIONS) {
        const cell = getCell(board, { row: r0 + dr, col: c0 + dc });
        if (cell === undefined) continue;
        const v = (r0 + dr) * n + (c0 + dc);
        if (cell === 'EMPTY') {
          if (!seen[v]) {
            seen[v] = 1;
            stack.push(v);
          }
        } else if (isPlayerId(cell) && active.includes(cell)) {
          borders.add(cell);
        }
      }
    }
    if (borders.size === 1) {
      const owner = [...borders][0]!;
      result.set(owner, result.get(owner)! + size);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mobility
// ---------------------------------------------------------------------------

/** Empty squares on Queen lines from `pos` (allocation-free). */
function queenRays(board: Board, pos: Position): number {
  let n = 0;
  for (const [dr, dc] of QUEEN_DIRECTIONS) {
    let row = pos.row + dr;
    let col = pos.col + dc;
    while (getCell(board, { row, col }) === 'EMPTY') {
      n++;
      row += dr;
      col += dc;
    }
  }
  return n;
}

/**
 * Exact number of legal (move, arrow) pairs for one totem. After the move the
 * origin is fire and the destination holds the totem; neither changes which
 * squares lie on the destination's rays (the occupied origin already blocks),
 * so the shot count equals the destination's rays on the current board.
 */
export function pieceActionCount(board: Board, pos: Position): number {
  let total = 0;
  for (const to of getQueenReachable(board, pos)) total += queenRays(board, to);
  return total;
}

function pieceSquares(state: GameState, player: PlayerId): Position[] {
  return state.pieces.filter((p) => p.player === player).map((p) => p.position);
}

/** Legal move-arrow pairs for `player` on the current board (independent of whose turn it is). */
export function legalActionCount(state: GameState, player: PlayerId): number {
  return pieceSquares(state, player).reduce((s, p) => s + pieceActionCount(state.board, p), 0);
}

// ---------------------------------------------------------------------------
// Board metrics
// ---------------------------------------------------------------------------

/** Full analytics snapshot of a position. Voronoi sources are the totems of active tribes. */
export function computeBoardMetrics(state: GameState): BoardMetrics {
  const { board } = state;
  const size = board.length;
  let empty = 0;
  let fire = 0;
  for (const row of board) {
    for (const c of row) {
      if (c === 'EMPTY') empty++;
      else if (c === 'FIRE') fire++;
    }
  }
  const active = state.activePlayers;
  const queen = voronoi(board, active.map((p) => [p, queenDistanceMap(board, pieceSquares(state, p))] as const));
  const king = voronoi(board, active.map((p) => [p, kingDistanceMap(board, pieceSquares(state, p))] as const));
  const exclusive = exclusiveRegions(board, active);

  const players = state.players.map((player): PlayerMetrics => {
    const counts = pieceSquares(state, player).map((p) => pieceActionCount(board, p));
    const activePieces = counts.filter((c) => c > 0).length;
    return {
      player,
      active: active.includes(player),
      pieceCount: counts.length,
      activePiecesCount: activePieces,
      trappedPiecesCount: counts.length - activePieces,
      legalActions: counts.reduce((a, b) => a + b, 0),
      queenVoronoiCells: queen.owned.get(player) ?? 0,
      kingVoronoiCells: king.owned.get(player) ?? 0,
      contestedCells: queen.contestedBy.get(player) ?? 0,
      kingContestedCells: king.contestedBy.get(player) ?? 0,
      exclusiveSafeCells: exclusive.get(player) ?? 0,
    };
  });

  return {
    emptyCells: empty,
    fireTileCount: fire,
    fireCoverageRatio: round(fire / (size * size)),
    queenContestedCells: queen.contested,
    kingContestedCells: king.contested,
    neutralCells: queen.neutral,
    players,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Applies a decision with the engine (throws `GameRuleError` if illegal or out of turn). */
export function applyDecision(state: GameState, decision: Decision): GameState {
  if (decision.player !== state.currentPlayer) {
    throw new GameRuleError(`It is ${state.currentPlayer}'s turn, not ${decision.player}'s.`);
  }
  if (decision.kind === 'placement') return placePiece(state, decision.placement);
  return applyAction(state, decision.move);
}

/** Copy of a decision with a canonical key order (identical JSON from client, server and runner). */
export function normalizeDecision(d: Decision): Decision {
  const meta = { controller: d.controller, modelUsed: d.modelUsed, fallback: d.fallback, reasoning: d.reasoning, thinkTimeMs: d.thinkTimeMs };
  return d.kind === 'placement'
    ? { kind: 'placement', player: d.player, placement: { row: d.placement.row, col: d.placement.col }, ...meta }
    : {
        kind: 'move',
        player: d.player,
        move: {
          from: { row: d.move.from.row, col: d.move.from.col },
          to: { row: d.move.to.row, col: d.move.to.col },
          shoot: { row: d.move.shoot.row, col: d.move.shoot.col },
        },
        ...meta,
      };
}

/** Telemetry for one decision that turned `prev` into `next`. */
export function describeTransition(prev: GameState, next: GameState, decision: Decision, seq: number): TelemetryEvent {
  const me = decision.player;
  const opponents = prev.activePlayers.filter((p) => p !== me);
  const oppBefore = opponents.reduce((s, p) => s + legalActionCount(prev, p), 0);
  const oppAfter = opponents.reduce((s, p) => s + legalActionCount(next, p), 0);
  const myBefore = legalActionCount(prev, me);
  const common = {
    seq,
    phase: prev.phase,
    player: me,
    decision: normalizeDecision(decision),
    totalValidActionsBefore: myBefore,
    playerMobilityAfter: legalActionCount(next, me),
    opponentsMobilityBefore: oppBefore,
    opponentsMobilityAfter: oppAfter,
    opponentsMobilityDelta: oppAfter - oppBefore,
    eliminated: next.eliminated.filter((p) => !prev.eliminated.includes(p)),
    phaseAfter: next.phase,
    nextPlayer: next.status === 'PLAYING' ? next.currentPlayer : null,
    metrics: computeBoardMetrics(next),
    board: encodeBoard(next.board),
  };

  if (decision.kind === 'placement') {
    const pos = decision.placement;
    return {
      ...common,
      kind: 'placement',
      placementNumber: prev.placementIndex + 1,
      turnNumber: null,
      pieceId: getPieceIdAt(next, pos) ?? '?',
      notation: toAlgebraic(pos),
      from: null,
      to: toAlgebraic(pos),
      shoot: null,
      moveDistance: null,
      moveDirection: null,
      shootDistance: null,
      shootDirection: null,
      distanceFromCenter: distanceFromCenter(prev.boardSize, pos),
      branchingFactor: getValidPlacements(prev).length,
    };
  }
  const { from, to, shoot } = decision.move;
  return {
    ...common,
    kind: 'move',
    placementNumber: null,
    turnNumber: prev.turnNumber + 1,
    pieceId: getPieceIdAt(prev, from) ?? '?',
    notation: `${toAlgebraic(from)}-${toAlgebraic(to)}/${toAlgebraic(shoot)}`,
    from: toAlgebraic(from),
    to: toAlgebraic(to),
    shoot: toAlgebraic(shoot),
    moveDistance: lineDistance(from, to),
    moveDirection: directionOf(from, to),
    shootDistance: lineDistance(to, shoot),
    shootDirection: directionOf(to, shoot),
    distanceFromCenter: distanceFromCenter(prev.boardSize, to),
    branchingFactor: myBefore,
  };
}

/**
 * The snake-draft placements of a `RANDOM` spawn, recovered from `state.pieces`
 * (kept in deployment order). Only valid before the first battle turn.
 */
export function spawnDecisions(state: GameState): Decision[] {
  if (state.turnNumber !== 0) throw new GameRuleError('Spawn decisions are only recoverable before the first turn.');
  return state.pieces.map((p) => ({
    kind: 'placement',
    player: p.player,
    placement: p.position,
    controller: 'random-spawn',
    modelUsed: null,
    fallback: false,
    reasoning: null,
    thinkTimeMs: null,
  }));
}

/**
 * Replays decisions from an empty board through the engine, producing the
 * telemetry events and the final state. Throws `GameRuleError` on any illegal step.
 */
export function replayDecisions(
  config: MatchConfigRecord,
  decisions: ReadonlyArray<Decision>,
): { state: GameState; events: TelemetryEvent[] } {
  let state = createGame({ ...config, placementMode: 'MANUAL' });
  const events: TelemetryEvent[] = [];
  decisions.forEach((d, i) => {
    if (state.status !== 'PLAYING') throw new GameRuleError(`Decision #${i} comes after the match ended.`);
    const next = applyDecision(state, d);
    events.push(describeTransition(state, next, d, i));
    state = next;
  });
  return { state, events };
}

// ---------------------------------------------------------------------------
// Match assembly
// ---------------------------------------------------------------------------

function summarize(meta: MatchMeta, events: ReadonlyArray<TelemetryEvent>, final: GameState, finalMetrics: BoardMetrics): MatchSummary {
  const battle = events.filter((e) => e.phase === 'PLAYING');
  const placingOf = (p: PlayerId): number => {
    if (final.winner === p) return 1;
    const idx = final.eliminated.indexOf(p);
    return idx < 0 ? 1 + final.activePlayers.indexOf(p) : final.players.length - idx;
  };
  const seats = meta.seats.map((seat): SeatSummary => {
    const fm = finalMetrics.players.find((m) => m.player === seat.player);
    const mine = events.filter((e) => e.player === seat.player);
    const timed = mine.map((e) => e.decision.thinkTimeMs).filter((t): t is number => t !== null);
    const series = battle.map((e) => e.metrics.players.find((m) => m.player === seat.player)?.queenVoronoiCells ?? 0);
    return {
      player: seat.player,
      label: seat.label,
      modelId: seat.modelId,
      placing: placingOf(seat.player),
      finalQueenVoronoi: fm?.queenVoronoiCells ?? 0,
      finalKingVoronoi: fm?.kingVoronoiCells ?? 0,
      finalExclusiveSafe: fm?.exclusiveSafeCells ?? 0,
      avgQueenVoronoi: series.length ? round(series.reduce((a, b) => a + b, 0) / series.length, 2) : fm?.queenVoronoiCells ?? 0,
      decisions: mine.filter((e) => e.decision.controller !== 'random-spawn').length,
      fallbacks: mine.filter((e) => e.decision.fallback).length,
      avgThinkTimeMs: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null,
    };
  });
  const winnerSeat = meta.seats.find((s) => s.player === final.winner);
  return {
    matchId: meta.matchId,
    source: meta.source,
    tag: meta.tag ?? null,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationMs: Math.max(0, Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) || 0,
    boardSize: meta.config.boardSize,
    playerCount: meta.config.playerCount,
    piecesPerPlayer: meta.config.piecesPerPlayer,
    placementMode: meta.config.placementMode,
    winner: final.winner,
    winnerModel: winnerSeat ? (winnerSeat.modelId ?? 'human') : null,
    eliminationOrder: [...final.eliminated],
    totalTurns: final.turnNumber,
    totalPlacements: events.filter((e) => e.kind === 'placement').length,
    models: meta.seats.map((s) => `${s.player}=${s.modelId ?? 'human'}`).join(', '),
    seats,
  };
}

/** Assembles the full research log from recorded events and the final engine state. */
export function buildMatchTelemetry(meta: MatchMeta, events: ReadonlyArray<TelemetryEvent>, final: GameState): MatchTelemetry {
  const finalMetrics = computeBoardMetrics(final);
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId: meta.matchId,
    meta,
    summary: summarize(meta, events, final, finalMetrics),
    events: [...events],
    finalMetrics,
    finalBoard: encodeBoard(final.board),
  };
}

/** Authoritative rebuild: replays `decisions` and recomputes every metric. Throws on illegal logs. */
export function rebuildMatchTelemetry(meta: MatchMeta, decisions: ReadonlyArray<Decision>): MatchTelemetry {
  const { state, events } = replayDecisions(meta.config, decisions);
  if (state.status !== 'FINISHED') throw new GameRuleError('The match log does not reach a finished match.');
  return buildMatchTelemetry(meta, events, state);
}

/** Readable, sortable match id: `m-20261121-143005-k3x9q2` (`random` injected; no global randomness). */
export function createMatchId(now: Date, random: () => number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
  return `m-${stamp}-${suffix}`;
}

// ---------------------------------------------------------------------------
// CSV export (one row per decision, fixed columns for P1-P4)
// ---------------------------------------------------------------------------

const PLAYER_SLOTS: ReadonlyArray<PlayerId> = ['P1', 'P2', 'P3', 'P4'];
const PLAYER_FIELDS = [
  ['active', 'active'],
  ['pieces', 'pieceCount'],
  ['active_pieces', 'activePiecesCount'],
  ['trapped_pieces', 'trappedPiecesCount'],
  ['legal_actions', 'legalActions'],
  ['queen_voronoi', 'queenVoronoiCells'],
  ['king_voronoi', 'kingVoronoiCells'],
  ['contested', 'contestedCells'],
  ['king_contested', 'kingContestedCells'],
  ['exclusive_safe', 'exclusiveSafeCells'],
] as const satisfies ReadonlyArray<readonly [string, keyof PlayerMetrics]>;

/** Column names of `matchToCsv`, stable across matches so files can be concatenated. */
export const CSV_COLUMNS: ReadonlyArray<string> = [
  'match_id', 'source', 'board_size', 'player_count', 'pieces_per_player', 'placement_mode', 'winner',
  'seq', 'phase', 'kind', 'placement_number', 'turn_number', 'player', 'piece_id',
  'controller', 'model_used', 'fallback', 'think_time_ms',
  'notation', 'from', 'to', 'shoot', 'move_distance', 'move_direction', 'shoot_distance', 'shoot_direction',
  'distance_from_center', 'branching_factor', 'total_valid_actions_before', 'player_mobility_after',
  'opponents_mobility_before', 'opponents_mobility_after', 'opponents_mobility_delta', 'eliminated', 'next_player',
  'empty_cells', 'fire_tile_count', 'fire_coverage_ratio', 'queen_contested_cells', 'king_contested_cells', 'neutral_cells',
  ...PLAYER_SLOTS.flatMap((p) => PLAYER_FIELDS.map(([name]) => `${p.toLowerCase()}_${name}`)),
  'reasoning',
];

type CsvValue = string | number | boolean | null;

function csvCell(v: CsvValue): string {
  if (v === null) return '';
  let s = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  // Neutralise spreadsheet formula injection from free text (e.g. LLM reasoning).
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flattened turn-by-turn CSV (header + one row per decision), ready for pandas / R. */
export function matchToCsv(match: MatchTelemetry): string {
  const { summary } = match;
  const rows = match.events.map((e) => {
    const perPlayer = PLAYER_SLOTS.flatMap((p) => {
      const m = e.metrics.players.find((x) => x.player === p);
      return PLAYER_FIELDS.map(([, key]): CsvValue => (m ? m[key] : null));
    });
    const values: CsvValue[] = [
      summary.matchId, summary.source, summary.boardSize, summary.playerCount, summary.piecesPerPlayer, summary.placementMode, summary.winner,
      e.seq, e.phase, e.kind, e.placementNumber, e.turnNumber, e.player, e.pieceId,
      e.decision.controller, e.decision.modelUsed, e.decision.fallback, e.decision.thinkTimeMs,
      e.notation, e.from, e.to, e.shoot, e.moveDistance, e.moveDirection, e.shootDistance, e.shootDirection,
      e.distanceFromCenter, e.branchingFactor, e.totalValidActionsBefore, e.playerMobilityAfter,
      e.opponentsMobilityBefore, e.opponentsMobilityAfter, e.opponentsMobilityDelta, e.eliminated.join(' '), e.nextPlayer,
      e.metrics.emptyCells, e.metrics.fireTileCount, e.metrics.fireCoverageRatio,
      e.metrics.queenContestedCells, e.metrics.kingContestedCells, e.metrics.neutralCells,
      ...perPlayer,
      e.decision.reasoning,
    ];
    return values.map(csvCell).join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

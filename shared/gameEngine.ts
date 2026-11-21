/**
 * Tribal Wars - core game engine.
 *
 * Pure, framework-agnostic and immutable: every exported function returns new
 * data and never mutates its inputs. Randomness is confined to `createGame`
 * (initial piece placement); all validation and turn transitions are
 * deterministic.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BoardSize = 6 | 10 | 12;
export type PlayerCount = 2 | 3 | 4;
export type PlayerId = 'P1' | 'P2' | 'P3' | 'P4';
export type Cell = 'EMPTY' | 'FIRE' | PlayerId;
export type Board = ReadonlyArray<ReadonlyArray<Cell>>;

export interface Position {
  readonly row: number;
  readonly col: number;
}

/** One complete, atomic turn: move a piece, leave a fire trail, shoot an arrow. */
export interface MoveAction {
  readonly from: Position;
  readonly to: Position;
  readonly shoot: Position;
}

/** Whether the match is still running (`PLAYING`) or has a result (`FINISHED`). */
export type GameStatus = 'PLAYING' | 'FINISHED';
/** `PLACEMENT` = snake-draft totem deployment; `PLAYING` = battle turns (move -> trail -> arrow). */
export type GamePhase = 'PLACEMENT' | 'PLAYING';
/** `MANUAL` = players draft their totems one at a time; `RANDOM` = the draft is auto-completed randomly. */
export type PlacementMode = 'MANUAL' | 'RANDOM';

/**
 * A totem with a persistent identity (`P1_1` = P1's first deployed totem).
 * Ids never change when the totem moves, so telemetry can follow each piece.
 */
export interface Piece {
  readonly id: string;
  readonly player: PlayerId;
  readonly position: Position;
}

export interface GameConfig {
  readonly boardSize: BoardSize;
  readonly playerCount: PlayerCount;
  readonly piecesPerPlayer: number;
  /** Defaults to `'MANUAL'`. */
  readonly placementMode?: PlacementMode | undefined;
}

export interface GameState {
  readonly boardSize: BoardSize;
  readonly piecesPerPlayer: number;
  readonly phase: GamePhase;
  /** Full snake-draft sequence (one entry per totem). Empty for states built from a board. */
  readonly placementOrder: ReadonlyArray<PlayerId>;
  /** Index into `placementOrder` of the next totem to place (=== length when the draft is done). */
  readonly placementIndex: number;
  readonly board: Board;
  /** All players in turn order, including eliminated ones. */
  readonly players: ReadonlyArray<PlayerId>;
  /** Players still in the match, in turn order. */
  readonly activePlayers: ReadonlyArray<PlayerId>;
  /** Eliminated players in the order they were knocked out. */
  readonly eliminated: ReadonlyArray<PlayerId>;
  readonly currentPlayer: PlayerId;
  readonly status: GameStatus;
  readonly winner: PlayerId | null;
  /** Number of turns completed so far. */
  readonly turnNumber: number;
  readonly lastAction: MoveAction | null;
  /**
   * Every totem on the board with its persistent id, in deployment order (the
   * snake-draft order for drafted matches, so a `RANDOM` spawn can be replayed
   * from it). Always consistent with `board`.
   */
  readonly pieces: ReadonlyArray<Piece>;
}

export class GameRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameRuleError';
  }
}

// ---------------------------------------------------------------------------
// Constants & config validation
// ---------------------------------------------------------------------------

export const BOARD_SIZES: ReadonlyArray<BoardSize> = [6, 10, 12];
export const ALL_PLAYERS: ReadonlyArray<PlayerId> = ['P1', 'P2', 'P3', 'P4'];

/** The 8 Queen directions: orthogonal + diagonal. */
export const QUEEN_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [-1, 1], [1, -1], [1, 1],
];

export function isBoardSize(n: number): n is BoardSize {
  return n === 6 || n === 10 || n === 12;
}

export function isPlayerCount(n: number): n is PlayerCount {
  return n === 2 || n === 3 || n === 4;
}

/** Allowed piece-count range (inclusive) for a board size. */
export function getPieceLimits(boardSize: BoardSize): { min: number; max: number } {
  return boardSize === 6 ? { min: 2, max: 4 } : { min: 4, max: 6 };
}

/** Returns a list of human-readable problems; empty means the config is valid. */
export function validateConfig(config: GameConfig): string[] {
  const errors: string[] = [];
  if (!isBoardSize(config.boardSize)) {
    errors.push(`Board size must be one of ${BOARD_SIZES.join(', ')} (got ${String(config.boardSize)}).`);
  }
  if (!isPlayerCount(config.playerCount)) {
    errors.push(`Player count must be 2, 3 or 4 (got ${String(config.playerCount)}).`);
  }
  if (!Number.isInteger(config.piecesPerPlayer)) {
    errors.push(`Pieces per player must be an integer (got ${String(config.piecesPerPlayer)}).`);
  } else if (isBoardSize(config.boardSize)) {
    const { min, max } = getPieceLimits(config.boardSize);
    if (config.piecesPerPlayer < min || config.piecesPerPlayer > max) {
      errors.push(
        `A ${config.boardSize}x${config.boardSize} board requires ${min}-${max} pieces per player (got ${config.piecesPerPlayer}).`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Board helpers
// ---------------------------------------------------------------------------

export function createEmptyBoard(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, (): Cell => 'EMPTY'));
}

export function cloneBoard(board: Board): Cell[][] {
  return board.map((row) => [...row]);
}

export function isInside(board: Board, pos: Position): boolean {
  return (
    Number.isInteger(pos.row) &&
    Number.isInteger(pos.col) &&
    pos.row >= 0 &&
    pos.col >= 0 &&
    pos.row < board.length &&
    pos.col < board.length
  );
}

export function getCell(board: Board, pos: Position): Cell | undefined {
  return board[pos.row]?.[pos.col];
}

export function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col;
}

export function isPlayerId(cell: Cell | undefined): cell is PlayerId {
  return cell === 'P1' || cell === 'P2' || cell === 'P3' || cell === 'P4';
}

export function getPlayerPieces(board: Board, player: PlayerId): Position[] {
  const pieces: Position[] = [];
  board.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell === player) pieces.push({ row: r, col: c });
    }),
  );
  return pieces;
}

/** Persistent piece id, e.g. `pieceId('P2', 3)` -> `P2_3`. */
export function pieceId(player: PlayerId, ordinal: number): string {
  return `${player}_${ordinal}`;
}

/** Id of the totem standing on `pos`, or `null`. */
export function getPieceIdAt(state: GameState, pos: Position): string | null {
  return state.pieces.find((p) => samePosition(p.position, pos))?.id ?? null;
}

/**
 * Assigns ids to the totems of a board built without a draft history
 * (row-major scan per player: the first P1 totem found is `P1_1`).
 */
export function assignPieceIds(board: Board): Piece[] {
  const counts: Record<PlayerId, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  const pieces: Piece[] = [];
  board.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (isPlayerId(cell)) pieces.push({ id: pieceId(cell, ++counts[cell]), player: cell, position: { row: r, col: c } });
    }),
  );
  return pieces;
}

/**
 * All squares reachable from `origin` along unobstructed Queen lines.
 * Only `EMPTY` squares are traversable; pieces and fire block the line.
 * Used for both piece movement and fire-arrow shots.
 */
export function getQueenReachable(board: Board, origin: Position): Position[] {
  const result: Position[] = [];
  for (const [dr, dc] of QUEEN_DIRECTIONS) {
    let row = origin.row + dr;
    let col = origin.col + dc;
    while (getCell(board, { row, col }) === 'EMPTY') {
      result.push({ row, col });
      row += dr;
      col += dc;
    }
  }
  return result;
}

/** True if `target` is reachable from `origin` via an unobstructed Queen line. */
export function isQueenReachable(board: Board, origin: Position, target: Position): boolean {
  if (!isInside(board, origin) || !isInside(board, target) || samePosition(origin, target)) return false;
  const dr = Math.sign(target.row - origin.row);
  const dc = Math.sign(target.col - origin.col);
  const rowDist = Math.abs(target.row - origin.row);
  const colDist = Math.abs(target.col - origin.col);
  const isLine = rowDist === 0 || colDist === 0 || rowDist === colDist;
  if (!isLine) return false;
  const steps = Math.max(rowDist, colDist);
  for (let i = 1; i <= steps; i++) {
    if (getCell(board, { row: origin.row + dr * i, col: origin.col + dc * i }) !== 'EMPTY') return false;
  }
  return true;
}

/** Board after the move + fire-trail steps (before the arrow is shot). */
function boardAfterMove(board: Board, from: Position, to: Position, player: PlayerId): Cell[][] {
  const next = cloneBoard(board);
  next[from.row]![from.col] = 'FIRE';
  next[to.row]![to.col] = player;
  return next;
}

// ---------------------------------------------------------------------------
// Action generation & validation
// ---------------------------------------------------------------------------

/** Every legal complete turn (move + shot) available to `player`. */
export function getValidActions(state: GameState, player: PlayerId = state.currentPlayer): MoveAction[] {
  if (state.phase !== 'PLAYING') return [];
  return getValidActionsOnBoard(state.board, player);
}

export function getValidActionsOnBoard(board: Board, player: PlayerId): MoveAction[] {
  const actions: MoveAction[] = [];
  for (const from of getPlayerPieces(board, player)) {
    for (const to of getQueenReachable(board, from)) {
      const afterMove = boardAfterMove(board, from, to, player);
      for (const shoot of getQueenReachable(afterMove, to)) {
        actions.push({ from, to, shoot });
      }
    }
  }
  return actions;
}

/** Fast check (early exit) for whether `player` can make at least one complete turn. */
export function hasValidAction(board: Board, player: PlayerId): boolean {
  for (const from of getPlayerPieces(board, player)) {
    for (const to of getQueenReachable(board, from)) {
      const afterMove = boardAfterMove(board, from, to, player);
      // After moving, `from` is FIRE, so any free neighbour of `to` means a shot exists.
      for (const [dr, dc] of QUEEN_DIRECTIONS) {
        if (getCell(afterMove, { row: to.row + dr, col: to.col + dc }) === 'EMPTY') return true;
      }
    }
  }
  return false;
}

/** Returns `null` if the action is legal for the current player, otherwise the reason. */
export function validateAction(state: GameState, action: MoveAction): string | null {
  if (state.status !== 'PLAYING') return 'The match is already finished.';
  if (state.phase !== 'PLAYING') return 'Totems are still being placed (snake draft in progress).';
  const { board, currentPlayer } = state;
  const { from, to, shoot } = action;

  if (!isInside(board, from)) return 'Move origin is outside the board.';
  if (!isInside(board, to)) return 'Move destination is outside the board.';
  if (!isInside(board, shoot)) return 'Arrow target is outside the board.';

  // Step 1: move
  if (getCell(board, from) !== currentPlayer) return `Origin square does not hold a ${currentPlayer} piece.`;
  if (!isQueenReachable(board, from, to)) return 'Move destination is not reachable by an unobstructed Queen move.';

  // Step 2: trail (origin becomes FIRE) – applied before validating the shot.
  const afterMove = boardAfterMove(board, from, to, currentPlayer);

  // Step 3: shoot
  if (!isQueenReachable(afterMove, to, shoot)) return 'Arrow target is not reachable by an unobstructed Queen shot.';
  return null;
}

export function isValidAction(state: GameState, action: MoveAction): boolean {
  return validateAction(state, action) === null;
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

/**
 * Starting after `mover`, advance through turn order. Every opponent who cannot
 * complete a full turn is eliminated (stuck is permanent: empty squares never
 * reappear). Returns the resulting turn/elimination info.
 */
function resolveTurnOrder(
  board: Board,
  players: ReadonlyArray<PlayerId>,
  activePlayers: ReadonlyArray<PlayerId>,
  eliminated: ReadonlyArray<PlayerId>,
  mover: PlayerId,
): Pick<GameState, 'activePlayers' | 'eliminated' | 'currentPlayer' | 'status' | 'winner'> {
  const moverIndex = players.indexOf(mover);
  const newlyEliminated: PlayerId[] = [];
  // Check opponents in turn order starting after the mover.
  for (let i = 1; i < players.length; i++) {
    const p = players[(moverIndex + i) % players.length]!;
    if (activePlayers.includes(p) && !hasValidAction(board, p)) newlyEliminated.push(p);
  }
  const stillActive = activePlayers.filter((p) => !newlyEliminated.includes(p));
  const allEliminated = [...eliminated, ...newlyEliminated];

  if (stillActive.length <= 1) {
    const winner = stillActive[0] ?? null;
    return { activePlayers: stillActive, eliminated: allEliminated, currentPlayer: winner ?? mover, status: 'FINISHED', winner };
  }

  let next = mover;
  for (let i = 1; i <= players.length; i++) {
    const p = players[(moverIndex + i) % players.length]!;
    if (stillActive.includes(p)) {
      next = p;
      break;
    }
  }
  return { activePlayers: stillActive, eliminated: allEliminated, currentPlayer: next, status: 'PLAYING', winner: null };
}

/**
 * Executes one atomic turn: Move -> Fire trail at origin -> Fire arrow.
 * Returns a brand-new state; throws `GameRuleError` on any illegal action.
 */
export function applyAction(state: GameState, action: MoveAction): GameState {
  const error = validateAction(state, action);
  if (error !== null) throw new GameRuleError(error);

  const { from, to, shoot } = action;
  const board = boardAfterMove(state.board, from, to, state.currentPlayer); // steps 1 + 2
  board[shoot.row]![shoot.col] = 'FIRE'; // step 3

  const turn = resolveTurnOrder(board, state.players, state.activePlayers, state.eliminated, state.currentPlayer);
  return {
    ...state,
    ...turn,
    board,
    turnNumber: state.turnNumber + 1,
    lastAction: { from: { ...from }, to: { ...to }, shoot: { ...shoot } },
    pieces: state.pieces.map((p) => (samePosition(p.position, from) ? { ...p, position: { ...to } } : p)),
  };
}

/** Non-throwing variant of `applyAction`. */
export function tryApplyAction(
  state: GameState,
  action: MoveAction,
): { ok: true; state: GameState } | { ok: false; error: string } {
  const error = validateAction(state, action);
  if (error !== null) return { ok: false, error };
  return { ok: true, state: applyAction(state, action) };
}

// ---------------------------------------------------------------------------
// Snake-draft placement
// ---------------------------------------------------------------------------

/**
 * Snake-draft order: forward on even rounds, reversed on odd rounds.
 * e.g. 3 players x 2 pieces -> P1 P2 P3 P3 P2 P1.
 */
export function getSnakeDraftOrder(players: ReadonlyArray<PlayerId>, piecesPerPlayer: number): PlayerId[] {
  const order: PlayerId[] = [];
  for (let round = 0; round < piecesPerPlayer; round++) {
    order.push(...(round % 2 === 0 ? players : [...players].reverse()));
  }
  return order;
}

/** Totems `player` still has to place in the draft. */
export function getPiecesToPlace(state: GameState, player: PlayerId): number {
  return state.placementOrder.slice(state.placementIndex).filter((p) => p === player).length;
}

/** Every square where the current drafter may deploy a totem (all `EMPTY` squares). */
export function getValidPlacements(state: GameState): Position[] {
  if (state.status !== 'PLAYING' || state.phase !== 'PLACEMENT') return [];
  const result: Position[] = [];
  state.board.forEach((row, r) => row.forEach((cell, c) => {
    if (cell === 'EMPTY') result.push({ row: r, col: c });
  }));
  return result;
}

/** Returns `null` if the current drafter may place a totem at `pos`, otherwise the reason. */
export function validatePlacement(state: GameState, pos: Position): string | null {
  if (state.status !== 'PLAYING') return 'The match is already finished.';
  if (state.phase !== 'PLACEMENT') return 'The placement phase is over.';
  if (!isInside(state.board, pos)) return 'Placement square is outside the board.';
  if (getCell(state.board, pos) !== 'EMPTY') return 'Placement square is not empty.';
  return null;
}

/**
 * Battle-start bookkeeping shared by the end of the draft and `createStateFromBoard`:
 * players with no complete turn are eliminated, and the turn goes to the first able
 * player starting from `firstMover` (clockwise).
 */
function startBattle(
  board: Board,
  players: ReadonlyArray<PlayerId>,
  firstMover: PlayerId,
): Pick<GameState, 'activePlayers' | 'eliminated' | 'currentPlayer' | 'status' | 'winner'> {
  const active = players.filter((p) => hasValidAction(board, p));
  const eliminated = players.filter((p) => !active.includes(p));
  if (active.length <= 1) {
    const winner = active[0] ?? null;
    return { activePlayers: active, eliminated, currentPlayer: winner ?? firstMover, status: 'FINISHED', winner };
  }
  const start = players.indexOf(firstMover);
  let current = firstMover;
  for (let i = 0; i < players.length; i++) {
    const p = players[(start + i) % players.length]!;
    if (active.includes(p)) {
      current = p;
      break;
    }
  }
  return { activePlayers: active, eliminated, currentPlayer: current, status: 'PLAYING', winner: null };
}

/**
 * Deploys one totem for the current drafter. When the last totem is placed the
 * match switches to `PLAYING`, and the player who placed that last totem moves
 * first (then clockwise). Throws `GameRuleError` on an illegal placement.
 */
export function placePiece(state: GameState, pos: Position): GameState {
  const error = validatePlacement(state, pos);
  if (error !== null) throw new GameRuleError(error);

  const placer = state.currentPlayer;
  const board = cloneBoard(state.board);
  board[pos.row]![pos.col] = placer;
  const placementIndex = state.placementIndex + 1;
  const ordinal = state.pieces.filter((p) => p.player === placer).length + 1;
  const pieces = [...state.pieces, { id: pieceId(placer, ordinal), player: placer, position: { ...pos } }];

  if (placementIndex < state.placementOrder.length) {
    return { ...state, board, pieces, placementIndex, currentPlayer: state.placementOrder[placementIndex]! };
  }
  return { ...state, board, pieces, placementIndex, phase: 'PLAYING', ...startBattle(board, state.players, placer) };
}

/** Non-throwing variant of `placePiece`. */
export function tryPlacePiece(
  state: GameState,
  pos: Position,
): { ok: true; state: GameState } | { ok: false; error: string } {
  const error = validatePlacement(state, pos);
  if (error !== null) return { ok: false, error };
  return { ok: true, state: placePiece(state, pos) };
}

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

/**
 * Builds a battle-phase state from an explicit board (useful for tests, replays
 * and scenario setup). Players who are already stuck are eliminated immediately,
 * and the turn passes to the first able player starting from `currentPlayer`.
 */
export function createStateFromBoard(
  board: Board,
  players: ReadonlyArray<PlayerId>,
  currentPlayer: PlayerId = players[0] ?? 'P1',
  piecesPerPlayer = 0,
): GameState {
  const size = board.length;
  if (!isBoardSize(size) || board.some((row) => row.length !== size)) {
    throw new GameRuleError(`Board must be a square of size ${BOARD_SIZES.join('/')}.`);
  }
  if (!isPlayerCount(players.length) || new Set(players).size !== players.length) {
    throw new GameRuleError('There must be 2-4 distinct players.');
  }
  if (!players.includes(currentPlayer)) throw new GameRuleError(`${currentPlayer} is not in this match.`);

  return {
    boardSize: size,
    piecesPerPlayer,
    phase: 'PLAYING',
    placementOrder: [],
    placementIndex: 0,
    board: cloneBoard(board),
    players: [...players],
    ...startBattle(board, players, currentPlayer),
    turnNumber: 0,
    lastAction: null,
    pieces: assignPieceIds(board),
  };
}

/**
 * Creates a new match.
 * - `MANUAL` (default): empty board in the `PLACEMENT` phase; call `placePiece`
 *   for each totem in snake-draft order.
 * - `RANDOM`: the snake draft is auto-completed on random empty squares (retried
 *   until every player has a legal turn), so the first-mover rule still applies.
 *
 * `random` defaults to `Math.random` and may be injected for reproducible setups.
 * This is the only place randomness is used.
 */
export function createGame(config: GameConfig, random: () => number = Math.random): GameState {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new GameRuleError(errors.join(' '));

  const { boardSize, playerCount, piecesPerPlayer } = config;
  const players = ALL_PLAYERS.slice(0, playerCount);
  const placementOrder = getSnakeDraftOrder(players, piecesPerPlayer);

  const draft: GameState = {
    boardSize,
    piecesPerPlayer,
    phase: 'PLACEMENT',
    placementOrder,
    placementIndex: 0,
    board: createEmptyBoard(boardSize),
    players,
    activePlayers: players,
    eliminated: [],
    currentPlayer: placementOrder[0]!,
    status: 'PLAYING',
    winner: null,
    turnNumber: 0,
    lastAction: null,
    pieces: [],
  };
  if ((config.placementMode ?? 'MANUAL') === 'MANUAL') return draft;

  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let state = draft;
    while (state.phase === 'PLACEMENT') {
      const options = getValidPlacements(state);
      state = placePiece(state, options[Math.floor(random() * options.length)]!);
    }
    if (state.status === 'PLAYING' && state.activePlayers.length === playerCount) return state;
  }
  throw new GameRuleError('Could not generate a playable starting position.');
}

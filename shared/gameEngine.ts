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

export type GameStatus = 'PLAYING' | 'FINISHED';

export interface GameConfig {
  readonly boardSize: BoardSize;
  readonly playerCount: PlayerCount;
  readonly piecesPerPlayer: number;
}

export interface GameState {
  readonly boardSize: BoardSize;
  readonly piecesPerPlayer: number;
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
// Game creation
// ---------------------------------------------------------------------------

/**
 * Builds a state from an explicit board (useful for tests, replays and
 * scenario setup). Players who are already stuck are eliminated immediately,
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

  const active = players.filter((p) => hasValidAction(board, p));
  const eliminated = players.filter((p) => !active.includes(p));
  let status: GameStatus = 'PLAYING';
  let winner: PlayerId | null = null;
  let current = currentPlayer;

  if (active.length <= 1) {
    status = 'FINISHED';
    winner = active[0] ?? null;
    current = winner ?? currentPlayer;
  } else {
    const start = players.indexOf(currentPlayer);
    for (let i = 0; i < players.length; i++) {
      const p = players[(start + i) % players.length]!;
      if (active.includes(p)) {
        current = p;
        break;
      }
    }
  }

  return {
    boardSize: size,
    piecesPerPlayer,
    board: cloneBoard(board),
    players: [...players],
    activePlayers: active,
    eliminated,
    currentPlayer: current,
    status,
    winner,
    turnNumber: 0,
    lastAction: null,
  };
}

/**
 * Creates a new match with pieces placed at random distinct squares.
 * `random` defaults to `Math.random` and may be injected for reproducible setups.
 * Placement is retried until every player has at least one complete legal turn.
 */
export function createGame(config: GameConfig, random: () => number = Math.random): GameState {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new GameRuleError(errors.join(' '));

  const { boardSize, playerCount, piecesPerPlayer } = config;
  const players = ALL_PLAYERS.slice(0, playerCount);
  const MAX_ATTEMPTS = 100;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const squares: Position[] = [];
    for (let r = 0; r < boardSize; r++) for (let c = 0; c < boardSize; c++) squares.push({ row: r, col: c });
    // Fisher-Yates shuffle
    for (let i = squares.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [squares[i], squares[j]] = [squares[j]!, squares[i]!];
    }

    const board = createEmptyBoard(boardSize);
    let k = 0;
    for (const player of players) {
      for (let n = 0; n < piecesPerPlayer; n++) {
        const sq = squares[k++]!;
        board[sq.row]![sq.col] = player;
      }
    }

    if (players.every((p) => hasValidAction(board, p))) {
      return createStateFromBoard(board, players, players[0], piecesPerPlayer);
    }
  }
  throw new GameRuleError('Could not generate a playable starting position.');
}

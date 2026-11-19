import {
  ALL_PLAYERS,
  isBoardSize,
  isPlayerId,
  type Cell,
  type GameState,
  type MoveAction,
  type PlayerId,
  type Position,
} from '../../shared/gameEngine.js';

/**
 * Strict structural validation of a client-supplied `GameState`. The server never
 * trusts the shape of incoming JSON; everything the AI service reads is checked here.
 */
export type ParseResult = { ok: true; state: GameState } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isCell = (v: unknown): v is Cell => v === 'EMPTY' || v === 'FIRE' || (typeof v === 'string' && isPlayerId(v as Cell));
const isPid = (v: unknown): v is PlayerId => typeof v === 'string' && (ALL_PLAYERS as ReadonlyArray<string>).includes(v);

function playerList(v: unknown, name: string): PlayerId[] | string {
  if (!Array.isArray(v) || !v.every(isPid)) return `${name} must be an array of player ids`;
  if (new Set(v).size !== v.length) return `${name} contains duplicates`;
  return v;
}

function position(v: unknown, size: number): Position | null {
  if (!isObj(v) || !isInt(v.row) || !isInt(v.col)) return null;
  if (v.row < 0 || v.col < 0 || v.row >= size || v.col >= size) return null;
  return { row: v.row, col: v.col };
}

export function parseGameState(input: unknown): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error: `Invalid state: ${error}` });
  if (!isObj(input)) return fail('not an object');
  const s = input;

  if (!isInt(s.boardSize) || !isBoardSize(s.boardSize)) return fail('boardSize must be 6, 10 or 12');
  const size = s.boardSize;
  if (!Array.isArray(s.board) || s.board.length !== size) return fail('board has the wrong number of rows');
  const board: Cell[][] = [];
  for (const row of s.board) {
    if (!Array.isArray(row) || row.length !== size || !row.every(isCell)) return fail('board row is malformed');
    board.push([...row]);
  }

  const players = playerList(s.players, 'players');
  if (typeof players === 'string') return fail(players);
  if (players.length < 2 || players.length > 4) return fail('2-4 players required');
  const activePlayers = playerList(s.activePlayers, 'activePlayers');
  if (typeof activePlayers === 'string') return fail(activePlayers);
  const eliminated = playerList(s.eliminated, 'eliminated');
  if (typeof eliminated === 'string') return fail(eliminated);
  if (![...activePlayers, ...eliminated].every((p) => players.includes(p))) return fail('unknown player in active/eliminated');

  if (!isPid(s.currentPlayer) || !players.includes(s.currentPlayer)) return fail('currentPlayer is not in the match');
  if (s.phase !== 'PLACEMENT' && s.phase !== 'PLAYING') return fail('phase must be PLACEMENT or PLAYING');
  if (s.status !== 'PLAYING' && s.status !== 'FINISHED') return fail('status must be PLAYING or FINISHED');
  if (!isInt(s.piecesPerPlayer) || s.piecesPerPlayer < 0 || s.piecesPerPlayer > 6) return fail('piecesPerPlayer out of range');
  if (!isInt(s.turnNumber) || s.turnNumber < 0) return fail('turnNumber must be a non-negative integer');
  if (!isInt(s.placementIndex) || s.placementIndex < 0) return fail('placementIndex must be a non-negative integer');
  if (!Array.isArray(s.placementOrder) || !s.placementOrder.every(isPid) || s.placementOrder.length > 24) {
    return fail('placementOrder is malformed');
  }
  const placementOrder = s.placementOrder;
  if (s.winner !== null && !isPid(s.winner)) return fail('winner is malformed');

  let lastAction: MoveAction | null = null;
  if (s.lastAction !== null && s.lastAction !== undefined) {
    if (!isObj(s.lastAction)) return fail('lastAction is malformed');
    const from = position(s.lastAction.from, size);
    const to = position(s.lastAction.to, size);
    const shoot = position(s.lastAction.shoot, size);
    if (!from || !to || !shoot) return fail('lastAction is malformed');
    lastAction = { from, to, shoot };
  }

  return {
    ok: true,
    state: {
      boardSize: size,
      piecesPerPlayer: s.piecesPerPlayer,
      phase: s.phase,
      placementOrder,
      placementIndex: s.placementIndex,
      board,
      players,
      activePlayers,
      eliminated,
      currentPlayer: s.currentPlayer,
      status: s.status,
      winner: s.winner ?? null,
      turnNumber: s.turnNumber,
      lastAction,
    },
  };
}

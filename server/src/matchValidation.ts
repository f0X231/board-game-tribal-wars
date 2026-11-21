import {
  ALL_PLAYERS,
  isBoardSize,
  isPlayerCount,
  validateConfig,
  type PlacementMode,
  type PlayerId,
  type Position,
} from '../../shared/gameEngine.js';
import type { Decision, MatchMeta, MatchSeat } from '../../shared/telemetry.js';

/**
 * Strict parsing of a client-submitted match log (`POST /api/matches`).
 * Only the meta data and the raw decisions are read; every derived metric is
 * recomputed on the server by replaying the decisions through the engine.
 */
export type SubmissionResult = { ok: true; meta: MatchMeta; decisions: Decision[] } | { ok: false; error: string };

export const MATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_DECISIONS = 400; // 12x12: 24 placements + at most 60 battle turns; generous headroom.
const MAX_THINK_MS = 3_600_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isPid = (v: unknown): v is PlayerId => typeof v === 'string' && (ALL_PLAYERS as ReadonlyArray<string>).includes(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isoDate = (v: unknown): v is string => str(v, 40) && !Number.isNaN(Date.parse(v));

function position(v: unknown, size: number): Position | null {
  if (!isObj(v) || !isInt(v.row) || !isInt(v.col)) return null;
  if (v.row < 0 || v.col < 0 || v.row >= size || v.col >= size) return null;
  return { row: v.row, col: v.col };
}

function parseDecision(v: unknown, size: number, i: number): Decision | string {
  const bad = (what: string) => `decision #${i}: ${what}`;
  if (!isObj(v)) return bad('not an object');
  if (!isPid(v.player)) return bad('player is invalid');
  if (!str(v.controller, 160) || v.controller.length === 0) return bad('controller is invalid');
  if (v.modelUsed !== null && !str(v.modelUsed, 160)) return bad('modelUsed is invalid');
  if (typeof v.fallback !== 'boolean') return bad('fallback must be boolean');
  if (v.reasoning !== null && typeof v.reasoning !== 'string') return bad('reasoning must be a string or null');
  const thinkTimeMs = v.thinkTimeMs;
  if (thinkTimeMs !== null && (typeof thinkTimeMs !== 'number' || !Number.isFinite(thinkTimeMs) || thinkTimeMs < 0 || thinkTimeMs > MAX_THINK_MS)) {
    return bad('thinkTimeMs is invalid');
  }
  const meta = {
    player: v.player,
    controller: v.controller,
    modelUsed: v.modelUsed,
    fallback: v.fallback,
    reasoning: v.reasoning === null ? null : v.reasoning.slice(0, 2000),
    thinkTimeMs: thinkTimeMs === null ? null : Math.round(thinkTimeMs),
  };
  if (v.kind === 'placement') {
    const placement = position(v.placement, size);
    return placement ? { ...meta, kind: 'placement', placement } : bad('placement is invalid');
  }
  if (v.kind === 'move') {
    if (!isObj(v.move)) return bad('move is invalid');
    const from = position(v.move.from, size);
    const to = position(v.move.to, size);
    const shoot = position(v.move.shoot, size);
    return from && to && shoot ? { ...meta, kind: 'move', move: { from, to, shoot } } : bad('move is invalid');
  }
  return bad('kind must be placement or move');
}

/** Accepts a full `MatchTelemetry` (`{ meta, events: [{ decision }] }`) or `{ meta, decisions }`. */
export function parseMatchSubmission(input: unknown): SubmissionResult {
  const fail = (error: string): SubmissionResult => ({ ok: false, error: `Invalid match log: ${error}` });
  if (!isObj(input) || !isObj(input.meta)) return fail('expected { meta, events } or { meta, decisions }');
  const m = input.meta;

  if (!str(m.matchId, 80) || !MATCH_ID_PATTERN.test(m.matchId)) return fail('matchId must match [A-Za-z0-9_-]{1,80}');
  if (!isoDate(m.startedAt) || !isoDate(m.endedAt)) return fail('startedAt/endedAt must be ISO dates');
  if (m.tag !== undefined && m.tag !== null && !str(m.tag, 80)) return fail('tag must be a short string');
  if (!isObj(m.config)) return fail('config is missing');
  const c = m.config;
  if (!isInt(c.boardSize) || !isBoardSize(c.boardSize)) return fail('boardSize must be 6, 10 or 12');
  if (!isInt(c.playerCount) || !isPlayerCount(c.playerCount)) return fail('playerCount must be 2-4');
  if (!isInt(c.piecesPerPlayer)) return fail('piecesPerPlayer must be an integer');
  if (c.placementMode !== 'MANUAL' && c.placementMode !== 'RANDOM') return fail('placementMode must be MANUAL or RANDOM');
  const placementMode: PlacementMode = c.placementMode;
  const config = { boardSize: c.boardSize, playerCount: c.playerCount, piecesPerPlayer: c.piecesPerPlayer, placementMode };
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) return fail(configErrors.join(' '));

  if (!Array.isArray(m.seats) || m.seats.length !== config.playerCount) return fail('one seat per player required');
  const seats: MatchSeat[] = [];
  for (const [i, raw] of (m.seats as unknown[]).entries()) {
    if (!isObj(raw) || !isPid(raw.player) || raw.player !== ALL_PLAYERS[i]) return fail(`seat #${i} must be ${ALL_PLAYERS[i]}`);
    if (raw.controller !== 'human' && raw.controller !== 'ai') return fail(`seat #${i} controller must be human or ai`);
    if (raw.modelId !== null && !str(raw.modelId, 160)) return fail(`seat #${i} modelId is invalid`);
    if (!str(raw.label, 80)) return fail(`seat #${i} label is invalid`);
    seats.push({ player: raw.player, controller: raw.controller, modelId: raw.modelId, label: raw.label });
  }

  let rawDecisions: unknown[];
  if (Array.isArray(input.decisions)) rawDecisions = input.decisions;
  else if (Array.isArray(input.events)) rawDecisions = (input.events as unknown[]).map((e) => (isObj(e) ? e.decision : undefined));
  else return fail('decisions/events array is missing');
  if (rawDecisions.length === 0 || rawDecisions.length > MAX_DECISIONS) return fail(`1-${MAX_DECISIONS} decisions required`);

  const decisions: Decision[] = [];
  for (const [i, raw] of rawDecisions.entries()) {
    const d = parseDecision(raw, config.boardSize, i);
    if (typeof d === 'string') return fail(d);
    decisions.push(d);
  }

  const meta: MatchMeta = {
    matchId: m.matchId,
    source: 'client',
    startedAt: new Date(m.startedAt).toISOString(),
    endedAt: new Date(m.endedAt).toISOString(),
    config,
    seats,
    ...(typeof m.tag === 'string' && m.tag.length > 0 ? { tag: m.tag } : {}),
  };
  return { ok: true, meta, decisions };
}

/**
 * High-performance board core shared by the 7 research bots.
 *
 * - `FastBoard`: flat `Uint8Array` board (0 = empty, 1 = fire, 2..5 = P1..P4)
 *   with precomputed Queen-ray / King-neighbour tables, incremental Zobrist
 *   hashing and allocation-free make/unmake of Tribal Wars turns
 *   (vacated square -> FIRE, arrow square -> FIRE).
 * - Multi-source Queen-move (D1) and King-move (D2) BFS distance maps.
 * - 8-connected empty-region decomposition, filling (plodding) bounds,
 *   single-agent endgame search, territory feature extraction.
 * - Anytime support: `Clock` deadline checks that abort a search by throwing.
 *
 * Everything is deterministic: bots use a seeded PRNG, never `Math.random()`.
 */
import { ALL_PLAYERS, type GameState, type MoveAction, type PlayerId, type Position } from '../../../shared/gameEngine.js';

export const EMPTY = 0;
export const FIRE = 1;
/** Unreachable distance in BFS maps. */
export const INF = 255;
/** Proven win / loss magnitude (root perspective). */
export const WIN = 1_000_000;

/** Player slot (0..3 = P1..P4) <-> cell code (2..5). */
export const codeOf = (slot: number): number => slot + 2;
export const slotOfCode = (code: number): number => code - 2;

// ---------------------------------------------------------------------------
// Geometry tables
// ---------------------------------------------------------------------------

/** Direction order: N, NE, E, SE, S, SW, W, NW (row deltas / col deltas). */
const DR = [-1, -1, 0, 1, 1, 1, 0, -1] as const;
const DC = [0, 1, 1, 1, 0, -1, -1, -1] as const;

export interface Geometry {
  readonly n: number;
  readonly size: number;
  /** `ray[i * 8 + d]` = next cell from `i` in direction `d`, or -1 off-board. */
  readonly ray: Int16Array;
  readonly row: Uint8Array;
  readonly col: Uint8Array;
  /** Chebyshev distance from the centre, scaled so 0 = centre. */
  readonly centre: Float32Array;
}

const geometries = new Map<number, Geometry>();

export function geometry(n: number): Geometry {
  const cached = geometries.get(n);
  if (cached) return cached;
  const size = n * n;
  const ray = new Int16Array(size * 8).fill(-1);
  const row = new Uint8Array(size);
  const col = new Uint8Array(size);
  const centre = new Float32Array(size);
  const c = (n - 1) / 2;
  for (let r = 0; r < n; r++) {
    for (let q = 0; q < n; q++) {
      const i = r * n + q;
      row[i] = r;
      col[i] = q;
      centre[i] = Math.max(Math.abs(r - c), Math.abs(q - c));
      for (let d = 0; d < 8; d++) {
        const rr = r + DR[d]!;
        const cc = q + DC[d]!;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n) ray[i * 8 + d] = rr * n + cc;
      }
    }
  }
  const g: Geometry = { n, size, ray, row, col, centre };
  geometries.set(n, g);
  return g;
}

/** 2^-d lookup (index INF -> 0). */
export const POW2NEG = (() => {
  const t = new Float64Array(256);
  for (let d = 0; d < 255; d++) t[d] = 2 ** -d;
  t[INF] = 0;
  return t;
})();

// ---------------------------------------------------------------------------
// Deterministic PRNG + Zobrist keys
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, seeded. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ZobristKeys {
  /** `[cell * 6 + content]`, content 1..5 (fire, P1..P4). */
  readonly lo: Int32Array;
  readonly hi: Int32Array;
  /** Side to move (slot) and alive-mask keys. */
  readonly sideLo: Int32Array;
  readonly sideHi: Int32Array;
  readonly aliveLo: Int32Array;
  readonly aliveHi: Int32Array;
}

const zobristCache = new Map<number, ZobristKeys>();
function zobrist(size: number): ZobristKeys {
  const cached = zobristCache.get(size);
  if (cached) return cached;
  const r = prng(0x7a11b005 ^ size);
  const fill = (k: number) => {
    const a = new Int32Array(k);
    for (let i = 0; i < k; i++) a[i] = (r() * 4294967296) | 0;
    return a;
  };
  const z: ZobristKeys = { lo: fill(size * 6), hi: fill(size * 6), sideLo: fill(4), sideHi: fill(4), aliveLo: fill(16), aliveHi: fill(16) };
  zobristCache.set(size, z);
  return z;
}

// ---------------------------------------------------------------------------
// Packed actions: from | to << 8 | shoot << 16  (cells < 256 on 12x12)
// ---------------------------------------------------------------------------

export const pack = (from: number, to: number, shoot: number): number => from | (to << 8) | (shoot << 16);
export const fromOf = (a: number): number => a & 0xff;
export const toOf = (a: number): number => (a >>> 8) & 0xff;
export const shootOf = (a: number): number => (a >>> 16) & 0xff;

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface BoardSnapshot {
  readonly cells: Uint8Array;
  readonly pieces: Int16Array[];
  readonly aliveMask: number;
  readonly hashLo: number;
  readonly hashHi: number;
  readonly empties: number;
}

export class FastBoard {
  readonly g: Geometry;
  readonly n: number;
  readonly size: number;
  readonly cells: Uint8Array;
  /** Piece cells per slot (index 0..3 = P1..P4). Length = pieces of that slot. */
  readonly pieces: Int16Array[];
  /** Slots of all players in turn order (including eliminated ones). */
  readonly order: number[];
  /** Bitmask of slots still in the match. */
  aliveMask: number;
  hashLo = 0;
  hashHi = 0;
  empties = 0;
  private readonly z: ZobristKeys;

  constructor(n: number, players: ReadonlyArray<number>) {
    this.g = geometry(n);
    this.n = n;
    this.size = n * n;
    this.cells = new Uint8Array(this.size);
    this.pieces = [new Int16Array(0), new Int16Array(0), new Int16Array(0), new Int16Array(0)];
    this.order = [...players];
    this.aliveMask = 0;
    for (const s of players) this.aliveMask |= 1 << s;
    this.z = zobrist(this.size);
  }

  static fromState(state: GameState): FastBoard {
    const slot = (p: PlayerId) => ALL_PLAYERS.indexOf(p);
    const fb = new FastBoard(state.boardSize, state.players.map(slot));
    fb.aliveMask = 0;
    for (const p of state.activePlayers) fb.aliveMask |= 1 << slot(p);
    const lists: number[][] = [[], [], [], []];
    for (let r = 0; r < state.boardSize; r++) {
      for (let c = 0; c < state.boardSize; c++) {
        const cell = state.board[r]![c]!;
        const i = r * state.boardSize + c;
        const code = cell === 'EMPTY' ? EMPTY : cell === 'FIRE' ? FIRE : codeOf(slot(cell));
        fb.cells[i] = code;
        if (code >= 2) lists[code - 2]!.push(i);
        if (code === EMPTY) fb.empties++;
        else {
          fb.hashLo ^= fb.z.lo[i * 6 + code]!;
          fb.hashHi ^= fb.z.hi[i * 6 + code]!;
        }
      }
    }
    for (let s = 0; s < 4; s++) fb.pieces[s] = Int16Array.from(lists[s]!);
    return fb;
  }

  /** Copy (independent buffers) — used by placement search and region solvers. */
  clone(): FastBoard {
    const fb = new FastBoard(this.n, this.order);
    fb.cells.set(this.cells);
    for (let s = 0; s < 4; s++) fb.pieces[s] = Int16Array.from(this.pieces[s]!);
    fb.aliveMask = this.aliveMask;
    fb.hashLo = this.hashLo;
    fb.hashHi = this.hashHi;
    fb.empties = this.empties;
    return fb;
  }

  /** Full copy of the mutable state (restored after an interrupted search). */
  snapshot(): BoardSnapshot {
    return { cells: this.cells.slice(), pieces: this.pieces.map((p) => p.slice()), aliveMask: this.aliveMask, hashLo: this.hashLo, hashHi: this.hashHi, empties: this.empties };
  }

  restore(snap: BoardSnapshot): void {
    this.cells.set(snap.cells);
    for (let s = 0; s < 4; s++) this.pieces[s] = snap.pieces[s]!.slice();
    this.aliveMask = snap.aliveMask;
    this.hashLo = snap.hashLo;
    this.hashHi = snap.hashHi;
    this.empties = snap.empties;
  }

  isAlive(slot: number): boolean {
    return (this.aliveMask & (1 << slot)) !== 0;
  }

  /** Next alive slot after `slot` in turn order (returns `slot` if it is the only one). */
  nextAlive(slot: number): number {
    const k = this.order.length;
    const at = this.order.indexOf(slot);
    for (let i = 1; i <= k; i++) {
      const s = this.order[(at + i) % k]!;
      if (this.aliveMask & (1 << s)) return s;
    }
    return slot;
  }

  aliveCount(): number {
    let n = 0;
    for (const s of this.order) if (this.aliveMask & (1 << s)) n++;
    return n;
  }

  /** Search key including side to move and the alive set. */
  key(side: number): number {
    return (this.hashLo ^ this.z.sideLo[side]! ^ this.z.aliveLo[this.aliveMask & 15]!) >>> 0;
  }
  keyHi(side: number): number {
    return (this.hashHi ^ this.z.sideHi[side]! ^ this.z.aliveHi[this.aliveMask & 15]!) | 0;
  }

  private setCell(i: number, code: number): void {
    const old = this.cells[i]!;
    if (old !== EMPTY) {
      this.hashLo ^= this.z.lo[i * 6 + old]!;
      this.hashHi ^= this.z.hi[i * 6 + old]!;
    } else this.empties--;
    if (code !== EMPTY) {
      this.hashLo ^= this.z.lo[i * 6 + code]!;
      this.hashHi ^= this.z.hi[i * 6 + code]!;
    } else this.empties++;
    this.cells[i] = code;
  }

  /** Movement half of a turn: `from` -> FIRE, `to` -> piece. Returns the piece index (for unmove). */
  move(slot: number, from: number, to: number): number {
    const list = this.pieces[slot]!;
    let k = 0;
    while (k < list.length && list[k] !== from) k++;
    if (k === list.length) throw new Error(`no ${playerOf(slot)} totem on ${from}`);
    list[k] = to;
    this.setCell(from, FIRE);
    this.setCell(to, codeOf(slot));
    return k;
  }

  unmove(slot: number, from: number, to: number, k: number): void {
    this.pieces[slot]![k] = from;
    this.setCell(to, EMPTY);
    this.setCell(from, codeOf(slot));
  }

  /** Placement phase: deploy a totem of `slot` on an empty `cell`. */
  place(slot: number, cell: number): void {
    const list = this.pieces[slot]!;
    const next = new Int16Array(list.length + 1);
    next.set(list);
    next[list.length] = cell;
    this.pieces[slot] = next;
    this.setCell(cell, codeOf(slot));
  }

  /** Undo of `place` (removes the most recently placed totem at `cell`). */
  unplace(slot: number, cell: number): void {
    const list = this.pieces[slot]!;
    this.pieces[slot] = list.filter((c) => c !== cell);
    this.setCell(cell, EMPTY);
  }

  shoot(cell: number): void {
    this.setCell(cell, FIRE);
  }

  unshoot(cell: number): void {
    this.setCell(cell, EMPTY);
  }

  /** Full turn; returns the piece index needed by `unmake`. */
  make(slot: number, a: number): number {
    const k = this.move(slot, fromOf(a), toOf(a));
    this.shoot(shootOf(a));
    return k;
  }

  unmake(slot: number, a: number, k: number): void {
    this.unshoot(shootOf(a));
    this.unmove(slot, fromOf(a), toOf(a), k);
  }

  /** Writes queen-reachable empty cells from `from` into `out` starting at `at`; returns new length. */
  rays(from: number, out: Int16Array | number[], at: number): number {
    const ray = this.g.ray;
    const cells = this.cells;
    for (let d = 0; d < 8; d++) {
      let v = ray[from * 8 + d]!;
      while (v >= 0 && cells[v] === EMPTY) {
        out[at++] = v;
        v = ray[v * 8 + d]!;
      }
    }
    return at;
  }

  /** Number of queen-reachable empty cells from `from`. */
  reach(from: number): number {
    const ray = this.g.ray;
    const cells = this.cells;
    let n = 0;
    for (let d = 0; d < 8; d++) {
      let v = ray[from * 8 + d]!;
      while (v >= 0 && cells[v] === EMPTY) {
        n++;
        v = ray[v * 8 + d]!;
      }
    }
    return n;
  }

  /** Empty king-neighbours of `i`. */
  emptyNeighbours(i: number): number {
    const ray = this.g.ray;
    let n = 0;
    for (let d = 0; d < 8; d++) {
      const v = ray[i * 8 + d]!;
      if (v >= 0 && this.cells[v] === EMPTY) n++;
    }
    return n;
  }

  /** True if `slot` can complete a full turn (move AND shoot). */
  hasAction(slot: number): boolean {
    const list = this.pieces[slot]!;
    const ray = this.g.ray;
    const cells = this.cells;
    for (let p = 0; p < list.length; p++) {
      const from = list[p]!;
      for (let d = 0; d < 8; d++) {
        let to = ray[from * 8 + d]!;
        while (to >= 0 && cells[to] === EMPTY) {
          // After moving, `from` is fire; any other empty neighbour of `to` is a legal arrow.
          for (let e = 0; e < 8; e++) {
            const v = ray[to * 8 + e]!;
            if (v >= 0 && v !== from && cells[v] === EMPTY) return true;
          }
          to = ray[to * 8 + d]!;
        }
      }
    }
    return false;
  }

  /** All legal packed actions of `slot` (exhaustive; used for small boards, tests, fallbacks). */
  allActions(slot: number, out: number[] = []): number[] {
    out.length = 0;
    const list = this.pieces[slot]!;
    const dests: number[] = [];
    const arrows: number[] = [];
    for (let p = 0; p < list.length; p++) {
      const from = list[p]!;
      dests.length = 0;
      const nd = this.rays(from, dests, 0);
      for (let i = 0; i < nd; i++) {
        const to = dests[i]!;
        const k = this.move(slot, from, to);
        arrows.length = 0;
        const na = this.rays(to, arrows, 0);
        for (let j = 0; j < na; j++) out.push(pack(from, to, arrows[j]!));
        this.unmove(slot, from, to, k);
      }
    }
    return out;
  }

  /** Movement pairs (from | to << 8) of `slot` that leave at least one arrow. */
  movePairs(slot: number, out: number[] = []): number[] {
    out.length = 0;
    const list = this.pieces[slot]!;
    const ray = this.g.ray;
    const cells = this.cells;
    for (let p = 0; p < list.length; p++) {
      const from = list[p]!;
      for (let d = 0; d < 8; d++) {
        let to = ray[from * 8 + d]!;
        while (to >= 0 && cells[to] === EMPTY) {
          for (let e = 0; e < 8; e++) {
            const v = ray[to * 8 + e]!;
            if (v >= 0 && v !== from && cells[v] === EMPTY) {
              out.push(from | (to << 8));
              break;
            }
          }
          to = ray[to * 8 + d]!;
        }
      }
    }
    return out;
  }

  /** Opponent slots of `slot` that are still alive. */
  opponents(slot: number): number[] {
    const out: number[] = [];
    for (const s of this.order) if (s !== slot && this.aliveMask & (1 << s)) out.push(s);
    return out;
  }

  toPosition(i: number): Position {
    return { row: this.g.row[i]!, col: this.g.col[i]! };
  }

  toAction(a: number): MoveAction {
    return { from: this.toPosition(fromOf(a)), to: this.toPosition(toOf(a)), shoot: this.toPosition(shootOf(a)) };
  }
}

export const slotOf = (p: PlayerId): number => ALL_PLAYERS.indexOf(p);
export const playerOf = (slot: number): PlayerId => ALL_PLAYERS[slot]!;

/** Algebraic coordinate (a1 = row 0, col 0), matching `/shared/telemetry.ts`. */
export function cellName(fb: FastBoard, i: number): string {
  return `${String.fromCharCode(97 + fb.g.col[i]!)}${fb.g.row[i]! + 1}`;
}

export function actionName(fb: FastBoard, a: number): string {
  return `${cellName(fb, fromOf(a))}-${cellName(fb, toOf(a))}/${cellName(fb, shootOf(a))}`;
}

// ---------------------------------------------------------------------------
// Anytime clock
// ---------------------------------------------------------------------------

/** Thrown (as a singleton, no stack capture) when a search runs out of time. */
export class Timeout extends Error {}
export const TIMEOUT = new Timeout('search deadline');

export class Clock {
  nodes = 0;
  constructor(readonly deadline: number) {}

  static fromBudget(budgetMs: number): Clock {
    return new Clock(performance.now() + budgetMs);
  }

  /** Counts a node; throws `TIMEOUT` once the deadline has passed (checked every 64 nodes). */
  tick(): void {
    if ((++this.nodes & 63) === 0 && performance.now() >= this.deadline) throw TIMEOUT;
  }

  expired(): boolean {
    return performance.now() >= this.deadline;
  }

  remaining(): number {
    return this.deadline - performance.now();
  }

  /** A sub-clock that ends at `fraction` of the remaining time (never later than this one). */
  slice(fraction: number): Clock {
    const c = new Clock(performance.now() + Math.max(0, this.remaining()) * fraction);
    return c;
  }
}

// ---------------------------------------------------------------------------
// BFS distance maps
// ---------------------------------------------------------------------------

/** Reusable buffers sized for one board (one per bot instance; not thread-shared). */
export class Scratch {
  readonly q1me: Uint8Array;
  readonly q1op: Uint8Array;
  readonly k2me: Uint8Array;
  readonly k2op: Uint8Array;
  readonly tmp: Uint8Array;
  readonly queue: Int16Array;
  readonly comp: Int16Array;
  readonly mark: Uint8Array;
  readonly list: Int16Array;
  constructor(size: number) {
    this.q1me = new Uint8Array(size);
    this.q1op = new Uint8Array(size);
    this.k2me = new Uint8Array(size);
    this.k2op = new Uint8Array(size);
    this.tmp = new Uint8Array(size);
    this.queue = new Int16Array(size + 8);
    this.comp = new Int16Array(size);
    this.mark = new Uint8Array(size);
    this.list = new Int16Array(size * 8);
  }
}

/**
 * Multi-source Queen-move distance (number of queen moves to reach each empty cell)
 * from the pieces of every slot in `slotMask`. Sources get 0; unreachable = INF.
 */
export function queenDistance(fb: FastBoard, slotMask: number, out: Uint8Array, queue: Int16Array): void {
  out.fill(INF);
  let head = 0;
  let tail = 0;
  for (let s = 0; s < 4; s++) {
    if (!(slotMask & (1 << s))) continue;
    const list = fb.pieces[s]!;
    for (let p = 0; p < list.length; p++) {
      out[list[p]!] = 0;
      queue[tail++] = list[p]!;
    }
  }
  const ray = fb.g.ray;
  const cells = fb.cells;
  while (head < tail) {
    const u = queue[head++]!;
    const nd = out[u]! + 1;
    for (let d = 0; d < 8; d++) {
      let v = ray[u * 8 + d]!;
      while (v >= 0 && cells[v] === EMPTY) {
        const cur = out[v]!;
        if (cur < nd) break; // reached at least as early from elsewhere; beyond is covered too
        if (cur > nd) {
          out[v] = nd;
          queue[tail++] = v;
        }
        v = ray[v * 8 + d]!;
      }
    }
  }
}

/** Single-piece Queen distance (used for per-amazon enclosure / reach analysis). */
export function queenDistanceFrom(fb: FastBoard, cell: number, out: Uint8Array, queue: Int16Array, maxD = INF): void {
  out.fill(INF);
  out[cell] = 0;
  queue[0] = cell;
  let head = 0;
  let tail = 1;
  const ray = fb.g.ray;
  const cells = fb.cells;
  while (head < tail) {
    const u = queue[head++]!;
    const nd = out[u]! + 1;
    if (nd > maxD) continue;
    for (let d = 0; d < 8; d++) {
      let v = ray[u * 8 + d]!;
      while (v >= 0 && cells[v] === EMPTY) {
        const cur = out[v]!;
        if (cur < nd) break;
        if (cur > nd) {
          out[v] = nd;
          queue[tail++] = v;
        }
        v = ray[v * 8 + d]!;
      }
    }
  }
}

/** Multi-source King-move distance (steps through empty cells). */
export function kingDistance(fb: FastBoard, slotMask: number, out: Uint8Array, queue: Int16Array): void {
  out.fill(INF);
  let head = 0;
  let tail = 0;
  for (let s = 0; s < 4; s++) {
    if (!(slotMask & (1 << s))) continue;
    const list = fb.pieces[s]!;
    for (let p = 0; p < list.length; p++) {
      out[list[p]!] = 0;
      queue[tail++] = list[p]!;
    }
  }
  kingFlood(fb, out, queue, head, tail, INF);
}

/** Single-source King distance from `cell`, up to `maxD`. */
export function kingDistanceFrom(fb: FastBoard, cell: number, out: Uint8Array, queue: Int16Array, maxD = INF): void {
  out.fill(INF);
  out[cell] = 0;
  queue[0] = cell;
  kingFlood(fb, out, queue, 0, 1, maxD);
}

function kingFlood(fb: FastBoard, out: Uint8Array, queue: Int16Array, head: number, tail: number, maxD: number): void {
  const ray = fb.g.ray;
  const cells = fb.cells;
  while (head < tail) {
    const u = queue[head++]!;
    const nd = out[u]! + 1;
    if (nd > maxD) continue;
    for (let d = 0; d < 8; d++) {
      const v = ray[u * 8 + d]!;
      if (v >= 0 && cells[v] === EMPTY && out[v]! > nd) {
        out[v] = nd;
        queue[tail++] = v;
      }
    }
  }
}

/** Bitmask of every alive slot except `slot`. */
export function opponentMask(fb: FastBoard, slot: number): number {
  return fb.aliveMask & ~(1 << slot) & 15;
}

// ---------------------------------------------------------------------------
// Territory features (Lieberum / Zhang notation)
// ---------------------------------------------------------------------------

export interface Features {
  /** Queen-distance territory: Σ Δ(D1me, D1opp). */
  t1: number;
  /** King-distance territory: Σ Δ(D2me, D2opp). */
  t2: number;
  /** Lieberum c1 = 2 Σ (2^-D1me − 2^-D1opp). */
  c1: number;
  /** Lieberum c2 = Σ clamp((D2opp − D2me) / 6, −1, 1). */
  c2: number;
  /** Openness w = Σ 2^-|D1me − D1opp| over cells both sides reach. */
  w: number;
  /** Squares reachable by either side. */
  live: number;
  /** Contested squares (equal finite queen distance). */
  contested: number;
  /** Squares only `me` reaches (D1opp = INF). */
  safeMe: number;
  safeOpp: number;
  /** Total queen reach of my pieces vs average opponent reach. */
  mobMe: number;
  mobOpp: number;
  /** Pieces with zero queen reach. */
  trappedMe: number;
  trappedOpp: number;
}

/**
 * Computes distance maps (into `s.q1me/q1op/k2me/k2op`) and territory features
 * from `me`'s point of view against the union of alive opponents.
 * `tieK`: value of an equal-distance square (positive when `me` is to move).
 */
export function features(fb: FastBoard, me: number, s: Scratch, tieK: number, withKing = true): Features {
  const opMask = opponentMask(fb, me);
  queenDistance(fb, 1 << me, s.q1me, s.queue);
  queenDistance(fb, opMask, s.q1op, s.queue);
  if (withKing) {
    kingDistance(fb, 1 << me, s.k2me, s.queue);
    kingDistance(fb, opMask, s.k2op, s.queue);
  }
  let t1 = 0;
  let t2 = 0;
  let c1 = 0;
  let c2 = 0;
  let w = 0;
  let live = 0;
  let contested = 0;
  let safeMe = 0;
  let safeOpp = 0;
  const cells = fb.cells;
  for (let i = 0; i < fb.size; i++) {
    if (cells[i] !== EMPTY) continue;
    const a = s.q1me[i]!;
    const b = s.q1op[i]!;
    if (a === INF && b === INF) continue;
    live++;
    if (a < b) t1 += 1;
    else if (a > b) t1 -= 1;
    else {
      t1 += tieK;
      contested++;
    }
    if (b === INF) safeMe++;
    else if (a === INF) safeOpp++;
    else w += POW2NEG[a > b ? a - b : b - a]!;
    c1 += POW2NEG[a]! - POW2NEG[b]!;
    if (withKing) {
      const ka = s.k2me[i]!;
      const kb = s.k2op[i]!;
      if (ka < kb) t2 += 1;
      else if (ka > kb) t2 -= 1;
      else if (ka !== INF) t2 += tieK;
      const diff = kb === INF ? (ka === INF ? 0 : 6) : ka === INF ? -6 : kb - ka;
      c2 += diff > 6 ? 1 : diff < -6 ? -1 : diff / 6;
    }
  }
  const myList = fb.pieces[me]!;
  let mobMe = 0;
  let trappedMe = 0;
  for (let p = 0; p < myList.length; p++) {
    const r = fb.reach(myList[p]!);
    mobMe += r;
    if (r === 0) trappedMe++;
  }
  let mobOpp = 0;
  let trappedOpp = 0;
  let nOpp = 0;
  for (let o = 0; o < 4; o++) {
    if (!(opMask & (1 << o))) continue;
    nOpp++;
    const list = fb.pieces[o]!;
    for (let p = 0; p < list.length; p++) {
      const r = fb.reach(list[p]!);
      mobOpp += r;
      if (r === 0) trappedOpp++;
    }
  }
  if (nOpp > 0) mobOpp /= nOpp;
  return { t1, t2, c1: 2 * c1, c2, w, live, contested, safeMe, safeOpp, mobMe, mobOpp, trappedMe, trappedOpp };
}

/** Game progress in [0, 1]: share of the originally free squares that are now fire. */
export function progress(fb: FastBoard): number {
  let pieces = 0;
  for (let s = 0; s < 4; s++) pieces += fb.pieces[s]!.length;
  const free = fb.size - pieces;
  return free > 0 ? 1 - fb.empties / free : 1;
}

/** Elimination term: proven loss if `me` cannot act, bonus per opponent that cannot act. */
export function eliminationTerm(fb: FastBoard, me: number, bonus: number): number {
  if (!fb.hasAction(me)) return -WIN / 2;
  let v = 0;
  for (const o of fb.order) if (o !== me && fb.isAlive(o) && !fb.hasAction(o)) v += bonus;
  return v;
}

// ---------------------------------------------------------------------------
// Region decomposition (8-connected empty components)
// ---------------------------------------------------------------------------

export interface Region {
  readonly id: number;
  /** Cell indices (view into a fresh array). */
  readonly cells: number[];
  /** Bitmask of alive slots with a piece king-adjacent to the region. */
  readonly tribes: number;
  /** Adjacent piece cells, with their slot. */
  readonly pieces: Array<{ cell: number; slot: number }>;
  /** Cells with at most one empty neighbour (dead ends / filling defects). */
  readonly deadEnds: number;
}

/** Labels 8-connected empty components into `s.comp` (−1 for non-empty) and describes each. */
export function regions(fb: FastBoard, s: Scratch): Region[] {
  const comp = s.comp;
  comp.fill(-1);
  const out: Region[] = [];
  const ray = fb.g.ray;
  const cells = fb.cells;
  const queue = s.queue;
  for (let start = 0; start < fb.size; start++) {
    if (cells[start] !== EMPTY || comp[start] !== -1) continue;
    const id = out.length;
    const list: number[] = [];
    let tribes = 0;
    let deadEnds = 0;
    const adj: Array<{ cell: number; slot: number }> = [];
    comp[start] = id;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const u = queue[head++]!;
      list.push(u);
      let deg = 0;
      for (let d = 0; d < 8; d++) {
        const v = ray[u * 8 + d]!;
        if (v < 0) continue;
        const c = cells[v]!;
        if (c === EMPTY) {
          deg++;
          if (comp[v] === -1) {
            comp[v] = id;
            queue[tail++] = v;
          }
        } else if (c >= 2) {
          const slot = c - 2;
          if (fb.isAlive(slot)) {
            tribes |= 1 << slot;
            if (!adj.some((x) => x.cell === v)) adj.push({ cell: v, slot });
          }
        }
      }
      if (deg <= 1) deadEnds++;
    }
    out.push({ id, cells: list, tribes, pieces: adj, deadEnds });
  }
  return out;
}

export const popcount = (m: number): number => {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
};

/** True when no region is touched by two different alive tribes (the game is a sum of independent territories). */
export function isDecomposed(rs: ReadonlyArray<Region>): boolean {
  return rs.every((r) => popcount(r.tribes) <= 1);
}

// ---------------------------------------------------------------------------
// Filling: plodding lower bound, upper bound, single-agent endgame search
// ---------------------------------------------------------------------------

/**
 * Upper bound on the turns `slot` can play inside its exclusive region:
 * each Tribal Wars turn consumes two empty squares (destination + arrow).
 */
export function fillUpperBound(region: Region): number {
  return Math.floor(region.cells.length / 2);
}

/**
 * Plodding filling heuristic (lower bound): repeatedly king-step the region's
 * pieces of `slot` into the neighbour with the fewest exits (Warnsdorff) and burn
 * the arrow on the most "dead-end" neighbour that keeps a continuation.
 * Operates on a clone; returns the number of turns achieved.
 */
export function plodFill(fb: FastBoard, slot: number, region: Region, maxTurns = 200): number {
  const b = fb.clone();
  const inRegion = new Uint8Array(fb.size);
  for (const c of region.cells) inRegion[c] = 1;
  const ray = b.g.ray;
  let turns = 0;
  const list = b.pieces[slot]!;
  while (turns < maxTurns) {
    let best = -1;
    let bestScore = Infinity;
    let bestFrom = -1;
    for (let p = 0; p < list.length; p++) {
      const from = list[p]!;
      for (let d = 0; d < 8; d++) {
        const to = ray[from * 8 + d]!;
        if (to < 0 || b.cells[to] !== EMPTY || !inRegion[to]) continue;
        // arrow candidates around `to` (excluding `from`, which becomes fire)
        for (let e = 0; e < 8; e++) {
          const a = ray[to * 8 + e]!;
          if (a < 0 || a === from || b.cells[a] !== EMPTY) continue;
          const degTo = b.emptyNeighbours(to);
          const degA = b.emptyNeighbours(a);
          // Keep a continuation: after the arrow, `to` should still have an exit.
          const s = (degTo - 1 > 0 ? 0 : 1000) + degTo * 4 + degA;
          if (s < bestScore) {
            bestScore = s;
            best = pack(from, to, a);
            bestFrom = from;
          }
        }
      }
    }
    if (best < 0 || bestFrom < 0) break;
    b.make(slot, best);
    turns++;
  }
  return turns;
}

/**
 * Single-agent endgame search for a decomposed position: finds the action that
 * maximises how many consecutive turns `slot` can still play in its own
 * territories (opponents cannot interfere). Iterative deepening on the target
 * length, starting just above the plodding lower bound, until the deadline.
 */
export function bestFillAction(
  fb: FastBoard,
  slot: number,
  clock: Clock,
): { action: number; turns: number; proven: boolean; nodes: number } {
  const rs = regions(fb, new Scratch(fb.size));
  let lower = 0;
  let upper = 0;
  for (const r of rs) {
    if (r.tribes === 1 << slot) {
      lower += plodFill(fb, slot, r);
      upper += fillUpperBound(r);
    }
  }
  const actions = fb.allActions(slot);
  if (actions.length === 0) return { action: -1, turns: 0, proven: true, nodes: 0 };
  // Order by Warnsdorff: few exits at the destination first, arrow on dead ends.
  const score = (a: number) => fb.emptyNeighbours(toOf(a)) * 4 + fb.emptyNeighbours(shootOf(a));
  actions.sort((x, y) => score(x) - score(y));
  let best = actions[0]!;
  let bestTurns = Math.max(1, Math.min(lower, upper));
  let nodes = 0;
  const b = fb.clone();
  const buf: number[][] = [];

  const canPlay = (depth: number, ply: number): boolean => {
    if (depth === 0) return true;
    clock.tick();
    nodes++;
    const list = b.allActions(slot, (buf[ply] ??= []));
    if (list.length === 0) return false;
    list.sort((x, y) => b.emptyNeighbours(toOf(x)) * 4 + b.emptyNeighbours(shootOf(x)) - (b.emptyNeighbours(toOf(y)) * 4 + b.emptyNeighbours(shootOf(y))));
    const copy = list.slice(0, 24);
    for (const a of copy) {
      const k = b.make(slot, a);
      const ok = canPlay(depth - 1, ply + 1);
      b.unmake(slot, a, k);
      if (ok) return true;
    }
    return false;
  };

  let proven = false;
  try {
    for (let target = bestTurns; target <= upper; target++) {
      let found = -1;
      for (const a of actions.slice(0, 48)) {
        const k = b.make(slot, a);
        const ok = canPlay(target - 1, 0);
        b.unmake(slot, a, k);
        if (ok) {
          found = a;
          break;
        }
      }
      if (found < 0) break; // (selective: not a proof, just the best line found)
      best = found;
      bestTurns = target;
      if (target === upper) proven = true;
    }
  } catch (err) {
    if (err !== TIMEOUT) throw err;
  }
  return { action: best, turns: bestTurns, proven, nodes };
}

// ---------------------------------------------------------------------------
// Candidate generation (two-stage selective move generation)
// ---------------------------------------------------------------------------

export interface TwoStageOptions {
  /** Score after the movement half (from = FIRE, to = piece), mover's perspective. */
  moveScore(fb: FastBoard, slot: number, from: number, to: number): number;
  /** Score of an arrow square after the movement (mover's perspective, higher = better); may use maps set by `prepareArrows`. */
  arrowScore(fb: FastBoard, slot: number, to: number, shoot: number): number;
  /** Called once per kept move (after the movement half) before arrows are scored. */
  prepareArrows?(fb: FastBoard, slot: number, from: number, to: number): void;
  /** Movement pairs to keep: absolute count (>= 1) or fraction (0, 1). */
  moveKeep: number;
  arrowsPerMove: number;
  /** Optional movement filter (e.g. only pieces bordering an active area). */
  filter?(from: number, to: number): boolean;
  /** Final number of actions returned. */
  keep: number;
  /** Weight of the move score in the final ordering. */
  moveWeight?: number;
}

/**
 * Selective generation (Müller & Tegos style layered pruning): rank every movement
 * pair, keep the best, rank the arrows of each kept movement, return the best
 * `keep` full actions, ordered best-first.
 */
export function twoStage(fb: FastBoard, slot: number, opt: TwoStageOptions, clock: Clock | null): number[] {
  const pairs = fb.movePairs(slot);
  if (pairs.length === 0) return [];
  const scored: Array<{ pair: number; score: number }> = [];
  for (const pair of pairs) {
    const from = pair & 0xff;
    const to = (pair >>> 8) & 0xff;
    if (opt.filter && !opt.filter(from, to)) continue;
    const k = fb.move(slot, from, to);
    scored.push({ pair, score: opt.moveScore(fb, slot, from, to) });
    fb.unmove(slot, from, to, k);
    clock?.tick();
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  const keepMoves = opt.moveKeep < 1 ? Math.max(1, Math.ceil(scored.length * opt.moveKeep)) : Math.min(scored.length, opt.moveKeep);
  const out: Array<{ a: number; score: number }> = [];
  const arrows: number[] = [];
  const mw = opt.moveWeight ?? 1;
  for (let m = 0; m < keepMoves; m++) {
    const { pair, score } = scored[m]!;
    const from = pair & 0xff;
    const to = (pair >>> 8) & 0xff;
    const k = fb.move(slot, from, to);
    opt.prepareArrows?.(fb, slot, from, to);
    arrows.length = 0;
    const na = fb.rays(to, arrows, 0);
    const local: Array<{ a: number; score: number }> = [];
    for (let j = 0; j < na; j++) {
      const sh = arrows[j]!;
      local.push({ a: pack(from, to, sh), score: mw * score + opt.arrowScore(fb, slot, to, sh) });
    }
    fb.unmove(slot, from, to, k);
    local.sort((x, y) => y.score - x.score);
    for (let j = 0; j < Math.min(opt.arrowsPerMove, local.length); j++) out.push(local[j]!);
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, opt.keep).map((x) => x.a);
}

/**
 * Standard arrow heuristic from post-move distance maps: burn squares the
 * opponents reach first (or contest), especially next to their pieces;
 * never waste arrows inside our own safe territory.
 */
export function arrowValue(fb: FastBoard, me: number, cell: number, dMe: Uint8Array, dOp: Uint8Array): number {
  const a = dMe[cell]!;
  const b = dOp[cell]!;
  let v = 0;
  if (b === INF) v -= 2; // our own safe square: wasted arrow
  else if (a === INF) v += 0.5; // already theirs
  else if (b < a) v += 1;
  else if (b === a) v += 1.5; // contested: most valuable
  else v -= 0.5;
  if (b === 1) v += 1; // adjacent to their lines: restricts mobility
  // Adjacent to an opponent piece: tightens enclosure.
  const ray = fb.g.ray;
  for (let d = 0; d < 8; d++) {
    const n = ray[cell * 8 + d]!;
    if (n >= 0) {
      const c = fb.cells[n]!;
      if (c >= 2 && c - 2 !== me) v += 0.75;
    }
  }
  return v;
}

/** Random legal action for rollouts (rejection sampling, then exhaustive fallback). Returns -1 if none. */
export function randomAction(fb: FastBoard, slot: number, rnd: () => number): number {
  const list = fb.pieces[slot]!;
  if (list.length === 0) return -1;
  const ray = fb.g.ray;
  const cells = fb.cells;
  for (let attempt = 0; attempt < 24; attempt++) {
    const from = list[Math.floor(rnd() * list.length)]!;
    const d = Math.floor(rnd() * 8);
    // count cells along the ray, pick one uniformly
    let len = 0;
    let v = ray[from * 8 + d]!;
    while (v >= 0 && cells[v] === EMPTY) {
      len++;
      v = ray[v * 8 + d]!;
    }
    if (len === 0) continue;
    let steps = 1 + Math.floor(rnd() * len);
    let to = from;
    while (steps-- > 0) to = ray[to * 8 + d]!;
    // arrow: random direction from `to` (from becomes fire)
    for (let tries = 0; tries < 8; tries++) {
      const e = Math.floor(rnd() * 8);
      let alen = 0;
      let w = ray[to * 8 + e]!;
      while (w >= 0 && (cells[w] === EMPTY && w !== from)) {
        alen++;
        w = ray[w * 8 + e]!;
      }
      if (alen === 0) continue;
      let s = 1 + Math.floor(rnd() * alen);
      let sh = to;
      while (s-- > 0) sh = ray[sh * 8 + e]!;
      return pack(from, to, sh);
    }
  }
  const all = fb.allActions(slot);
  return all.length > 0 ? all[Math.floor(rnd() * all.length)]! : -1;
}

/** Formats `[Depth 4 | 18,420 nodes | Score +12.4]`-style stats. */
export function statLine(parts: Array<[string, string | number | null | undefined]>): string {
  return `[${parts
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => (k === '' ? String(v) : `${k} ${typeof v === 'number' ? v.toLocaleString('en-US') : v}`))
    .join(' | ')}]`;
}

export const signed = (v: number, digits = 1): string => {
  if (Math.abs(v) >= WIN / 4) return v > 0 ? 'WIN' : 'LOSS';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
};

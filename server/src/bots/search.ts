/**
 * Search engines shared by the research bots.
 *
 * - `AlphaBeta`: anytime iterative-deepening paranoid alpha-beta for 2-4 players
 *   (the root tribe maximises, every opponent minimises the same root-perspective
 *   evaluation). Options: transposition table, aspiration windows, NegaScout/PVS
 *   null windows, killer moves. Eliminated tribes are skipped like in the engine.
 * - `MoveGroupMcts`: UCT with Move Groups (movement node -> arrow node), so the
 *   branching factor of one Tribal Wars turn is split into two smaller layers.
 *
 * Both are interrupted by `Clock` deadlines and always return the best result of
 * the deepest completed iteration (or the best fully-searched root move).
 */
import { Clock, FastBoard, TIMEOUT, WIN, fromOf, pack, randomAction, shootOf, toOf } from './evalUtils.js';

// ---------------------------------------------------------------------------
// Alpha-beta
// ---------------------------------------------------------------------------

export interface AbHooks {
  /** Root-perspective static evaluation (higher = better for `root`). */
  evaluate(fb: FastBoard, root: number, toMove: number): number;
  /** Ordered (best-first), already-pruned candidate actions for `slot` at `ply`. */
  candidates(fb: FastBoard, slot: number, ply: number, clock: Clock, last: number): number[];
  /** Optional root-only wider candidate list. */
  rootCandidates?(fb: FastBoard, slot: number, clock: Clock, last: number): number[];
}

export interface AbOptions {
  maxDepth: number;
  tt: boolean;
  /** Aspiration half-window (null = full window every iteration). */
  aspiration: number | null;
  pvs: boolean;
  killers: boolean;
  /** Smallest meaningful score difference (null window width for PVS). */
  epsilon: number;
}

export interface AbResult {
  action: number;
  score: number;
  /** Deepest fully completed iteration. */
  depth: number;
  nodes: number;
  /** Root candidates considered. */
  width: number;
  ttHits: number;
  researches: number;
  proven: boolean;
  /** Principal variation (packed actions) from the TT, may be short. */
  pv: number[];
}

const EXACT = 0;
const LOWER = 1;
const UPPER = 2;

/** Fixed-size always-replace-if-deeper transposition table. */
class TransTable {
  readonly mask: number;
  readonly keyLo: Uint32Array;
  readonly keyHi: Int32Array;
  readonly depth: Int8Array;
  readonly flag: Uint8Array;
  readonly score: Float64Array;
  readonly best: Int32Array;
  constructor(bits: number) {
    const n = 1 << bits;
    this.mask = n - 1;
    this.keyLo = new Uint32Array(n);
    this.keyHi = new Int32Array(n);
    this.depth = new Int8Array(n).fill(-1);
    this.flag = new Uint8Array(n);
    this.score = new Float64Array(n);
    this.best = new Int32Array(n).fill(-1);
  }
  index(lo: number): number {
    return lo & this.mask;
  }
}

export class AlphaBeta {
  private readonly tt: TransTable | null;
  private readonly killer: Int32Array;
  private clock!: Clock;
  private root = 0;
  private ttHits = 0;
  private researches = 0;

  constructor(
    private readonly fb: FastBoard,
    private readonly hooks: AbHooks,
    private readonly opt: AbOptions,
  ) {
    this.tt = opt.tt ? new TransTable(fb.size > 100 ? 18 : 17) : null;
    this.killer = new Int32Array(128).fill(-1);
  }

  run(slot: number, clock: Clock, rootLast = -1): AbResult {
    this.clock = clock;
    this.root = slot;
    const fb = this.fb;
    let roots = this.hooks.rootCandidates ? this.hooks.rootCandidates(fb, slot, clock, rootLast) : this.hooks.candidates(fb, slot, 0, clock, rootLast);
    const result: AbResult = { action: roots[0] ?? -1, score: 0, depth: 0, nodes: 0, width: roots.length, ttHits: 0, researches: 0, proven: false, pv: [] };
    if (roots.length <= 1) {
      result.proven = roots.length === 1 && fb.aliveCount() <= 1;
      result.nodes = clock.nodes;
      return result;
    }
    const scores = new Map<number, number>();
    let prev = 0;
    const snap = fb.snapshot();
    try {
      for (let depth = 1; depth <= this.opt.maxDepth; depth++) {
        let alpha = -Infinity;
        let beta = Infinity;
        if (this.opt.aspiration !== null && depth > 1 && Math.abs(prev) < WIN / 4) {
          alpha = prev - this.opt.aspiration;
          beta = prev + this.opt.aspiration;
        }
        let iter = this.rootSearch(roots, depth, alpha, beta, scores);
        if (iter.complete && (iter.score <= alpha || iter.score >= beta)) {
          // Aspiration failure: re-search with a full window.
          this.researches++;
          iter = this.rootSearch(roots, depth, -Infinity, Infinity, scores);
        }
        result.action = iter.best;
        result.score = iter.score;
        result.depth = depth;
        prev = iter.score;
        roots = [...roots].sort((a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity));
        if (Math.abs(iter.score) >= WIN / 4) {
          result.proven = true;
          break;
        }
        if (clock.remaining() < 1) break;
      }
    } catch (err) {
      // The deadline interrupts make/unmake mid-tree: put the board back first.
      fb.restore(snap);
      if (err !== TIMEOUT) throw err;
      // Partial iteration: root moves are ordered previous-best first, so once any root move
      // finished at the new depth, the best finished move is at least as reliable as the old choice.
      if (this.partialBest !== -1) {
        result.action = this.partialBest;
        result.score = this.partialScore;
      }
    }
    result.nodes = clock.nodes;
    result.ttHits = this.ttHits;
    result.researches = this.researches;
    result.pv = this.principalVariation(result.action);
    return result;
  }

  private partialBest = -1;
  private partialScore = -Infinity;

  private rootSearch(roots: number[], depth: number, alpha: number, beta: number, scores: Map<number, number>): { best: number; score: number; complete: boolean } {
    const fb = this.fb;
    const me = this.root;
    let best = roots[0]!;
    let bestScore = -Infinity;
    this.partialBest = -1;
    this.partialScore = -Infinity;
    let first = true;
    for (const a of roots) {
      const k = fb.make(me, a);
      let v: number;
      const next = this.nextToMove(me);
      if (this.opt.pvs && !first) {
        v = this.search(depth - 1, alpha, alpha + this.opt.epsilon, next, 1, a);
        if (v > alpha && v < beta) v = this.search(depth - 1, alpha, beta, next, 1, a);
      } else {
        v = this.search(depth - 1, alpha, beta, next, 1, a);
      }
      fb.unmake(me, a, k);
      first = false;
      scores.set(a, v);
      if (v > bestScore) {
        bestScore = v;
        best = a;
        this.partialBest = a;
        this.partialScore = v;
      }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return { best, score: bestScore, complete: true };
  }

  /** Next alive slot (elimination of a stuck tribe is handled inside `search`). */
  private nextToMove(slot: number): number {
    return this.fb.nextAlive(slot);
  }

  private search(depth: number, alpha: number, beta: number, slot: number, ply: number, last: number): number {
    const fb = this.fb;
    this.clock.tick();
    if (fb.aliveCount() <= 1) return fb.isAlive(this.root) ? WIN - ply : -WIN + ply;
    if (depth <= 0) return this.hooks.evaluate(fb, this.root, slot);

    const tt = this.tt;
    let ttMove = -1;
    let idx = 0;
    let lo = 0;
    let hi = 0;
    if (tt) {
      lo = fb.key(slot);
      hi = fb.keyHi(slot);
      idx = tt.index(lo);
      if (tt.keyLo[idx] === lo && tt.keyHi[idx] === hi && tt.depth[idx]! >= 0) {
        ttMove = tt.best[idx]!;
        if (tt.depth[idx]! >= depth) {
          const s = tt.score[idx]!;
          const f = tt.flag[idx]!;
          if (f === EXACT || (f === LOWER && s >= beta) || (f === UPPER && s <= alpha)) {
            this.ttHits++;
            return s;
          }
        }
      }
    }

    let moves = this.hooks.candidates(fb, slot, ply, this.clock, last);
    if (moves.length === 0) {
      // The side to move cannot complete a turn: eliminated (engine rule).
      if (slot === this.root) return -WIN + ply;
      const mask = fb.aliveMask;
      fb.aliveMask &= ~(1 << slot);
      const v = fb.aliveCount() <= 1 ? WIN - ply : this.search(depth - 1, alpha, beta, fb.nextAlive(slot), ply + 1, last);
      fb.aliveMask = mask;
      return v;
    }
    // Move ordering: TT move, then killer.
    const killer = this.opt.killers ? this.killer[ply] ?? -1 : -1;
    if (ttMove !== -1 || killer !== -1) {
      const front: number[] = [];
      if (ttMove !== -1 && this.isLegal(slot, ttMove)) front.push(ttMove);
      if (killer !== -1 && killer !== ttMove && this.isLegal(slot, killer)) front.push(killer);
      if (front.length > 0) moves = [...front, ...moves.filter((m) => !front.includes(m))];
    }

    const maximizing = slot === this.root;
    const a0 = alpha;
    const b0 = beta;
    let best = maximizing ? -Infinity : Infinity;
    let bestMove = moves[0]!;
    const next = fb.nextAlive(slot);
    let first = true;
    for (const a of moves) {
      const k = fb.make(slot, a);
      let v: number;
      if (this.opt.pvs && !first) {
        if (maximizing) {
          v = this.search(depth - 1, alpha, alpha + this.opt.epsilon, next, ply + 1, a);
          if (v > alpha && v < beta) v = this.search(depth - 1, alpha, beta, next, ply + 1, a);
        } else {
          v = this.search(depth - 1, beta - this.opt.epsilon, beta, next, ply + 1, a);
          if (v < beta && v > alpha) v = this.search(depth - 1, alpha, beta, next, ply + 1, a);
        }
      } else {
        v = this.search(depth - 1, alpha, beta, next, ply + 1, a);
      }
      fb.unmake(slot, a, k);
      first = false;
      if (maximizing) {
        if (v > best) {
          best = v;
          bestMove = a;
        }
        if (v > alpha) alpha = v;
      } else {
        if (v < best) {
          best = v;
          bestMove = a;
        }
        if (v < beta) beta = v;
      }
      if (alpha >= beta) {
        if (this.opt.killers && ply < this.killer.length) this.killer[ply] = a;
        break;
      }
    }

    if (tt) {
      if (tt.depth[idx]! <= depth || tt.keyLo[idx] !== lo) {
        tt.keyLo[idx] = lo;
        tt.keyHi[idx] = hi;
        tt.depth[idx] = Math.min(depth, 127);
        tt.score[idx] = best;
        tt.best[idx] = bestMove;
        tt.flag[idx] = best <= a0 ? UPPER : best >= b0 ? LOWER : EXACT;
      }
    }
    return best;
  }

  /** Cheap legality check for TT/killer moves (positions can collide or differ). */
  private isLegal(slot: number, a: number): boolean {
    const fb = this.fb;
    const from = fromOf(a);
    const to = toOf(a);
    const sh = shootOf(a);
    if (fb.cells[from] !== slot + 2 || from === to || to === sh || sh === from) return false;
    if (!this.lineClear(from, to, -1)) return false;
    return this.lineClear(to, sh, from);
  }

  private lineClear(a: number, b: number, alsoBlocked: number): boolean {
    const g = this.fb.g;
    const dr = Math.sign(g.row[b]! - g.row[a]!);
    const dc = Math.sign(g.col[b]! - g.col[a]!);
    const rr = Math.abs(g.row[b]! - g.row[a]!);
    const cc = Math.abs(g.col[b]! - g.col[a]!);
    if (!(rr === 0 || cc === 0 || rr === cc)) return false;
    const step = dr * this.fb.n + dc;
    let v = a + step;
    for (;;) {
      if (v === alsoBlocked || this.fb.cells[v] !== 0) return false;
      if (v === b) return true;
      v += step;
    }
  }

  private principalVariation(first: number): number[] {
    const pv: number[] = [];
    if (first < 0 || !this.tt) return first < 0 ? [] : [first];
    const fb = this.fb;
    const undo: Array<{ slot: number; a: number; k: number }> = [];
    let slot = this.root;
    let a = first;
    for (let i = 0; i < 6 && a >= 0; i++) {
      if (!this.isLegal(slot, a)) break;
      pv.push(a);
      const k = fb.make(slot, a);
      undo.push({ slot, a, k });
      slot = fb.nextAlive(slot);
      const idx = this.tt.index(fb.key(slot));
      a = this.tt.keyLo[idx] === fb.key(slot) && this.tt.keyHi[idx] === fb.keyHi(slot) ? this.tt.best[idx]! : -1;
    }
    for (let i = undo.length - 1; i >= 0; i--) fb.unmake(undo[i]!.slot, undo[i]!.a, undo[i]!.k);
    return pv;
  }
}

// ---------------------------------------------------------------------------
// MCTS with Move Groups
// ---------------------------------------------------------------------------

export interface MctsHooks {
  /** Root-perspective value in [0, 1] (probability-like) of a leaf position. */
  evaluate(fb: FastBoard, root: number, toMove: number): number;
  /** Movement pairs (from | to << 8) to expand for `slot`, best-first (prior order). */
  movePairs(fb: FastBoard, slot: number, isRoot: boolean): number[];
  /** Arrows (cells) for a movement already applied, best-first. */
  arrows(fb: FastBoard, slot: number, from: number, to: number): number[];
  /** Simulation from a leaf; returns root-perspective value in [0, 1]. */
  simulate(fb: FastBoard, root: number, toMove: number, rnd: () => number): number;
}

/** A tree node. `kind` 0 = decision (choose movement), 1 = movement (choose arrow). */
interface Node {
  kind: 0 | 1;
  /** Slot that chose the edge leading here (whose perspective `wins` is in). */
  mover: number;
  /** Slot to act at this node. */
  slot: number;
  /** Edge label: movement pair or arrow cell. */
  edge: number;
  visits: number;
  wins: number;
  children: Node[] | null;
  /** Unexpanded edges, best-first. */
  untried: number[] | null;
  terminal: boolean;
}

export interface MctsResult {
  action: number;
  simulations: number;
  rootVisits: number;
  /** Win-rate estimate of the chosen action, root perspective. */
  value: number;
  /** Expanded movement children at the root. */
  width: number;
  maxDepth: number;
  /** Top root actions by visits: [action, visits, value]. */
  top: Array<[number, number, number]>;
}

export class MoveGroupMcts {
  private maxDepth = 0;
  constructor(
    private readonly fb: FastBoard,
    private readonly hooks: MctsHooks,
    private readonly c: number,
    private readonly rnd: () => number,
  ) {}

  run(slot: number, clock: Clock, restrictRoot?: (pair: number) => boolean): MctsResult {
    const fb = this.fb;
    const root: Node = { kind: 0, mover: -1, slot, edge: -1, visits: 0, wins: 0, children: null, untried: null, terminal: false };
    let pairs = this.hooks.movePairs(fb, slot, true);
    if (restrictRoot) {
      const r = pairs.filter(restrictRoot);
      if (r.length > 0) pairs = r;
    }
    root.untried = pairs;
    root.children = [];
    let sims = 0;
    const path: Node[] = [];
    const undo: Array<{ t: 0 | 1; slot: number; from: number; to: number; k: number; cell: number }> = [];
    while (!clock.expired() || sims === 0) {
      path.length = 0;
      undo.length = 0;
      let node = root;
      path.push(node);
      let depth = 0;
      // Selection + expansion
      for (;;) {
        if (node.terminal) break;
        if (node.untried === null) this.initEdges(node);
        if (node.untried!.length > 0) {
          const edge = node.untried!.shift()!;
          const child = this.applyEdge(node, edge, undo);
          node.children!.push(child);
          node = child;
          path.push(node);
          depth++;
          break;
        }
        if (node.children!.length === 0) {
          node.terminal = true;
          break;
        }
        node = this.select(node);
        this.applyEdgeExisting(path[path.length - 1]!, node, undo);
        path.push(node);
        depth++;
      }
      if (depth > this.maxDepth) this.maxDepth = depth;
      // Simulation from the leaf. A movement node still needs its arrow before simulating.
      let value: number;
      if (node.kind === 1) {
        const arrows = this.hooks.arrows(fb, node.slot, fromOfPair(node.edge), toOfPair(node.edge));
        if (arrows.length === 0) value = this.hooks.evaluate(fb, root.slot, node.slot);
        else {
          const cell = arrows[0]!;
          fb.shoot(cell);
          value = this.hooks.simulate(fb, root.slot, fb.nextAlive(node.slot), this.rnd);
          fb.unshoot(cell);
        }
      } else if (node.terminal) {
        value = this.hooks.evaluate(fb, root.slot, node.slot);
      } else {
        value = this.hooks.simulate(fb, root.slot, node.slot, this.rnd);
      }
      // Backpropagation (each node stores wins from its mover's perspective).
      for (const n of path) {
        n.visits++;
        if (n.mover === root.slot) n.wins += value;
        else if (n.mover !== -1) n.wins += 1 - value;
      }
      for (let i = undo.length - 1; i >= 0; i--) {
        const u = undo[i]!;
        if (u.t === 0) fb.unmove(u.slot, u.from, u.to, u.k);
        else fb.unshoot(u.cell);
      }
      sims++;
      clock.nodes++;
    }
    // Final choice: most-visited movement, then its most-visited arrow.
    const ranked: Array<[number, number, number]> = [];
    for (const m of root.children!) {
      if (!m.children || m.children.length === 0) continue;
      let bestArrow = m.children[0]!;
      for (const a of m.children) if (a.visits > bestArrow.visits) bestArrow = a;
      const action = pack(fromOfPair(m.edge), toOfPair(m.edge), bestArrow.edge);
      ranked.push([action, m.visits, m.visits > 0 ? m.wins / m.visits : 0]);
    }
    ranked.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    let action = ranked[0]?.[0] ?? -1;
    if (action < 0) {
      // Not even one arrow expanded (tiny budget): first movement + first arrow.
      const pair = pairs[0];
      if (pair !== undefined) {
        const k = fb.move(slot, fromOfPair(pair), toOfPair(pair));
        const arrows = this.hooks.arrows(fb, slot, fromOfPair(pair), toOfPair(pair));
        fb.unmove(slot, fromOfPair(pair), toOfPair(pair), k);
        if (arrows.length > 0) action = pack(fromOfPair(pair), toOfPair(pair), arrows[0]!);
      }
    }
    return {
      action,
      simulations: sims,
      rootVisits: root.visits,
      value: ranked[0]?.[2] ?? 0.5,
      width: root.children!.length,
      maxDepth: this.maxDepth,
      top: ranked.slice(0, 3),
    };
  }

  private initEdges(node: Node): void {
    const fb = this.fb;
    node.children = [];
    if (node.kind === 0) {
      node.untried = this.hooks.movePairs(fb, node.slot, false);
      if (node.untried.length === 0) node.terminal = true;
    } else {
      node.untried = this.hooks.arrows(fb, node.slot, fromOfPair(node.edge), toOfPair(node.edge));
      if (node.untried.length === 0) node.terminal = true;
    }
  }

  private applyEdge(parent: Node, edge: number, undo: Array<{ t: 0 | 1; slot: number; from: number; to: number; k: number; cell: number }>): Node {
    const fb = this.fb;
    if (parent.kind === 0) {
      const from = fromOfPair(edge);
      const to = toOfPair(edge);
      const k = fb.move(parent.slot, from, to);
      undo.push({ t: 0, slot: parent.slot, from, to, k, cell: -1 });
      return { kind: 1, mover: parent.slot, slot: parent.slot, edge, visits: 0, wins: 0, children: null, untried: null, terminal: false };
    }
    fb.shoot(edge);
    undo.push({ t: 1, slot: parent.slot, from: -1, to: -1, k: 0, cell: edge });
    const next = fb.nextAlive(parent.slot);
    return { kind: 0, mover: parent.slot, slot: next, edge, visits: 0, wins: 0, children: null, untried: null, terminal: false };
  }

  private applyEdgeExisting(parent: Node, child: Node, undo: Array<{ t: 0 | 1; slot: number; from: number; to: number; k: number; cell: number }>): void {
    const fb = this.fb;
    if (parent.kind === 0) {
      const from = fromOfPair(child.edge);
      const to = toOfPair(child.edge);
      const k = fb.move(parent.slot, from, to);
      undo.push({ t: 0, slot: parent.slot, from, to, k, cell: -1 });
    } else {
      fb.shoot(child.edge);
      undo.push({ t: 1, slot: parent.slot, from: -1, to: -1, k: 0, cell: child.edge });
    }
  }

  private select(node: Node): Node {
    const logN = Math.log(node.visits + 1);
    let best = node.children![0]!;
    let bestU = -Infinity;
    for (const ch of node.children!) {
      const u = ch.visits === 0 ? Infinity : ch.wins / ch.visits + this.c * Math.sqrt(logN / ch.visits);
      if (u > bestU) {
        bestU = u;
        best = ch;
      }
    }
    return best;
  }
}

export const fromOfPair = (pair: number): number => pair & 0xff;
export const toOfPair = (pair: number): number => (pair >>> 8) & 0xff;

/**
 * Generic shallow rollout: play `depth` random turns (stuck tribes are eliminated),
 * evaluate, undo. Returns root-perspective [0, 1].
 */
export function shallowRollout(
  fb: FastBoard,
  root: number,
  toMove: number,
  depth: number,
  rnd: () => number,
  evaluate: (fb: FastBoard, root: number, toMove: number) => number,
): number {
  const undo: Array<{ slot: number; a: number; k: number }> = [];
  const mask = fb.aliveMask;
  let slot = toMove;
  for (let i = 0; i < depth && fb.aliveCount() > 1; i++) {
    const a = randomAction(fb, slot, rnd);
    if (a < 0) {
      if (slot === root) break;
      fb.aliveMask &= ~(1 << slot);
      slot = fb.nextAlive(slot);
      continue;
    }
    undo.push({ slot, a, k: fb.make(slot, a) });
    slot = fb.nextAlive(slot);
  }
  const v = evaluate(fb, root, slot);
  for (let i = undo.length - 1; i >= 0; i--) fb.unmake(undo[i]!.slot, undo[i]!.a, undo[i]!.k);
  fb.aliveMask = mask;
  return v;
}

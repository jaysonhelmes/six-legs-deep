// Sampled sprite simulation support: budgets, largest-remainder allocation, typed-array sprite pools (no per-frame
// allocation), view allocation from real counts, and BFS distance fields over open nest cells. Owner: WP8.
// Contract: ARCHITECTURE §13.4 (DESIGN §25.5). Pure: reads s/d, never writes them; no DOM.

import { GRID, CELL } from '../data/balance.js';
import { adultsTotal } from '../core/state.js';

/** Sprite budgets (ARCHITECTURE §13.4). */
export const BUDGET = Object.freeze({ below: 160, above: 260, battleSide: 40, flight: 120, hardCap: 600, seam: 20 });

/** How often (s) the per-view allocation is recomputed from real counts. */
export const REALLOC_SEC = 0.5;

/**
 * Largest-remainder (Hamilton) integer allocation.
 * Allocates `total` units over `weights` proportionally; `mins[i]` units are guaranteed first (scaled down by the same
 * method when Σ mins > total); `caps[i]` bounds each result (leftovers flow to the next-largest remainders).
 * Ties are broken by lower index, so the result is deterministic.
 * @param {ArrayLike<number>} weights non-negative
 * @param {number} total
 * @param {ArrayLike<number>|null} [mins=null]
 * @param {ArrayLike<number>|null} [caps=null]
 * @returns {number[]}
 */
export function largestRemainder(weights, total, mins = null, caps = null) {
  const n = weights ? weights.length : 0;
  const out = new Array(n).fill(0);
  let T = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  if (n === 0 || T === 0) return out;
  const w = new Array(n);
  const cap = new Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = weights[i] > 0 && Number.isFinite(weights[i]) ? weights[i] : 0;
    const c = caps ? caps[i] : Infinity;
    cap[i] = c >= 0 ? Math.floor(c) : 0;
  }
  // 1) guaranteed minimums
  if (mins) {
    const m = new Array(n);
    let sumM = 0;
    for (let i = 0; i < n; i++) {
      m[i] = Math.min(cap[i], Math.max(0, Math.floor(mins[i] || 0)));
      sumM += m[i];
    }
    const give = sumM > T ? largestRemainder(m, T, null, m) : m;
    for (let i = 0; i < n; i++) {
      out[i] = give[i];
      T -= give[i];
    }
  }
  // 2) proportional rest with caps; iterate while capped units leave a remainder
  for (let guard = 0; T > 0 && guard < n + 1; guard++) {
    let sumW = 0;
    for (let i = 0; i < n; i++) if (out[i] < cap[i]) sumW += w[i];
    if (!(sumW > 0)) break;
    const rem = [];
    let given = 0;
    for (let i = 0; i < n; i++) {
      if (out[i] >= cap[i] || w[i] <= 0) continue;
      const q = (T * w[i]) / sumW;
      let f = Math.floor(q);
      if (out[i] + f > cap[i]) f = cap[i] - out[i];
      out[i] += f;
      given += f;
      if (out[i] < cap[i]) rem.push([q - Math.floor(q), i]);
    }
    let left = T - given;
    rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let k = 0; k < rem.length && left > 0; k++) {
      const i = rem[k][1];
      if (out[i] < cap[i]) {
        out[i]++;
        left--;
      }
    }
    if (left === T) break;
    T = left;
  }
  return out;
}

/**
 * "1 ● = K ants" scale: K = ceil(N_view / budget) (≥ 1).
 * @param {number} n
 * @param {number} budget
 * @returns {number}
 */
export function scaleK(n, budget) {
  if (!(n > 0) || !(budget > 0)) return 1;
  return Math.max(1, Math.ceil(n / budget));
}

/**
 * Preallocated sprite pool. Fields are typed arrays sized to `capacity`; `n` sprites are live (indices 0..n−1).
 * @param {number} capacity
 */
export function createPool(capacity) {
  const cap = Math.max(1, Math.floor(capacity));
  return {
    cap,
    n: 0,
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    t: new Float32Array(cap), // progress (path fraction, or timer)
    speed: new Float32Array(cap),
    type: new Uint8Array(cap), // ant kind code (KIND)
    state: new Uint8Array(cap), // behaviour state (renderer-specific)
    carry: new Uint8Array(cap), // CARRY_CODES index
    path: new Int32Array(cap), // trail index / target id / group key
    group: new Uint8Array(cap), // allocation group
    a: new Float32Array(cap), // heading (radians)
    anim: new Float32Array(cap), // leg animation phase
    cell: new Int32Array(cap), // nest: current cell; surface: aux
    next: new Int32Array(cap), // nest: next cell
    ox: new Float32Array(cap), // lateral jitter
    oy: new Float32Array(cap),
    aux: new Float32Array(cap),
    tx: new Float32Array(cap), // steering target (surface wanderers)
    ty: new Float32Array(cap),
  };
}

/** Copy sprite j into slot i (used by swap-remove). */
function copySprite(p, i, j) {
  p.x[i] = p.x[j]; p.y[i] = p.y[j]; p.t[i] = p.t[j]; p.speed[i] = p.speed[j]; p.type[i] = p.type[j];
  p.state[i] = p.state[j]; p.carry[i] = p.carry[j]; p.path[i] = p.path[j]; p.group[i] = p.group[j]; p.a[i] = p.a[j];
  p.anim[i] = p.anim[j]; p.cell[i] = p.cell[j]; p.next[i] = p.next[j]; p.ox[i] = p.ox[j]; p.oy[i] = p.oy[j]; p.aux[i] = p.aux[j];
  p.tx[i] = p.tx[j]; p.ty[i] = p.ty[j];
}

/**
 * Remove sprite i (swap with the last live sprite).
 * @param {ReturnType<typeof createPool>} p
 * @param {number} i
 */
export function removeSprite(p, i) {
  const last = p.n - 1;
  if (i < 0 || i > last) return;
  if (i !== last) copySprite(p, i, last);
  p.n = last;
}

/**
 * Append a sprite (returns its index, or −1 when full). Fields are zeroed; the caller initialises them.
 * @param {ReturnType<typeof createPool>} p
 * @returns {number}
 */
export function addSprite(p) {
  if (p.n >= p.cap) return -1;
  const i = p.n++;
  p.x[i] = 0; p.y[i] = 0; p.t[i] = 0; p.speed[i] = 1; p.type[i] = 0; p.state[i] = 0; p.carry[i] = 0; p.path[i] = -1;
  p.group[i] = 0; p.a[i] = 0; p.anim[i] = Math.random() * 6.283; p.cell[i] = -1; p.next[i] = -1; p.ox[i] = 0; p.oy[i] = 0; p.aux[i] = 0;
  return i;
}

/**
 * Bring the pool to `counts[g]` sprites per group with minimal churn: excess sprites of a group are removed, missing
 * ones are spawned through `spawn(i, group)`. Sprites keep their group, so streams do not pop on reallocation.
 * Groups are compared by `key(i)` when given (e.g. group × 1000 + trail index).
 * @param {ReturnType<typeof createPool>} p
 * @param {number[]} counts desired count per group key index
 * @param {(i: number, g: number) => void} spawn
 * @param {(i: number) => number} [keyOf] maps a live sprite to its group key index (default p.group[i])
 */
export function reconcile(p, counts, spawn, keyOf = (i) => p.group[i]) {
  const have = new Array(counts.length).fill(0);
  for (let i = p.n - 1; i >= 0; i--) {
    const g = keyOf(i);
    if (!(g >= 0 && g < counts.length) || have[g] >= counts[g]) {
      removeSprite(p, i);
      continue;
    }
    have[g]++;
  }
  for (let g = 0; g < counts.length; g++) {
    for (let k = have[g]; k < counts[g]; k++) {
      const i = addSprite(p);
      if (i < 0) return;
      p.group[i] = Math.min(255, g);
      spawn(i, g);
    }
  }
}

/** Ant kind codes used in pools and the atlas. */
export const KIND = Object.freeze({ minor: 0, soldier: 1, supermajor: 2, replete: 3, alate: 4, queen: 5, golden: 6, militia: 7, rival: 8, ghost: 9 });
/** Kind code → atlas key. */
export const KIND_NAMES = Object.freeze(['minor', 'soldier', 'supermajor', 'replete', 'alate', 'queen', 'golden', 'militia', 'rival', 'ghost']);

/** Below-view allocation groups. */
export const BELOW_GROUPS = Object.freeze(['digger', 'nurse', 'hauler', 'tender', 'soldier', 'idle']);

/** Safe number read. */
function num(v) {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Real counts per Below group (DESIGN §25.5): diggers, nurses, haulers (∝ foragers), tenders (gardeners + herders),
 * soldiers (soldiers + supermajors), idle minors.
 * @param {any} s
 * @returns {{ counts: number[], total: number }}
 */
export function belowCounts(s) {
  const col = s && s.run && s.run.colony;
  if (!col) return { counts: [0, 0, 0, 0, 0, 0], total: 0 };
  const j = col.jobs || {};
  const a = col.adults || {};
  let assigned = 0;
  for (const k of Object.keys(j)) assigned += num(j[k]);
  const idle = Math.max(0, num(a.minor) - assigned - num(col.militia));
  const counts = [
    num(j.digger),
    num(j.nurse),
    num(j.forager),
    num(j.gardener) + num(j.herder),
    num(a.soldier) + num(a.supermajor),
    idle,
  ];
  let total = 0;
  for (const c of counts) total += c;
  return { counts, total };
}

/**
 * Below allocation: integer sprites per group (largest remainder), sprites ≤ real ants, ≤ budget.
 * @param {any} s
 * @param {number} [budget=BUDGET.below]
 * @returns {{ alloc: number[], K: number, total: number }}
 */
export function allocBelow(s, budget = BUDGET.below) {
  const { counts, total } = belowCounts(s);
  const n = Math.min(budget, Math.floor(total));
  const caps = counts.map((c) => Math.floor(c));
  const alloc = largestRemainder(counts, n, null, caps);
  return { alloc, K: scaleK(total, budget), total };
}

/**
 * Above allocation (DESIGN §25.5): per trail by effective workers (min 2 per active trail), ≥ 3 scouts at the frontier
 * (when there are scouts), escorts per trail, garrison near the entrance, loose foragers around hex 0.
 * Group order in the result: trails[0..T−1], escorts[0..T−1], scouts, garrison, loose.
 * @param {any} s
 * @param {any} d
 * @param {number} [budget=BUDGET.above]
 * @returns {{ trail: number[], escort: number[], scouts: number, garrison: number, loose: number, K: number, total: number }}
 */
export function allocAbove(s, d, budget = BUDGET.above) {
  const trails = (s && s.run && s.run.surface && s.run.surface.trails) || [];
  const dt = (d && d.surface && d.surface.trails) || [];
  const col = (s && s.run && s.run.colony) || {};
  const jobs = col.jobs || {};
  const T = trails.length;
  const weights = [];
  const mins = [];
  const caps = [];
  let explicitTrailWorkers = 0;
  for (let i = 0; i < T; i++) {
    const tr = trails[i];
    const dd = dt[i] && dt[i].uid === tr.uid ? dt[i] : null;
    let w = dd ? num(dd.workers) : num(tr.workers);
    if (tr.job === 'lycaenid') w = 0;
    explicitTrailWorkers += w;
    weights.push(w);
    mins.push(w >= 1 ? 2 : 0);
    caps.push(Math.max(w >= 1 ? 2 : 0, Math.floor(w)));
  }
  for (let i = 0; i < T; i++) {
    const e = num(trails[i].escorts);
    weights.push(e);
    mins.push(0);
    caps.push(Math.floor(e));
  }
  const scouts = num(jobs.scout);
  weights.push(scouts);
  mins.push(scouts > 0 ? 3 : 0);
  caps.push(Math.max(scouts > 0 ? 3 : 0, Math.floor(scouts)));
  const garrison = d && d.combat && d.combat.garrison ? num(d.combat.garrison.soldier) + num(d.combat.garrison.supermajor) : 0;
  weights.push(garrison);
  mins.push(0);
  caps.push(Math.floor(garrison));
  let loose = d && d.surface && d.surface.loose > 0 ? d.surface.loose : 0;
  if (!(loose > 0) && T === 0) loose = num(jobs.forager); // no derived data yet: every forager is loose
  if (!(loose > 0) && T > 0 && explicitTrailWorkers === 0 && !(dt.length)) {
    // derived cache not filled yet (stub/derive pending): spread foragers over the trails for display
    const f = num(jobs.forager);
    for (let i = 0; i < T; i++) {
      if (trails[i].job === 'lycaenid') continue;
      weights[i] = f / Math.max(1, T);
      mins[i] = weights[i] >= 1 ? 2 : 0;
      caps[i] = Math.max(mins[i], Math.floor(weights[i]));
    }
  }
  weights.push(loose);
  mins.push(0);
  caps.push(Math.floor(loose));
  let total = 0;
  for (const w of weights) total += w;
  const n = Math.min(budget, Math.floor(total) + T * 2);
  const alloc = largestRemainder(weights, Math.min(n, budget), mins, caps);
  return {
    trail: alloc.slice(0, T),
    escort: alloc.slice(T, 2 * T),
    scouts: alloc[2 * T],
    garrison: alloc[2 * T + 1],
    loose: alloc[2 * T + 2],
    K: scaleK(total, budget),
    total,
  };
}

/**
 * Total ants represented in the Above view (for the scale label when allocation has not run).
 * @param {any} s
 * @returns {number}
 */
export function surfaceAntCount(s) {
  const j = (s && s.run && s.run.colony && s.run.colony.jobs) || {};
  return num(j.forager) + num(j.scout) + num(j.herder) + num(j.leafcutter);
}

// ----------------------------------------------------------------------------------------------------------------
// Nest open map and BFS distance fields
// ----------------------------------------------------------------------------------------------------------------

/**
 * Open map (1 = TUNNEL or dug CHAMBER cell) built from s.run.nest.cells.
 * @param {number[]} cells
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function openMap(cells, out) {
  const N = GRID.cols * GRID.rows;
  const o = out && out.length === N ? out : new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = cells ? cells[i] : 0;
    o[i] = c === CELL.TUNNEL || c === CELL.CHAMBER ? 1 : 0;
  }
  return o;
}

/**
 * 4-neighbour BFS over open cells from the start cells (starts need not be open: a closed start seeds its open
 * neighbours at distance 1, so a dig face can be a target). Returns path distances, −1 unreachable.
 * @param {Uint8Array} open
 * @param {number[]} starts
 * @param {Int16Array} [out]
 * @param {Int32Array} [queue] scratch
 * @returns {Int16Array}
 */
export function bfsField(open, starts, out, queue) {
  const cols = GRID.cols;
  const N = open.length;
  const dist = out && out.length === N ? out : new Int16Array(N);
  dist.fill(-1);
  const q = queue && queue.length >= N ? queue : new Int32Array(N);
  let head = 0;
  let tail = 0;
  for (const s0 of starts || []) {
    if (!(s0 >= 0 && s0 < N)) continue;
    if (open[s0]) {
      if (dist[s0] !== 0) {
        dist[s0] = 0;
        q[tail++] = s0;
      }
    } else {
      const x = s0 % cols;
      const nb = [s0 - cols, s0 + cols, x > 0 ? s0 - 1 : -1, x < cols - 1 ? s0 + 1 : -1];
      for (const n of nb) {
        if (n >= 0 && n < N && open[n] && dist[n] === -1) {
          dist[n] = 1;
          q[tail++] = n;
        }
      }
    }
  }
  while (head < tail) {
    const c = q[head++];
    const dc = dist[c] + 1;
    const x = c % cols;
    if (c >= cols && open[c - cols] && dist[c - cols] === -1) { dist[c - cols] = dc; q[tail++] = c - cols; }
    if (c + cols < N && open[c + cols] && dist[c + cols] === -1) { dist[c + cols] = dc; q[tail++] = c + cols; }
    if (x > 0 && open[c - 1] && dist[c - 1] === -1) { dist[c - 1] = dc; q[tail++] = c - 1; }
    if (x < cols - 1 && open[c + 1] && dist[c + 1] === -1) { dist[c + 1] = dc; q[tail++] = c + 1; }
  }
  return dist;
}

/**
 * Per-target BFS field cache keyed by (rev, key). Cleared whenever the nest rev changes.
 */
export function createFieldCache() {
  const N = GRID.cols * GRID.rows;
  const cache = {
    rev: -1,
    open: new Uint8Array(N),
    queue: new Int32Array(N),
    fields: new Map(),
    /** Refresh the open map when the rev (or the cells array identity) changed. */
    sync(cells, rev) {
      if (rev === cache.rev && cells === cache.cellsRef) return false;
      cache.rev = rev;
      cache.cellsRef = cells;
      openMap(cells, cache.open);
      cache.fields.clear();
      return true;
    },
    cellsRef: null,
    /**
     * Field toward `starts`, cached under `key`.
     * @param {string} key
     * @param {() => number[]} startsFn
     * @returns {Int16Array}
     */
    get(key, startsFn) {
      let f = cache.fields.get(key);
      if (!f) {
        if (cache.fields.size > 48) cache.fields.clear();
        f = bfsField(cache.open, startsFn(), undefined, cache.queue);
        cache.fields.set(key, f);
      }
      return f;
    },
  };
  return cache;
}

/**
 * Next cell one step down a distance field from cell c (lowest distance neighbour; ties broken by `r` ∈ [0,1)).
 * Returns c itself at a minimum (or when unreachable).
 * @param {Int16Array} field
 * @param {Uint8Array} open
 * @param {number} c
 * @param {number} r
 * @returns {number}
 */
export function stepDown(field, open, c, r) {
  const cols = GRID.cols;
  const N = field.length;
  const dc = field[c];
  if (dc <= 0) return c;
  const x = c % cols;
  let bestD = dc;
  let nb = 0;
  SCRATCH4[0] = c - cols;
  SCRATCH4[1] = c + cols;
  SCRATCH4[2] = x > 0 ? c - 1 : -1;
  SCRATCH4[3] = x < cols - 1 ? c + 1 : -1;
  for (let k = 0; k < 4; k++) {
    const n = SCRATCH4[k];
    if (n < 0 || n >= N || !open[n]) continue;
    const dn = field[n];
    if (dn < 0) continue;
    if (dn < bestD) {
      bestD = dn;
      nb = 0;
      BEST4[nb++] = n;
    } else if (dn === bestD && dn < dc) {
      BEST4[nb++] = n;
    }
  }
  if (nb === 0) return c;
  return BEST4[Math.min(nb - 1, Math.floor((r >= 0 ? r : 0) * nb))];
}
const SCRATCH4 = new Int32Array(4);
const BEST4 = new Int32Array(4);

/**
 * A random open neighbour of c (for wandering), or c when boxed in.
 * @param {Uint8Array} open
 * @param {number} c
 * @param {number} r ∈ [0,1)
 * @param {number} [avoid=-1] previous cell (avoided when possible)
 * @returns {number}
 */
export function randomNeighbor(open, c, r, avoid = -1) {
  const cols = GRID.cols;
  const N = open.length;
  const x = c % cols;
  const cand = [c - cols, c + cols, x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1];
  let count = 0;
  for (let k = 0; k < 4; k++) if (cand[k] >= 0 && cand[k] < N && open[cand[k]] && cand[k] !== avoid) count++;
  if (count === 0) return avoid >= 0 && open[avoid] ? avoid : c;
  let pickK = Math.floor(r * count);
  for (let k = 0; k < 4; k++) {
    const n = cand[k];
    if (n >= 0 && n < N && open[n] && n !== avoid) {
      if (pickK === 0) return n;
      pickK--;
    }
  }
  return c;
}

/**
 * Adults shown in the colony (used for labels when allocation is empty).
 * @param {any} s
 * @returns {number}
 */
export function colonyAdults(s) {
  try {
    return adultsTotal(s);
  } catch {
    return 0;
  }
}

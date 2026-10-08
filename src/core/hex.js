// Axial hex geometry (pointy-top, radius 16, 817 hexes addressed by spiral index): neighbours, distance, rings,
// pixel conversion, generic A*, lines, nest column mapping. Owner: WP1. Contract: ARCHITECTURE §7.10.
// Note: neighbors(i) returns the shared precomputed array, frozen; copy it before sorting or mutating.

import { HEX, GRID } from '../data/balance.js';

/** Axial direction vectors [dq, dr]. */
export const DIRS = Object.freeze([[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]].map((d) => Object.freeze(d)));
/** Number of hexes stored (radius 16). */
export const HEX_COUNT = HEX.count;

const R_MAX = HEX.maxRadius;
const SPAN = 2 * R_MAX + 1;
const SQRT3 = Math.sqrt(3);
// Nest column per unit of axial x (q + r/2) for root lines (ARCHITECTURE §7.10 pins this mapping).
const COL_PER_HEX = 6;

const QS = new Int8Array(HEX_COUNT);
const RS = new Int8Array(HEX_COUNT);
const RINGS = new Uint8Array(HEX_COUNT);
const LOOKUP = new Int16Array(SPAN * SPAN).fill(-1);
/** @type {number[][]} */
const NEIGH = [];

(function build() {
  let i = 0;
  const put = (q, r, k) => {
    QS[i] = q;
    RS[i] = r;
    RINGS[i] = k;
    LOOKUP[(q + R_MAX) * SPAN + (r + R_MAX)] = i;
    i++;
  };
  put(0, 0, 0);
  for (let k = 1; k <= R_MAX; k++) {
    let q = k * DIRS[4][0];
    let r = k * DIRS[4][1];
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < k; step++) {
        put(q, r, k);
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
  }
  for (let j = 0; j < HEX_COUNT; j++) {
    const list = [];
    for (const [dq, dr] of DIRS) {
      const n = hexIndex(QS[j] + dq, RS[j] + dr);
      if (n >= 0) list.push(n);
    }
    NEIGH.push(Object.freeze(list));
  }
})();

/**
 * Number of hexes within radius R: 1 + 3R(R+1).
 * @param {number} R
 * @returns {number}
 */
export function countInRadius(R) {
  if (!(R > 0)) return 1;
  const r = Math.min(Math.floor(R), R_MAX);
  return 1 + 3 * r * (r + 1);
}

/**
 * Spiral index of axial (q, r), or −1 outside radius 16.
 * @param {number} q
 * @param {number} r
 * @returns {number}
 */
export function hexIndex(q, r) {
  if (!Number.isInteger(q) || !Number.isInteger(r)) return -1;
  if (q < -R_MAX || q > R_MAX || r < -R_MAX || r > R_MAX) return -1;
  return LOOKUP[(q + R_MAX) * SPAN + (r + R_MAX)];
}

/**
 * Axial coordinates of a spiral index.
 * @param {number} i
 * @returns {[number, number]}
 */
export function hexQR(i) {
  return [QS[i], RS[i]];
}

/**
 * Ring (distance from hex 0) of a spiral index.
 * @param {number} i
 * @returns {number}
 */
export function ringOf(i) {
  return RINGS[i];
}

/**
 * Neighbour indices inside radius 16 (precomputed, frozen; do not mutate).
 * @param {number} i
 * @returns {number[]}
 */
export function neighbors(i) {
  return NEIGH[i] || [];
}

/**
 * Hex distance between two spiral indices.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function hexDist(a, b) {
  const dq = QS[a] - QS[b];
  const dr = RS[a] - RS[b];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * Pixel centre of a hex (origin at hex 0): x = size·√3·(q + r/2), y = size·1.5·r.
 * @param {number} i
 * @param {number} size
 * @returns {[number, number]}
 */
export function hexToPixel(i, size) {
  const q = QS[i];
  const r = RS[i];
  return [size * SQRT3 * (q + r / 2), size * 1.5 * r];
}

/**
 * Hex under a pixel (cube rounding), or −1 outside radius 16.
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {number}
 */
export function pixelToHex(x, y, size) {
  const fq = ((SQRT3 / 3) * x - y / 3) / size;
  const fr = ((2 / 3) * y) / size;
  const [q, r] = cubeRound(fq, fr);
  return hexIndex(q, r);
}

/**
 * Round fractional axial coordinates to the nearest hex.
 * @param {number} fq
 * @param {number} fr
 * @returns {[number, number]}
 */
function cubeRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q + 0, r + 0]; // + 0 normalises -0
}

/**
 * All spiral indices within radius R: [0, 1 + 3R(R+1)).
 * @param {number} R
 * @returns {number[]}
 */
export function hexesInRadius(R) {
  const n = countInRadius(R);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Generic A*. costFn(i) = cost of ENTERING hex i (number > 0), or null if impassable.
 * Heuristic = hexDist × the minimum step cost; ties broken by lower index. The path includes both endpoints;
 * `cost` is the sum of costFn over path hexes after the first. Returns null if unreachable or cost > maxCost.
 * @param {number} from
 * @param {number} to
 * @param {(i: number) => (number|null)} costFn
 * @param {number} [maxCost=Infinity]
 * @returns {{ path: number[], cost: number } | null}
 */
export function hexPath(from, to, costFn, maxCost = Infinity) {
  if (!(from >= 0 && from < HEX_COUNT && to >= 0 && to < HEX_COUNT)) return null;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from === to) return { path: [from], cost: 0 };
  // Evaluate every entering cost exactly once (also gives the admissible minimum step).
  const cost = new Float64Array(HEX_COUNT);
  let minStep = Infinity;
  for (let i = 0; i < HEX_COUNT; i++) {
    const c = costFn(i);
    if (c === null || c === undefined || !(c >= 0) || !Number.isFinite(c)) {
      cost[i] = -1;
    } else {
      cost[i] = c;
      if (c < minStep) minStep = c;
    }
  }
  if (cost[to] < 0) return null;
  const hMul = Number.isFinite(minStep) ? minStep : 0;
  const g = new Float64Array(HEX_COUNT).fill(Infinity);
  const prev = new Int16Array(HEX_COUNT).fill(-1);
  const closed = new Uint8Array(HEX_COUNT);
  const heap = new MinHeap();
  g[from] = 0;
  heap.push(hexDist(from, to) * hMul, from);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === to) break;
    const nb = NEIGH[cur];
    for (let k = 0; k < nb.length; k++) {
      const n = nb[k];
      if (closed[n] || cost[n] < 0) continue;
      const ng = g[cur] + cost[n];
      if (ng > maxCost) continue;
      if (ng < g[n]) {
        g[n] = ng;
        prev[n] = cur;
        heap.push(ng + hexDist(n, to) * hMul, n);
      }
    }
  }
  if (!closed[to] || !(g[to] <= maxCost)) return null;
  const path = [];
  for (let c = to; c !== -1; c = prev[c]) path.push(c);
  path.reverse();
  return { path, cost: g[to] };
}

/** Binary min-heap ordered by (priority, index). */
class MinHeap {
  constructor() {
    /** @type {number[]} */ this.p = [];
    /** @type {number[]} */ this.v = [];
  }
  get size() {
    return this.v.length;
  }
  less(a, b) {
    return this.p[a] < this.p[b] || (this.p[a] === this.p[b] && this.v[a] < this.v[b]);
  }
  swap(a, b) {
    const tp = this.p[a]; this.p[a] = this.p[b]; this.p[b] = tp;
    const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv;
  }
  push(priority, value) {
    this.p.push(priority);
    this.v.push(value);
    let i = this.v.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop() {
    const top = this.v[0];
    const last = this.v.length - 1;
    this.swap(0, last);
    this.p.pop();
    this.v.pop();
    let i = 0;
    const n = this.v.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/**
 * Hexes on the straight line from a to b, inclusive (cube lerp with a tiny nudge).
 * @param {number} a
 * @param {number} b
 * @returns {number[]}
 */
export function lineHexes(a, b) {
  const n = hexDist(a, b);
  if (n === 0) return [a];
  const aq = QS[a] + 1e-6, ar = RS[a] + 1e-6;
  const bq = QS[b] + 1e-6, br = RS[b] + 1e-6;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const [q, r] = cubeRound(aq + (bq - aq) * t, ar + (br - ar) * t);
    const idx = hexIndex(q, r);
    if (idx >= 0 && out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/**
 * Nest column for a surface hex (root lines): clamp(round(20 + 6 × (q + r/2)), 1, 38).
 * @param {number} i
 * @returns {number}
 */
export function colForHex(i) {
  const q = QS[i];
  const r = RS[i];
  // C215: in the base 40-wide frame (nestgen shifts it into a wider run's nest)
  const c = Math.round(GRID.baseMainCol + COL_PER_HEX * (q + r / 2));
  return Math.min(GRID.baseCols - 2, Math.max(1, c));
}

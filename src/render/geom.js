// Pure render geometry: nest cell <-> pixel with a scroll view, hex <-> pixel with a pan/zoom camera, polyline
// distance, Catmull-Rom splines (C128: obstacle-avoiding trail curves) and arc-length tables, plus tiny deterministic
// hash-noise helpers. Owner: WP8.
// Contract: ARCHITECTURE §13.3 (render/geom.js, unit-tested by tests/render.geom.test.js). No DOM, no state writes.

import { GRID, HEX } from '../data/balance.js';
import { hexToPixel, pixelToHex, ringOf, neighbors, HEX_COUNT } from '../core/hex.js';

/** √3, used by pointy-top hex maths. */
export const SQRT3 = Math.sqrt(3);

/**
 * Nest view: maps grid cells to CSS pixels. `ox`/`oy` = CSS position of the top-left corner of cell (0, 0)
 * (oy already includes the scroll), `cell` = CSS pixels per cell.
 * @typedef {{ ox?: number, oy?: number, cell?: number, cols?: number, rows?: number }} NestView
 */

/**
 * Surface camera: the world point (x, y) (hex pixel space at zoom 1, origin = hex 0 centre) is drawn at the screen
 * point (cx, cy); `zoom` scales world to screen; `size` = hex size in world pixels (HEX.px).
 * @typedef {{ x?: number, y?: number, zoom?: number, cx?: number, cy?: number, size?: number }} Camera
 */

/**
 * Clamp v to [lo, hi] (NaN → lo).
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(v, lo, hi) {
  if (!(v >= lo)) return lo;
  return v > hi ? hi : v;
}

/** @param {NestView} view */
function nv(view) {
  const v = view || {};
  return {
    ox: Number.isFinite(v.ox) ? v.ox : 0,
    oy: Number.isFinite(v.oy) ? v.oy : 0,
    cell: v.cell > 0 ? v.cell : GRID.cellPx,
    cols: v.cols > 0 ? v.cols : GRID.cols,
    rows: v.rows > 0 ? v.rows : GRID.rows,
  };
}

/**
 * CSS position of the TOP-LEFT corner of cell i.
 * @param {number} i cell index (y * cols + x)
 * @param {NestView} view
 * @returns {{ x: number, y: number }}
 */
export function cellToPx(i, view) {
  const v = nv(view);
  const x = i % v.cols;
  const y = Math.floor(i / v.cols);
  return { x: v.ox + x * v.cell, y: v.oy + y * v.cell };
}

/**
 * CSS position of the CENTRE of cell i.
 * @param {number} i
 * @param {NestView} view
 * @returns {{ x: number, y: number }}
 */
export function cellCenterPx(i, view) {
  const v = nv(view);
  const p = cellToPx(i, v);
  return { x: p.x + v.cell / 2, y: p.y + v.cell / 2 };
}

/**
 * Cell index under a CSS point, or −1 outside the grid.
 * @param {number} x
 * @param {number} y
 * @param {NestView} view
 * @returns {number}
 */
export function pxToCell(x, y, view) {
  const v = nv(view);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const cx = Math.floor((x - v.ox) / v.cell);
  const cy = Math.floor((y - v.oy) / v.cell);
  if (cx < 0 || cy < 0 || cx >= v.cols || cy >= v.rows) return -1;
  return cy * v.cols + cx;
}

/**
 * Cell grid coordinates under a CSS point (may be outside the grid).
 * @param {number} x
 * @param {number} y
 * @param {NestView} view
 * @returns {{ x: number, y: number }}
 */
export function pxToCellXY(x, y, view) {
  const v = nv(view);
  return { x: Math.floor((x - v.ox) / v.cell), y: Math.floor((y - v.oy) / v.cell) };
}

/** @param {Camera} cam */
function cv(cam) {
  const c = cam || {};
  return {
    x: Number.isFinite(c.x) ? c.x : 0,
    y: Number.isFinite(c.y) ? c.y : 0,
    zoom: c.zoom > 0 ? c.zoom : 1,
    cx: Number.isFinite(c.cx) ? c.cx : 0,
    cy: Number.isFinite(c.cy) ? c.cy : 0,
    size: c.size > 0 ? c.size : HEX.px,
  };
}

/**
 * World (zoom-1 hex pixel space) → screen CSS pixels.
 * @param {number} wx
 * @param {number} wy
 * @param {Camera} cam
 * @returns {{ x: number, y: number }}
 */
export function worldToScreen(wx, wy, cam) {
  const c = cv(cam);
  return { x: c.cx + (wx - c.x) * c.zoom, y: c.cy + (wy - c.y) * c.zoom };
}

/**
 * Screen CSS pixels → world (zoom-1 hex pixel space).
 * @param {number} sx
 * @param {number} sy
 * @param {Camera} cam
 * @returns {{ x: number, y: number }}
 */
export function screenToWorld(sx, sy, cam) {
  const c = cv(cam);
  return { x: c.x + (sx - c.cx) / c.zoom, y: c.y + (sy - c.cy) / c.zoom };
}

/**
 * Screen position of a hex centre.
 * @param {number} hex spiral index
 * @param {Camera} cam
 * @returns {{ x: number, y: number }}
 */
export function hexToPx(hex, cam) {
  const c = cv(cam);
  if (!(hex >= 0 && hex < HEX_COUNT)) return { x: NaN, y: NaN };
  const [wx, wy] = hexToPixel(hex, c.size);
  return worldToScreen(wx, wy, c);
}

/**
 * Hex under a screen point, or −1 outside radius 16 (callers clip to the current map radius).
 * @param {number} x
 * @param {number} y
 * @param {Camera} cam
 * @returns {number}
 */
export function pxToHex(x, y, cam) {
  const c = cv(cam);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  const w = screenToWorld(x, y, c);
  return pixelToHex(w.x, w.y, c.size);
}

/**
 * Hex under a screen point clipped to a map radius (−1 outside).
 * @param {number} x
 * @param {number} y
 * @param {Camera} cam
 * @param {number} radius
 * @returns {number}
 */
export function pxToHexInRadius(x, y, cam, radius) {
  const h = pxToHex(x, y, cam);
  if (h < 0) return -1;
  return ringOf(h) <= radius ? h : -1;
}

/**
 * World-space centre of a hex at zoom 1.
 * @param {number} hex
 * @param {number} [size=HEX.px]
 * @returns {{ x: number, y: number }}
 */
export function hexWorld(hex, size = HEX.px) {
  const [x, y] = hexToPixel(hex, size);
  return { x, y };
}

/**
 * The 6 corner points of a pointy-top hex (flat array x0,y0,…,x5,y5).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r corner radius
 * @returns {number[]}
 */
export function hexCorners(cx, cy, r) {
  const out = new Array(12);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k - 30);
    out[2 * k] = cx + r * Math.cos(a);
    out[2 * k + 1] = cy + r * Math.sin(a);
  }
  return out;
}

/** @param {any} p */
function px(p) {
  return Array.isArray(p) ? p[0] : p.x;
}
/** @param {any} p */
function py(p) {
  return Array.isArray(p) ? p[1] : p.y;
}

/**
 * Distance from a point to the segment a–b.
 * @returns {number}
 */
export function distToSegment(pxv, pyv, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((pxv - ax) * dx + (pyv - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - pxv;
  const qy = ay + t * dy - pyv;
  return Math.sqrt(qx * qx + qy * qy);
}

/**
 * Shortest distance from (px, py) to a polyline. Points may be {x, y} objects or [x, y] pairs.
 * An empty polyline gives Infinity; a single point gives the point distance.
 * @param {number} pxv
 * @param {number} pyv
 * @param {Array<{x:number,y:number}|number[]>} pts
 * @returns {number}
 */
export function distToPolyline(pxv, pyv, pts) {
  if (!pts || pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(pxv - px(pts[0]), pyv - py(pts[0]));
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = distToSegment(pxv, pyv, px(pts[i]), py(pts[i]), px(pts[i + 1]), py(pts[i + 1]));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Uniform Catmull-Rom spline through every point, parameterised by t ∈ [0, 1] over the whole polyline
 * (each segment gets an equal share of t). Passes exactly through pts[0] at t = 0 and the last point at t = 1.
 * End tangents use duplicated endpoints.
 * @param {Array<{x:number,y:number}|number[]>} pts
 * @param {number} t
 * @returns {{ x: number, y: number }}
 */
export function catmullRom(pts, t) {
  const n = pts ? pts.length : 0;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { x: px(pts[0]), y: py(pts[0]) };
  const tt = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  const segs = n - 1;
  let k = Math.floor(tt * segs);
  if (k >= segs) k = segs - 1;
  const u = tt * segs - k;
  const p0 = pts[k > 0 ? k - 1 : 0];
  const p1 = pts[k];
  const p2 = pts[k + 1];
  const p3 = pts[k + 2 < n ? k + 2 : n - 1];
  return { x: crAxis(px(p0), px(p1), px(p2), px(p3), u), y: crAxis(py(p0), py(p1), py(p2), py(p3), u) };
}

/** One axis of the uniform Catmull-Rom basis. */
function crAxis(a, b, c, d, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
}

/**
 * Sample a Catmull-Rom spline into a dense polyline (perSeg samples per original segment, endpoints included).
 * @param {Array<{x:number,y:number}|number[]>} pts
 * @param {number} [perSeg=6]
 * @returns {{ x: number, y: number }[]}
 */
export function sampleSpline(pts, perSeg = 6) {
  const n = pts ? pts.length : 0;
  if (n === 0) return [];
  if (n === 1) return [{ x: px(pts[0]), y: py(pts[0]) }];
  const total = (n - 1) * Math.max(1, Math.floor(perSeg));
  const out = new Array(total + 1);
  for (let i = 0; i <= total; i++) out[i] = catmullRom(pts, i / total);
  return out;
}

/**
 * Total length of a polyline.
 * @param {Array<{x:number,y:number}|number[]>} pts
 * @returns {number}
 */
export function polylineLength(pts) {
  let L = 0;
  for (let i = 0; pts && i + 1 < pts.length; i++) L += Math.hypot(px(pts[i + 1]) - px(pts[i]), py(pts[i + 1]) - py(pts[i]));
  return L;
}

/**
 * Signed distance-like value from (x, y) to a pointy-top hex of corner radius `size` centred at (cx, cy): negative
 * inside, 0 on the border, positive outside (the max of the three edge-pair plane distances, so outside it never
 * over-estimates the true distance: a conservative "how far from entering this hex" measure).
 * @returns {number}
 */
export function hexSdf(x, y, cx, cy, size) {
  const dx = x - cx;
  const dy = y - cy;
  const k = SQRT3 / 2;
  return Math.max(Math.abs(dx), Math.abs(0.5 * dx + k * dy), Math.abs(-0.5 * dx + k * dy)) - size * k;
}

/**
 * C128: Catmull-Rom spline through hex centres that never enters an obstacle hex. Segment by segment, the curve is
 * blended toward the straight centre-to-centre chord (alpha 1 → 0.6 → 0.3 → 0) until every sample keeps `margin`
 * world px (default 0.3 × size: half the widest worn-earth stroke at zoom 0.6; impassable hexes are drawn as full
 * hexes, so the stroke must stay off their corners) from every nearby obstacle hex. The chord between two ADJACENT
 * hexes stays inside those two hexes and ≥ 0.43 × size from any third hex, so the fallback (alpha 0) is always clear. Same sample layout as sampleSpline
 * (perSeg samples per segment, endpoints included), so arc tables and hit tests keep working.
 * @param {Array<{x:number,y:number}|number[]>} pts hex centres (consecutive points = adjacent hexes)
 * @param {Array<{x:number,y:number}>} obstacles centres of impassable hexes (not on the path)
 * @param {{ perSeg?: number, size?: number, margin?: number }} [opts]
 * @returns {{ x: number, y: number }[]}
 */
export function avoidSpline(pts, obstacles, opts = {}) {
  const n = pts ? pts.length : 0;
  if (n === 0) return [];
  if (n === 1) return [{ x: px(pts[0]), y: py(pts[0]) }];
  const per = Math.max(1, Math.floor(opts.perSeg > 0 ? opts.perSeg : 6));
  const obs = Array.isArray(obstacles) ? obstacles : [];
  if (!obs.length) return sampleSpline(pts, per);
  const size = opts.size > 0 ? opts.size : HEX.px;
  const margin = Number.isFinite(opts.margin) ? opts.margin : 0.3 * size;
  const reach2 = (2.2 * size) ** 2;
  const out = [{ x: px(pts[0]), y: py(pts[0]) }];
  const seg = new Array(per);
  for (let k = 0; k + 1 < n; k++) {
    const p0 = pts[k > 0 ? k - 1 : 0];
    const p3 = pts[k + 2 < n ? k + 2 : n - 1];
    const x1 = px(pts[k]);
    const y1 = py(pts[k]);
    const x2 = px(pts[k + 1]);
    const y2 = py(pts[k + 1]);
    const near = [];
    for (const o of obs) {
      if ((o.x - x1) ** 2 + (o.y - y1) ** 2 <= reach2 || (o.x - x2) ** 2 + (o.y - y2) ** 2 <= reach2) near.push(o);
    }
    for (const alpha of near.length ? [1, 0.6, 0.3, 0] : [1]) {
      let ok = true;
      for (let j = 1; j <= per; j++) {
        const u = j / per;
        const lx = x1 + (x2 - x1) * u;
        const ly = y1 + (y2 - y1) * u;
        const cx = j === per ? x2 : crAxis(px(p0), x1, x2, px(p3), u);
        const cy = j === per ? y2 : crAxis(py(p0), y1, y2, py(p3), u);
        const q = { x: lx + (cx - lx) * alpha, y: ly + (cy - ly) * alpha };
        seg[j - 1] = q;
        if (alpha > 0 && ok) {
          for (const o of near) {
            if (hexSdf(q.x, q.y, o.x, o.y, size) < margin) {
              ok = false;
              break;
            }
          }
        }
      }
      if (ok) break;
    }
    for (let j = 0; j < per; j++) out.push(seg[j]);
  }
  return out;
}

/**
 * C128: world-space trail curve for a hex path (consecutive hexes adjacent): Catmull-Rom through the hex centres,
 * kept out of every neighbouring hex for which isBlocked(hex) is true (stone, a spring puddle …; hexes on the path
 * itself are never obstacles). The one curve used for the drawn trail, the drag / reroute ghost, hit tests and the
 * ants walking it.
 * @param {number[]} path spiral indices
 * @param {(hex: number) => boolean} [isBlocked]
 * @param {{ perSeg?: number, size?: number, margin?: number }} [opts]
 * @returns {{ x: number, y: number }[]}
 */
export function trailCurve(path, isBlocked, opts = {}) {
  const size = opts.size > 0 ? opts.size : HEX.px;
  const hexes = (Array.isArray(path) ? path : []).filter((hx) => hx >= 0 && hx < HEX_COUNT);
  const pts = hexes.map((hx) => hexWorld(hx, size));
  if (pts.length < 2) return pts;
  return avoidSpline(pts, pathObstacles(hexes, isBlocked, size), { ...opts, size });
}

/**
 * C128: world centres of the off-path neighbours of a hex path for which isBlocked(hex) is true.
 * @param {number[]} path
 * @param {(hex: number) => boolean} [isBlocked]
 * @param {number} [size=HEX.px]
 * @returns {{ x: number, y: number }[]}
 */
export function pathObstacles(path, isBlocked, size = HEX.px) {
  const out = [];
  if (typeof isBlocked !== 'function' || !Array.isArray(path)) return out;
  const hexes = path.filter((hx) => hx >= 0 && hx < HEX_COUNT);
  const onPath = new Set(hexes);
  const seen = new Set();
  for (const hx of hexes) {
    for (const nb of neighbors(hx)) {
      if (onPath.has(nb) || seen.has(nb)) continue;
      seen.add(nb);
      if (isBlocked(nb)) out.push(hexWorld(nb, size));
    }
  }
  return out;
}

/**
 * C134 multi-lane trails: where several trails use the same hex-to-hex step (an "edge"), each gets its own parallel
 * lane. Per edge the trails are ordered by uid and spread symmetrically around the centre line, perpendicular to the
 * travel direction of the lowest-uid trail on that edge (so the order never flips along a shared stretch, and trails
 * walking it in opposite directions still keep apart). Spacing `spacing` (default 0.24 × size) shrinks so the whole
 * bundle stays within `spread` (default 0.6 × size).
 * @param {Array<{ uid: number, path: number[] }>} trails
 * @param {{ size?: number, spacing?: number, spread?: number }} [opts]
 * @returns {Map<number, Float64Array>} uid → per path segment k the lane offset (x at 2k, y at 2k + 1), world px
 */
export function laneLayout(trails, opts = {}) {
  const size = opts.size > 0 ? opts.size : HEX.px;
  const spacing = opts.spacing > 0 ? opts.spacing : 0.24 * size;
  const spread = opts.spread > 0 ? opts.spread : 0.6 * size;
  const list = (Array.isArray(trails) ? trails : []).filter((t) => t && Array.isArray(t.path) && Number.isFinite(t.uid));
  const edges = new Map();   // key → [{ ti, k }]
  const keyOf = (a, b) => (a < b ? a * HEX_COUNT + b : b * HEX_COUNT + a);
  const valid = (h) => Number.isInteger(h) && h >= 0 && h < HEX_COUNT;
  list.forEach((t, ti) => {
    const p = t.path;
    for (let k = 0; k + 1 < p.length; k++) {
      if (!valid(p[k]) || !valid(p[k + 1]) || p[k] === p[k + 1]) continue;
      const key = keyOf(p[k], p[k + 1]);
      let g = edges.get(key);
      if (!g) edges.set(key, (g = []));
      g.push({ ti, k });
    }
  });
  const out = new Map();
  for (const t of list) out.set(t.uid, new Float64Array(Math.max(0, 2 * (t.path.length - 1))));
  for (const g of edges.values()) {
    const uids = [...new Set(g.map((e) => list[e.ti].uid))].sort((a, b) => a - b);
    const m = uids.length;
    if (m < 2) continue;
    const ref = g.find((e) => list[e.ti].uid === uids[0]);
    const rp = list[ref.ti].path;
    const a = hexWorld(rp[ref.k], size);
    const b = hexWorld(rp[ref.k + 1], size);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const sp = Math.min(spacing, spread / (m - 1));
    for (const e of g) {
      const t = list[e.ti];
      const off = (uids.indexOf(t.uid) - (m - 1) / 2) * sp;
      const arr = out.get(t.uid);
      arr[2 * e.k] = nx * off;
      arr[2 * e.k + 1] = ny * off;
    }
  }
  return out;
}

/** Smoothstep 0 → 1 on [0, 1]. */
function smooth01(u) {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

/**
 * C134: a trail's own lane — its centre curve (trailCurve / avoidSpline samples: perSeg per segment, endpoints
 * included) shifted by the per-segment lane offsets of laneLayout. Each segment holds its full offset at its middle
 * and blends (smoothstep) to the average of the two neighbouring segments' offsets at each inner hex centre, so lanes
 * merge and split smoothly where routes join or part; the two ends (entrance and source) sit on the hex centre.
 * C128 with lanes: wherever a shifted sample would come closer than `margin` (default 0.18 × size) to an obstacle hex
 * (opts.obstacles, e.g. pathObstacles), the offset there shrinks (factor 1 / ⅔ / ⅓ / 0, then a windowed min + blur
 * that never exceeds the allowed factor), falling back to the centre curve, which keeps its own clearance.
 * @param {{ x: number, y: number }[]} base centre curve
 * @param {number[]} path the hex path the curve was built from
 * @param {Float64Array|number[]|null|undefined} segOff laneLayout entry for this trail
 * @param {{ perSeg?: number, size?: number, margin?: number, obstacles?: Array<{x:number,y:number}> }} [opts]
 * @returns {{ x: number, y: number }[]} a new polyline with base.length points (or `base` itself when no lane applies)
 */
export function laneCurve(base, path, segOff, opts = {}) {
  const n = Array.isArray(path) ? path.length : 0;
  if (!base || n < 2 || !segOff || segOff.length < 2 * (n - 1)) return base;
  let any = false;
  for (let i = 0; i < 2 * (n - 1); i++) if (segOff[i] !== 0) { any = true; break; }
  if (!any) return base;
  const per = Math.max(1, Math.floor(opts.perSeg > 0 ? opts.perSeg : 6));
  if (base.length !== (n - 1) * per + 1) return base;
  const size = opts.size > 0 ? opts.size : HEX.px;
  const margin = Number.isFinite(opts.margin) ? opts.margin : 0.18 * size;
  const obs = Array.isArray(opts.obstacles) ? opts.obstacles : [];
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  for (let k = 1; k + 1 < n; k++) {
    vx[k] = (segOff[2 * (k - 1)] + segOff[2 * k]) / 2;
    vy[k] = (segOff[2 * (k - 1) + 1] + segOff[2 * k + 1]) / 2;
  }
  const N = base.length;
  const ox = new Float64Array(N);
  const oy = new Float64Array(N);
  for (let k = 0; k + 1 < n; k++) {
    const sx = segOff[2 * k];
    const sy = segOff[2 * k + 1];
    for (let j = 1; j <= per; j++) {
      const u = j / per;
      const idx = k * per + j;
      if (u <= 0.5) {
        const w = smooth01(u * 2);
        ox[idx] = vx[k] * (1 - w) + sx * w;
        oy[idx] = vy[k] * (1 - w) + sy * w;
      } else {
        const w = smooth01((u - 0.5) * 2);
        ox[idx] = sx * (1 - w) + vx[k + 1] * w;
        oy[idx] = sy * (1 - w) + vy[k + 1] * w;
      }
    }
  }
  ox[0] = 0;
  oy[0] = 0;
  // stone clearance: per-sample allowed factor, then a windowed min (r 3) and box blur (r 2) — the blur of values that
  // are each ≤ allowed[i] (every window around a neighbour within 2 contains i) never exceeds allowed[i]
  const f = new Float64Array(N).fill(1);
  if (obs.length) {
    const reach2 = (2 * size) ** 2;
    for (let i = 0; i < N; i++) {
      if (ox[i] === 0 && oy[i] === 0) continue;
      const bx = base[i].x;
      const by = base[i].y;
      const near = [];
      for (const o of obs) if ((o.x - bx) ** 2 + (o.y - by) ** 2 <= reach2) near.push(o);
      if (!near.length) continue;
      let ok = 0;
      for (const c of [1, 2 / 3, 1 / 3]) {
        const qx = bx + ox[i] * c;
        const qy = by + oy[i] * c;
        if (near.every((o) => hexSdf(qx, qy, o.x, o.y, size) >= margin)) {
          ok = c;
          break;
        }
      }
      f[i] = ok;
    }
    const mn = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let v = 1;
      for (let j = Math.max(0, i - 3); j <= Math.min(N - 1, i + 3); j++) if (f[j] < v) v = f[j];
      mn[i] = v;
    }
    for (let i = 0; i < N; i++) {
      let sum = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(N - 1, i + 2); j++) {
        sum += mn[j];
        cnt++;
      }
      f[i] = Math.min(f[i], sum / cnt);
    }
  }
  const out = new Array(N);
  for (let i = 0; i < N; i++) out[i] = { x: base[i].x + ox[i] * f[i], y: base[i].y + oy[i] * f[i] };
  return out;
}

/**
 * Arc-length table for a polyline: cumulative lengths (Float32Array) and total length.
 * @param {{x:number,y:number}[]} pts
 * @returns {{ pts: {x:number,y:number}[], cum: Float32Array, total: number }}
 */
export function arcTable(pts) {
  const n = pts ? pts.length : 0;
  const cum = new Float32Array(Math.max(1, n));
  let L = 0;
  for (let i = 1; i < n; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum[i] = L;
  }
  return { pts: pts || [], cum, total: L };
}

/**
 * Point and heading at fraction f ∈ [0, 1] of the arc length of a table built by arcTable.
 * Writes into `out` ({ x, y, a }) to avoid per-frame allocation.
 * @param {{ pts: {x:number,y:number}[], cum: Float32Array, total: number }} tab
 * @param {number} f
 * @param {{ x: number, y: number, a: number }} out
 * @returns {{ x: number, y: number, a: number }}
 */
export function pointAtArc(tab, f, out) {
  const pts = tab.pts;
  const n = pts.length;
  if (n === 0) {
    out.x = 0; out.y = 0; out.a = 0;
    return out;
  }
  if (n === 1 || !(tab.total > 0)) {
    out.x = pts[0].x; out.y = pts[0].y; out.a = 0;
    return out;
  }
  const target = clamp(f, 0, 1) * tab.total;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tab.cum[mid] < target) lo = mid;
    else hi = mid;
  }
  const seg = tab.cum[hi] - tab.cum[lo];
  const u = seg > 0 ? (target - tab.cum[lo]) / seg : 0;
  const a = pts[lo];
  const b = pts[hi];
  out.x = a.x + (b.x - a.x) * u;
  out.y = a.y + (b.y - a.y) * u;
  out.a = Math.atan2(b.y - a.y, b.x - a.x);
  return out;
}

/**
 * Deterministic 32-bit integer hash (for stable per-cell / per-hex texture noise; never gameplay).
 * @param {number} a
 * @param {number} [b=0]
 * @returns {number} uint32
 */
export function hash2(a, b = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Deterministic pseudo-random float in [0, 1) from integer coordinates.
 * @param {number} a
 * @param {number} [b=0]
 * @returns {number}
 */
export function hash01(a, b = 0) {
  return hash2(a, b) / 4294967296;
}

/**
 * Smooth 1-D value noise in [0, 1] (deterministic).
 * @param {number} x
 * @param {number} [seed=0]
 * @returns {number}
 */
export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash01(i, seed) * (1 - u) + hash01(i + 1, seed) * u;
}

/**
 * Smooth 2-D value noise in [0, 1] (deterministic, bilinear with smoothstep).
 * @param {number} x
 * @param {number} y
 * @param {number} [seed=0]
 * @returns {number}
 */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash01(xi * 73 + seed, yi * 37);
  const b = hash01((xi + 1) * 73 + seed, yi * 37);
  const c = hash01(xi * 73 + seed, (yi + 1) * 37);
  const d = hash01((xi + 1) * 73 + seed, (yi + 1) * 37);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/**
 * Heading angle (radians) → atlas rotation index 0..n−1 (0 = facing +x, increasing clockwise in screen space).
 * @param {number} a
 * @param {number} [n=8]
 * @returns {number}
 */
export function rotIndex(a, n = 8) {
  if (!Number.isFinite(a)) return 0;
  const step = (Math.PI * 2) / n;
  let k = Math.round(a / step) % n;
  if (k < 0) k += n;
  return k;
}

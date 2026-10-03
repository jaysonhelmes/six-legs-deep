// Pure render geometry: nest cell <-> pixel with a scroll view, hex <-> pixel with a pan/zoom camera, polyline
// distance, Catmull-Rom splines and arc-length tables, plus tiny deterministic hash-noise helpers. Owner: WP8.
// Contract: ARCHITECTURE §13.3 (render/geom.js, unit-tested by tests/render.geom.test.js). No DOM, no state writes.

import { GRID, HEX } from '../data/balance.js';
import { hexToPixel, pixelToHex, ringOf, HEX_COUNT } from '../core/hex.js';

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

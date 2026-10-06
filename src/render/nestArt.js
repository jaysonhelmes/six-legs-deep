// Below-view art helpers (render-internal, pure canvas painters): organic chamber outlines (flat floor, vaulted
// ceiling, slightly irregular walls) and passage nodes for the strata cache, the wavy strata boundary, short chamber
// names, the per-frame chamber contents (brood heaps, seed piles, fungus beds, hanging repletes) and mold spots.
// Per-type set dressing (roots and aphids, scent shelves, pools, stone linings, midden heap…) lives in nestDecor.js. Coordinates: outlines are in grid cell units; painters take a CSS-px box (the cavity interior) and
// `u` = CSS px per cell. No state, no DOM. Owner: WP8 (ARCHITECTURE §13.5, DESIGN §7.13).

import { hash01 } from './geom.js';

const TAU = Math.PI * 2;

/** Compact chamber names for in-canvas labels (full names stay in tooltips and panels). */
export const SHORT_NAMES = Object.freeze({
  royal_chamber: 'Royal', gallery: 'Gallery', nursery: 'Nursery', granary: 'Granary', scent_library: 'Library',
  midden: 'Midden', barracks: 'Barracks', war_hall: 'War Hall', carapace_store: 'Carapaces', carapace_workshop: 'Workshop', root_aphid_pen: 'Aphid Pen', fungus_garden: 'Fungus', repletion_hall: 'Repletes',
  hibernaculum: 'Hibernac.', thermal_chimney: 'Chimney', gate: 'Gate', water_well: 'Well', nuptial_chamber: 'Nuptial',
  deep_vault: 'Vault',
});

/**
 * Short in-canvas name of a chamber type.
 * @param {string} type
 * @returns {string}
 */
export function shortName(type) {
  if (SHORT_NAMES[type]) return SHORT_NAMES[type];
  const s = String(type || '').split('_')[0] || '';
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// ----------------------------------------------------------------------------------------------------------------
// Passages
// ----------------------------------------------------------------------------------------------------------------

/**
 * Centre offset and radius (cell units) of a passage node at grid cell (x, y): a little wobble so tunnels read as
 * dug by hand rather than ruled.
 * @param {number} x
 * @param {number} y
 * @returns {{ dx: number, dy: number, r: number }}
 */
export function tunnelNode(x, y) {
  return {
    dx: (hash01(x * 3 + 1, y * 7 + 2) - 0.5) * 0.12,
    dy: (hash01(x * 5 + 3, y * 11 + 1) - 0.5) * 0.08,
    r: 0.34 + 0.06 * hash01(x + 17, y * 3 + 5),
  };
}

/**
 * Wavy boundary between strata: the row (fractional, cell units) where the layer starting at row Y begins, at
 * horizontal position u (cell units, continuous across the grid and its margins). Stays within Y ± 0.46.
 * @param {number} u
 * @param {number} Y
 * @returns {number}
 */
export function waveY(u, Y) {
  return Y + 0.3 * Math.sin(u * 0.83 + Y * 1.7) + 0.14 * Math.sin(u * 2.1 + Y * 0.4);
}

// ----------------------------------------------------------------------------------------------------------------
// Chamber outlines
// ----------------------------------------------------------------------------------------------------------------

const OUTLINES = new Map();
/** Cavity inset from the chamber footprint (cell units): sides, ceiling, floor. Two touching chambers keep a wall. */
export const INSET = Object.freeze({ side: 0.17, top: 0.15, bottom: 0.1 });

/**
 * Inner box of a chamber's cavity in cell units.
 * @param {{ x: number, y: number, w: number, h: number }} c
 */
export function cavityBox(c) {
  const x0 = c.x + INSET.side;
  const y0 = c.y + INSET.top;
  return { x0, y0, x1: c.x + c.w - INSET.side, y1: c.y + c.h - INSET.bottom };
}

/**
 * Cavity box plus its corner radii (cell units): vaulted ceiling corners rT, flatter floor corners rB.
 * @param {{ x: number, y: number, w: number, h: number }} c
 */
export function cavityShape(c) {
  const { x0, y0, x1, y1 } = cavityBox(c);
  const W = Math.max(0.2, x1 - x0);
  const H = Math.max(0.2, y1 - y0);
  let rT = Math.min(H * 0.55, W * 0.5, 1.25);
  let rB = Math.min(H * 0.3, W * 0.5, 0.6);
  if (rT + rB > H) {
    const k = H / (rT + rB);
    rT *= k;
    rB *= k;
  }
  return { x0, y0, x1, y1, rT, rB };
}

/**
 * Horizontal room inside a cavity at height y (cell units): [left, right] limits, so sprites in the top corners
 * stay inside the rounded walls.
 * @param {{ x0: number, y0: number, x1: number, y1: number, rT: number, rB: number }} sh cavityShape()
 * @param {number} y
 * @param {number} pad
 * @returns {number[]}
 */
export function cavitySpan(sh, y, pad) {
  let inset = 0;
  if (y < sh.y0 + sh.rT) {
    const d = Math.min(sh.rT, sh.y0 + sh.rT - y);
    inset = sh.rT - Math.sqrt(Math.max(0, sh.rT * sh.rT - d * d));
  } else if (y > sh.y1 - sh.rB) {
    const d = Math.min(sh.rB, y - (sh.y1 - sh.rB));
    inset = sh.rB - Math.sqrt(Math.max(0, sh.rB * sh.rB - d * d));
  }
  const lo = sh.x0 + inset + pad;
  const hi = sh.x1 - inset - pad;
  return lo <= hi ? [lo, hi] : [(sh.x0 + sh.x1) / 2, (sh.x0 + sh.x1) / 2];
}

/**
 * Organic outline of a chamber cavity as a flat [x0, y0, x1, y1, …] point list in grid cell units (clockwise):
 * vaulted ceiling corners, flatter floor corners, a gentle dome and a little deterministic wall wobble.
 * Cached per (uid, footprint).
 * @param {{ uid?: number, x: number, y: number, w: number, h: number }} c
 * @returns {number[]}
 */
export function chamberOutline(c) {
  const key = `${c.uid | 0}|${c.x}|${c.y}|${c.w}|${c.h}`;
  const hit = OUTLINES.get(key);
  if (hit) return hit;
  const { x0, y0, x1, y1, rT, rB } = cavityShape(c);
  const W = Math.max(0.2, x1 - x0);
  const ph1 = hash01((c.uid | 0) + 11, c.x * 7 + c.y) * TAU;
  const ph2 = hash01(c.x * 13 + 5, (c.uid | 0) * 3 + c.y) * TAU;
  const dome = 0.07 * Math.min(1, W / 4);
  const pts = [];
  let s = 0;
  const STEP = 0.34;
  const push = (x, y, nx, ny, amp) => {
    const n = Math.sin(s * 1.7 + ph1) * 0.6 + Math.sin(s * 3.3 + ph2) * 0.4;
    pts.push(x + nx * amp * n, y + ny * amp * n);
  };
  const line = (ax, ay, bx, by, nx, ny, amp, domeOn) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      let y = ay + (by - ay) * t;
      if (domeOn) y -= dome * Math.sin(Math.PI * ((x - x0) / W));
      push(x, y, nx, ny, amp);
      s += len / n;
    }
  };
  const arc = (cx, cy, r, a0, a1, amp) => {
    const len = Math.abs(a1 - a0) * r;
    const n = Math.max(2, Math.ceil(len / STEP));
    for (let k = 0; k < n; k++) {
      const a = a0 + (a1 - a0) * (k / n);
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      push(cx + nx * r, cy + ny * r, nx, ny, amp);
      s += len / n;
    }
  };
  const AW = 0.07;
  line(x0 + rT, y0, x1 - rT, y0, 0, -1, AW * 0.6, true);
  arc(x1 - rT, y0 + rT, rT, -Math.PI / 2, 0, AW);
  line(x1, y0 + rT, x1, y1 - rB, 1, 0, AW, false);
  arc(x1 - rB, y1 - rB, rB, 0, Math.PI / 2, AW * 0.5);
  line(x1 - rB, y1, x0 + rB, y1, 0, 1, AW * 0.25, false);
  arc(x0 + rB, y1 - rB, rB, Math.PI / 2, Math.PI, AW * 0.5);
  line(x0, y1 - rB, x0, y0 + rT, -1, 0, AW, false);
  arc(x0 + rT, y0 + rT, rT, Math.PI, Math.PI * 1.5, AW);
  if (OUTLINES.size > 400) OUTLINES.clear();
  OUTLINES.set(key, pts);
  return pts;
}

/**
 * Add a smooth closed path through an outline (quadratic curves through the midpoints) to the current path.
 * @param {CanvasRenderingContext2D} g
 * @param {number[]} pts flat point list in cell units
 * @param {number} ox screen x of grid column 0
 * @param {number} oy screen y of grid row 0
 * @param {number} cs CSS px per cell
 * @param {number} [grow=0] outward growth in CSS px (approximate, about the outline centroid)
 */
export function tracePath(g, pts, ox, oy, cs, grow = 0) {
  const n = pts.length >> 1;
  if (n < 3) return;
  let cx = 0;
  let cy = 0;
  if (grow) {
    for (let k = 0; k < n; k++) {
      cx += pts[2 * k];
      cy += pts[2 * k + 1];
    }
    cx /= n;
    cy /= n;
  }
  const P = (k, axis) => {
    const j = ((k % n) + n) % n;
    const v = pts[2 * j + axis];
    if (!grow) return (axis ? oy : ox) + v * cs;
    const dx = pts[2 * j] - cx;
    const dy = pts[2 * j + 1] - cy;
    const d = Math.hypot(dx, dy) || 1;
    return (axis ? oy : ox) + v * cs + (axis ? dy : dx) / d * grow;
  };
  g.moveTo((P(n - 1, 0) + P(0, 0)) / 2, (P(n - 1, 1) + P(0, 1)) / 2);
  for (let k = 0; k < n; k++) {
    g.quadraticCurveTo(P(k, 0), P(k, 1), (P(k, 0) + P(k + 1, 0)) / 2, (P(k, 1) + P(k + 1, 1)) / 2);
  }
  g.closePath();
}

// ----------------------------------------------------------------------------------------------------------------
// Chamber contents (per frame). box = cavity interior in CSS px { x, y, w, h }; u = CSS px per cell.
// ----------------------------------------------------------------------------------------------------------------

/**
 * Pyramid slots for a heap of n items centred at cx on the floor.
 * @returns {{ x: number, y: number }[]}
 */
function heap(n, cx, floor, sx, sy, seed) {
  const out = [];
  let m = Math.max(1, Math.ceil((Math.sqrt(8 * n + 1) - 1) / 2));
  let row = 0;
  while (out.length < n && m > 0) {
    for (let j = 0; j < m && out.length < n; j++) {
      const jx = (hash01(out.length + seed, row + 3) - 0.5) * sx * 0.3;
      out.push({ x: cx + (j - (m - 1) / 2) * sx + jx, y: floor - sy * 0.5 - row * sy * 0.78 });
    }
    m--;
    row++;
  }
  return out;
}

/**
 * Brood heaps along a nursery floor: white eggs, curled larvae, cocooned pupae (≤ 30 shown), frosted when frozen.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {{ egg: number, larva: number, pupa: number }} plan
 * @param {boolean} frozen
 * @param {number} u
 * @param {number} [maxShown=30]
 */
export function drawBroodHeaps(ctx, box, plan, frozen, u, maxShown = 30) {
  const total = (plan.egg || 0) + (plan.larva || 0) + (plan.pupa || 0);
  if (!(total > 0) || !(u > 0)) return;
  const n = Math.min(maxShown, Math.max(1, Math.round(total)));
  const ne = Math.round((n * plan.egg) / total);
  const nl = Math.round((n * plan.larva) / total);
  const np = Math.max(0, n - ne - nl);
  const s = Math.max(3, u);
  const floor = box.y + box.h - s * 0.02;
  const kinds = [];
  if (ne > 0) kinds.push({ k: 'egg', n: ne, sx: s * 0.25, sy: s * 0.26 });
  if (nl > 0) kinds.push({ k: 'larva', n: nl, sx: s * 0.36, sy: s * 0.3 });
  if (np > 0) kinds.push({ k: 'pupa', n: np, sx: s * 0.44, sy: s * 0.27 });
  if (!kinds.length) return;
  const widths = kinds.map((h) => Math.max(1, Math.ceil((Math.sqrt(8 * h.n + 1) - 1) / 2)) * h.sx + s * 0.3);
  const totalW = widths.reduce((a, b) => a + b, 0);
  const scale = totalW > box.w ? box.w / totalW : 1;
  let x = box.x + (box.w - totalW * scale) / 2;
  const eggCol = frozen ? '#dcefff' : '#fbf7ec';
  const larCol = frozen ? '#d3e7f8' : '#f4ead2';
  const pupCol = frozen ? '#c9deef' : '#e9d7b0';
  const edge = frozen ? 'rgba(90,130,170,0.7)' : 'rgba(70,45,25,0.55)';
  ctx.lineWidth = Math.max(0.6, s * 0.03);
  kinds.forEach((h, hi) => {
    const cx = x + (widths[hi] * scale) / 2;
    x += widths[hi] * scale;
    const slots = heap(h.n, cx, floor, h.sx * scale, h.sy, hi * 31);
    if (h.k === 'egg') {
      ctx.fillStyle = eggCol;
      ctx.strokeStyle = edge;
      ctx.beginPath();
      for (const p of slots) {
        ctx.moveTo(p.x + s * 0.105, p.y);
        ctx.ellipse(p.x, p.y, s * 0.105, s * 0.135, 0.35, 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
    } else if (h.k === 'larva') {
      ctx.strokeStyle = larCol;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1.4, s * 0.125);
      ctx.beginPath();
      for (let k = 0; k < slots.length; k++) {
        const p = slots[k];
        const a = hash01(k, 77) * TAU;
        ctx.moveTo(p.x + Math.cos(a + 0.5) * s * 0.11, p.y + Math.sin(a + 0.5) * s * 0.11);
        ctx.arc(p.x, p.y, s * 0.11, a + 0.5, a + 0.5 + Math.PI * 1.55);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineWidth = Math.max(0.6, s * 0.03);
      // tiny heads
      ctx.fillStyle = frozen ? '#9db8cf' : '#c9a46a';
      ctx.beginPath();
      for (let k = 0; k < slots.length; k++) {
        const p = slots[k];
        const a = hash01(k, 77) * TAU + 0.5;
        const hx = p.x + Math.cos(a) * s * 0.11;
        const hy = p.y + Math.sin(a) * s * 0.11;
        ctx.moveTo(hx + s * 0.045, hy);
        ctx.arc(hx, hy, s * 0.045, 0, TAU);
      }
      ctx.fill();
    } else {
      ctx.fillStyle = pupCol;
      ctx.strokeStyle = edge;
      ctx.beginPath();
      for (let k = 0; k < slots.length; k++) {
        const p = slots[k];
        const rot = (hash01(k, 91) - 0.5) * 0.5;
        ctx.moveTo(p.x + s * 0.21, p.y);
        ctx.ellipse(p.x, p.y, s * 0.21, s * 0.12, rot, 0, TAU);
      }
      ctx.fill();
      ctx.stroke();
      // dark meconium tip on each cocoon
      ctx.fillStyle = frozen ? 'rgba(80,110,140,0.6)' : 'rgba(90,60,30,0.55)';
      ctx.beginPath();
      for (let k = 0; k < slots.length; k++) {
        const p = slots[k];
        ctx.moveTo(p.x - s * 0.11, p.y);
        ctx.arc(p.x - s * 0.15, p.y, s * 0.045, 0, TAU);
      }
      ctx.fill();
    }
  });
  if (frozen) {
    ctx.strokeStyle = 'rgba(235,248,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const fx = box.x + box.w * (0.12 + 0.76 * hash01(k, 5));
      const fy = floor - s * (0.2 + 0.3 * hash01(5, k));
      const r = s * 0.08;
      ctx.moveTo(fx - r, fy);
      ctx.lineTo(fx + r, fy);
      ctx.moveTo(fx, fy - r);
      ctx.lineTo(fx, fy + r);
    }
    ctx.stroke();
  }
}

/**
 * Seed pile in a granary: a lumpy heap whose height follows the fill, individual seeds on its face, grey-green mould
 * flecks while a clay granary spoils.
 */
export function drawSeedPile(ctx, box, u, fill, spoiling, seed = 0) {
  if (!(fill > 0.002) || !(u > 0)) return;
  const floor = box.y + box.h + u * 0.02;
  const H = Math.max(u * 0.18, (box.h - u * 0.12) * (0.12 + 0.86 * fill));
  const x0 = box.x - u * 0.05;
  const W = box.w + u * 0.1;
  const N = Math.max(6, Math.ceil(W / (u * 0.3)));
  const top = new Array(N + 1);
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const e = 1 - Math.pow(Math.abs(t - 0.5) * 2, 2.2);
    top[k] = floor - H * Math.max(0, e) * (0.95 + 0.05 * Math.sin(t * 7.1 + seed));
  }
  const g = ctx.createLinearGradient(x0, 0, x0 + W, 0);
  g.addColorStop(0, '#e9d4a2');
  g.addColorStop(0.55, '#d8bb80');
  g.addColorStop(1, '#b8955c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, floor);
  ctx.lineTo(x0, top[0]);
  for (let k = 1; k <= N; k++) {
    const xa = x0 + (W * (k - 1)) / N;
    const xb = x0 + (W * k) / N;
    ctx.quadraticCurveTo(xa, top[k - 1], (xa + xb) / 2, (top[k - 1] + top[k]) / 2);
  }
  ctx.lineTo(x0 + W, top[N]);
  ctx.lineTo(x0 + W, floor);
  ctx.closePath();
  ctx.fill();
  // individual seeds on the face (count ∝ pile area, capped)
  const seeds = Math.min(70, Math.ceil(((W * H) / (u * u)) * 7));
  ctx.fillStyle = '#f3e3bb';
  ctx.strokeStyle = 'rgba(110,75,35,0.6)';
  ctx.lineWidth = Math.max(0.5, u * 0.025);
  ctx.beginPath();
  for (let k = 0; k < seeds; k++) {
    const t = hash01(k + seed, 1);
    const kk = Math.min(N, Math.max(0, Math.round(t * N)));
    const yTop = top[kk];
    if (floor - yTop < u * 0.1) continue;
    const sx = x0 + W * t;
    const sy = yTop + (floor - yTop) * Math.pow(hash01(k, 2 + seed), 1.4) * 0.92 + u * 0.05;
    const r = u * (0.06 + 0.025 * hash01(k, 3));
    ctx.moveTo(sx + r, sy);
    ctx.ellipse(sx, sy, r, r * 0.62, hash01(k, 4) * 3, 0, TAU);
  }
  ctx.fill();
  ctx.stroke();
  // a couple of spilled seeds beside the heap
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const sx = box.x + box.w * (k === 0 ? 0.04 : k === 1 ? 0.96 : 0.9);
    const r = u * 0.06;
    ctx.moveTo(sx + r, floor - u * 0.05);
    ctx.ellipse(sx, floor - u * 0.05, r, r * 0.6, k, 0, TAU);
  }
  ctx.fill();
  if (spoiling) {
    ctx.fillStyle = 'rgba(120,150,108,0.85)';
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const t = 0.1 + 0.8 * hash01(k, 9 + seed);
      const kk = Math.round(t * N);
      const sx = x0 + W * t;
      const sy = top[kk] + (floor - top[kk]) * 0.5 * hash01(k, 11);
      ctx.moveTo(sx + u * 0.07, sy);
      ctx.arc(sx, sy, u * 0.07, 0, TAU);
    }
    ctx.fill();
  }
}

/** Fungus garden: a bed of chewed leaf with fuzzy, spongy white domes ∝ stock (grey under blight). */
export function drawFungusBed(ctx, box, u, fill, blight, time) {
  const floor = box.y + box.h;
  const bedH = u * 0.24;
  ctx.fillStyle = blight ? '#5d5a4c' : '#5a6634';
  ctx.beginPath();
  ctx.moveTo(box.x - u * 0.1, floor + u * 0.05);
  for (let k = 0; k <= 12; k++) ctx.lineTo(box.x + (box.w * k) / 12, floor - bedH * (0.65 + 0.35 * hash01(k, 41)));
  ctx.lineTo(box.x + box.w + u * 0.1, floor + u * 0.05);
  ctx.closePath();
  ctx.fill();
  // leaf fragments in the bed
  ctx.fillStyle = blight ? '#77746a' : '#7f8f45';
  ctx.beginPath();
  for (let k = 0; k < Math.ceil(box.w / (u * 0.4)); k++) {
    const x = box.x + box.w * hash01(k, 43);
    const y = floor - bedH * 0.35 * hash01(k, 44);
    ctx.moveTo(x + u * 0.08, y);
    ctx.ellipse(x, y, u * 0.08, u * 0.035, hash01(k, 45) * 3, 0, TAU);
  }
  ctx.fill();
  const n = Math.max(1, Math.floor(box.w / (u * 0.9)));
  const shown = fill > 0 ? Math.max(1, Math.ceil(fill * n)) : 0;
  const col = blight ? '#a8a69e' : '#f6f3ec';
  const shadeCol = blight ? '#8a8880' : '#d9d1c0';
  const pore = blight ? 'rgba(70,70,64,0.45)' : 'rgba(150,135,110,0.35)';
  const maxR = Math.max(u * 0.3, box.h * 0.48);
  // taller gardens grow taller domes
  const tall = Math.min(1.7, Math.max(1, box.h / (u * 1.7)));
  for (let k = 0; k < shown; k++) {
    const cx = box.x + (box.w * (k + 0.5)) / n + (hash01(k, 4) - 0.5) * u * 0.2;
    const rad = Math.min(maxR, u * (0.38 + 0.2 * hash01(k, 5)) * (0.6 + 0.55 * fill) * tall);
    const cy = floor - bedH * 0.55;
    ctx.fillStyle = shadeCol;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, Math.PI, 0);
    ctx.fill();
    // spongy crown: a lighter dome ringed with soft bumps
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(cx - rad * 0.08, cy - rad * 0.04, rad * 0.84, Math.PI, 0);
    for (let j = 0; j < 8; j++) {
      const a = Math.PI + ((j + 0.5) / 8) * Math.PI;
      const bx = cx + Math.cos(a) * rad * 0.84;
      const by = cy + Math.sin(a) * rad * 0.84;
      ctx.moveTo(bx + rad * 0.2, by);
      ctx.arc(bx, by, rad * 0.2, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = pore;
    ctx.beginPath();
    for (let j = 0; j < 5; j++) {
      const a = Math.PI + (0.15 + 0.7 * hash01(k, j + 50)) * Math.PI;
      const d = rad * (0.25 + 0.45 * hash01(j, k + 51));
      const px = cx + Math.cos(a) * d;
      const py = cy + Math.sin(a) * d;
      ctx.moveTo(px + rad * 0.06, py);
      ctx.arc(px, py, rad * 0.06, 0, TAU);
    }
    ctx.fill();
  }
  void time;
}

/** Repletes hanging from the ceiling, amber gasters swollen by the cap bonus. */
export function drawRepletes(ctx, box, u, n, swell) {
  if (!(n > 0)) return;
  const per = Math.max(1, Math.floor(box.w / (u * 0.62)));
  const rows = box.h > u * 2.2 ? 2 : 1;
  const shown = Math.min(per * rows, Math.ceil(n));
  const rad = u * 0.2 * (1 + Math.min(0.6, swell || 0));
  for (let k = 0; k < shown; k++) {
    const row = Math.floor(k / per);
    const j = k % per;
    const x = box.x + (box.w * (j + 0.5 + (row ? 0.5 : 0))) / per;
    if (x > box.x + box.w - u * 0.1) continue;
    const top = box.y + u * (0.04 + row * 0.95) + Math.sin(((x - box.x) / box.w) * Math.PI) * u * 0.08 * -1;
    // legs/thorax clinging to the ceiling
    ctx.fillStyle = '#2a170d';
    ctx.beginPath();
    ctx.ellipse(x, top + u * 0.08, u * 0.07, u * 0.09, 0, 0, TAU);
    ctx.fill();
    const gy = top + u * 0.16 + rad;
    ctx.fillStyle = '#d98a1f';
    ctx.beginPath();
    ctx.ellipse(x, gy, rad * 0.92, rad, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,214,120,0.75)';
    ctx.beginPath();
    ctx.ellipse(x - rad * 0.12, gy - rad * 0.1, rad * 0.6, rad * 0.62, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,248,220,0.85)';
    ctx.beginPath();
    ctx.arc(x - rad * 0.38, gy - rad * 0.4, rad * 0.18, 0, TAU);
    ctx.fill();
  }
}

/**
 * Mold spot: a fuzzy grey-green blotch with radiating hyphae and a pulsing ring that stays findable at overview zoom.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} u CSS px per cell
 * @param {number} seed
 * @param {number} pulse 0..1
 */
export function drawMoldSpot(ctx, x, y, u, seed, pulse) {
  const R = Math.max(4.5, u * 0.42);
  // contrast backing so the blotch reads on dark cavities and light seed piles alike
  ctx.fillStyle = 'rgba(30,36,22,0.45)';
  ctx.beginPath();
  ctx.arc(x, y, R * 1.25, 0, TAU);
  ctx.fill();
  const tones = ['rgba(150,168,120,0.92)', 'rgba(118,138,96,0.92)', 'rgba(186,198,156,0.9)'];
  for (let k = 0; k < 7; k++) {
    const a = hash01(seed, k) * TAU;
    const d = R * 0.45 * hash01(k, seed);
    ctx.fillStyle = tones[k % 3];
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, R * (0.38 + 0.22 * hash01(k + 3, seed)), 0, TAU);
    ctx.fill();
  }
  // hyphae fuzz
  ctx.strokeStyle = 'rgba(225,235,200,0.75)';
  ctx.lineWidth = Math.max(0.7, u * 0.03);
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU + hash01(seed, k + 20) * 0.5;
    const r0 = R * 0.75;
    const r1 = R * (1.05 + 0.25 * hash01(k, seed + 7));
    ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
  }
  ctx.stroke();
  // spores
  ctx.fillStyle = 'rgba(240,248,220,0.9)';
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = hash01(k + 40, seed) * TAU;
    const d = R * 0.4 * hash01(seed, k + 41);
    ctx.moveTo(x + Math.cos(a) * d + R * 0.12, y + Math.sin(a) * d);
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, R * 0.12, 0, TAU);
  }
  ctx.fill();
  // a faint steady ring plus a periodic expanding "ping" (pulse 0→1), so spots are findable at overview zoom
  // without a field of rings shouting all the time
  const r0 = Math.max(8, R * 1.45);
  ctx.strokeStyle = 'rgba(206,232,140,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r0, 0, TAU);
  ctx.stroke();
  if (pulse < 0.6) {
    const k = pulse / 0.6;
    ctx.strokeStyle = `rgba(214,240,150,${0.75 * (1 - k)})`;
    ctx.lineWidth = 1.8 - k;
    ctx.beginPath();
    ctx.arc(x, y, r0 + k * Math.max(8, R * 1.6), 0, TAU);
    ctx.stroke();
  }
}

// ----------------------------------------------------------------------------------------------------------------
// C154: reserved full-size rooms drawn as works in progress
// ----------------------------------------------------------------------------------------------------------------

/** Cell (x, y) is inside rectangle r. */
function inR(r, x, y) {
  return !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** A tiny worker seen from the side (gaster, thorax, head, legs), centred at (x, y), size s px, facing dir ±1. */
function workAnt(ctx, x, y, s, dir, bob) {
  const yy = y - bob;
  ctx.strokeStyle = 'rgba(30,16,8,0.9)';
  ctx.lineWidth = Math.max(0.6, s * 0.07);
  ctx.beginPath();
  for (const k of [-0.18, 0, 0.18]) {
    ctx.moveTo(x + dir * s * k, yy + s * 0.05);
    ctx.lineTo(x + dir * s * (k - 0.1), yy + s * 0.26 + bob);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(244,222,180,0.45)';
  ctx.beginPath();
  ctx.ellipse(x - dir * s * 0.24, yy, s * 0.24, s * 0.17, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#2c180c';
  ctx.beginPath();
  ctx.ellipse(x - dir * s * 0.24, yy, s * 0.2, s * 0.14, 0, 0, TAU);
  ctx.moveTo(x + s * 0.11, yy - s * 0.02);
  ctx.ellipse(x, yy - s * 0.02, s * 0.11, s * 0.08, 0, 0, TAU);
  ctx.moveTo(x + dir * s * 0.26 + s * 0.1, yy - s * 0.07);
  ctx.ellipse(x + dir * s * 0.26, yy - s * 0.07, s * 0.1, s * 0.09, 0, 0, TAU);
  ctx.fill();
  // a soil pellet held in the mandibles
  ctx.fillStyle = '#c99c66';
  ctx.beginPath();
  ctx.arc(x + dir * s * 0.4, yy - s * 0.02, s * 0.08, 0, TAU);
  ctx.fill();
}

/**
 * C154: a chamber's reserved full-size room (C137) drawn as works in progress rather than an outline: the reserved soil
 * cells look freshly excavated but unfinished — a lighter, sandy fresh-dug wash with pick marks, a faint diagonal
 * "under construction" hatch, a soft cut edge, timber props (posts with a cap plank, a foot block and a brace) and,
 * close up, a worker or two carrying pellets at the face next to the room with a little spoil heap. Distinct from
 * finished cavities (dark, furnished) and from tunnels (dark passages); cells already open (old tunnels), stone and
 * water are not passed in and stay as they are. Deterministic per `seed` (chamber uid); the workers bob with `t` unless
 * `still` (reduced motion). Cell coordinates; (ox, oy) is the grid origin in CSS px, `u` px per cell.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ R: { x: number, y: number, w: number, h: number }, room: { x: number, y: number, w: number, h: number }|null,
 *   soil: number[][], ox: number, oy: number, u: number, seed: number, strong?: boolean, t?: number, still?: boolean }} o
 *   soil: [x, y] cells of R outside the room that are still undug soil
 * @returns {number} cells painted
 */
export function drawReservedWorks(ctx, o) {
  const { R, room, soil, ox, oy, u } = o || {};
  if (!R || !(u > 0) || !Array.isArray(soil) || !soil.length) return 0;
  const seed = o.seed | 0;
  const strong = !!o.strong;
  const px = (x) => ox + x * u;
  const py = (y) => oy + y * u;
  const inSoil = new Set(soil.map((c) => c[0] + ',' + c[1]));
  const has = (x, y) => inSoil.has(x + ',' + y);
  // fresh-dug wash
  ctx.fillStyle = strong ? 'rgba(214,170,112,0.46)' : 'rgba(206,162,106,0.33)';
  ctx.beginPath();
  for (const [x, y] of soil) ctx.rect(px(x), py(y), u, u);
  ctx.fill();
  // under-construction hatch and pick marks, clipped to the reserved soil
  ctx.save();
  ctx.beginPath();
  for (const [x, y] of soil) ctx.rect(px(x), py(y), u, u);
  ctx.clip();
  const L = px(R.x);
  const T = py(R.y);
  const Wd = R.w * u;
  const Ht = R.h * u;
  const gap = Math.max(6, u * 0.9);
  ctx.strokeStyle = strong ? 'rgba(255,220,150,0.24)' : 'rgba(255,214,140,0.13)';
  ctx.lineWidth = Math.max(1, u * 0.12);
  ctx.beginPath();
  for (let k = -Ht; k < Wd; k += gap) {
    ctx.moveTo(L + k, T + Ht);
    ctx.lineTo(L + k + Ht, T);
  }
  ctx.stroke();
  if (u >= 9) {
    ctx.strokeStyle = 'rgba(92,58,30,0.38)';
    ctx.lineWidth = Math.max(0.6, u * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x, y] of soil) {
      if (hash01(x * 31 + seed, y * 17 + 3) < 0.35) continue;
      const cx = px(x) + u * (0.25 + 0.5 * hash01(x + seed * 7, y));
      const cy = py(y) + u * (0.25 + 0.5 * hash01(y + seed * 5, x + 1));
      const a = (hash01(x, y + seed) - 0.5) * 1.2 + 0.6;
      const l = u * 0.16;
      for (const dd of [-0.09, 0.09]) {
        ctx.moveTo(cx + dd * u - Math.cos(a) * l, cy - Math.sin(a) * l);
        ctx.lineTo(cx + dd * u + Math.cos(a) * l, cy + Math.sin(a) * l);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  ctx.restore();
  // a soft cut edge where the reserved soil meets untouched soil (not along the room it grows from)
  ctx.lineWidth = 1;
  ctx.strokeStyle = strong ? 'rgba(255,232,180,0.7)' : 'rgba(240,206,150,0.4)';
  ctx.beginPath();
  for (const [x, y] of soil) {
    const X = px(x);
    const Y = py(y);
    if (!has(x, y - 1) && !inR(room, x, y - 1)) { ctx.moveTo(X, Y + 0.5); ctx.lineTo(X + u, Y + 0.5); }
    if (!has(x, y + 1) && !inR(room, x, y + 1)) { ctx.moveTo(X, Y + u - 0.5); ctx.lineTo(X + u, Y + u - 0.5); }
    if (!has(x - 1, y) && !inR(room, x - 1, y)) { ctx.moveTo(X + 0.5, Y); ctx.lineTo(X + 0.5, Y + u); }
    if (!has(x + 1, y) && !inR(room, x + 1, y)) { ctx.moveTo(X + u - 0.5, Y); ctx.lineTo(X + u - 0.5, Y + u); }
  }
  ctx.stroke();
  if (strong) {
    ctx.strokeStyle = 'rgba(255,226,170,0.55)';
    ctx.setLineDash([3, 4]);
    ctx.strokeRect(L + 0.5, T + 0.5, Wd - 1, Ht - 1);
    ctx.setLineDash([]);
  }
  // timber props: a post down every third column of reserved soil, with a cap plank, a foot block and a brace
  if (u >= 10) {
    const cols = new Map();
    for (const [x, y] of soil) {
      const r = cols.get(x);
      if (!r) cols.set(x, { y0: y, y1: y });
      else { r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y); }
    }
    const wood = '#7a4c28';
    const pw = Math.max(1.5, u * 0.14);
    for (const [x, r] of cols) {
      if (((x + seed) % 3 + 3) % 3 !== 0) continue;
      const X = px(x) + u * 0.5 - pw / 2;
      const Y0 = py(r.y0) + u * 0.08;
      const Y1 = py(r.y1 + 1) - u * 0.04;
      ctx.fillStyle = wood;
      ctx.fillRect(X, Y0, pw, Y1 - Y0);
      ctx.fillRect(X - u * 0.22, Y0, pw + u * 0.44, Math.max(1.5, u * 0.1));
      ctx.fillRect(X - u * 0.1, Y1 - Math.max(1.5, u * 0.09), pw + u * 0.2, Math.max(1.5, u * 0.09));
      ctx.fillStyle = 'rgba(232,186,128,0.55)';
      ctx.fillRect(X, Y0, Math.max(0.6, pw * 0.35), Y1 - Y0);
      if (cols.has(x + 1) && r.y1 > r.y0) {
        ctx.strokeStyle = 'rgba(122,76,40,0.85)';
        ctx.lineWidth = Math.max(1, u * 0.08);
        ctx.beginPath();
        ctx.moveTo(X + pw, Y1 - u * 0.15);
        ctx.lineTo(X + pw + u * 0.7, Y0 + u * 0.35);
        ctx.stroke();
      }
    }
  }
  // close up: one or two workers at the face (reserved soil touching the room) and a little spoil heap
  if (u >= 12 && room) {
    const face = soil.filter(([x, y]) => inR(room, x - 1, y) || inR(room, x + 1, y) || inR(room, x, y - 1) || inR(room, x, y + 1));
    const from = face.length ? face : soil;
    const t = Number.isFinite(o.t) ? o.t : 0;
    const n = Math.min(2, from.length);
    let last = -1;
    for (let k = 0; k < n; k++) {
      let j = Math.floor(hash01(seed + k * 13, 77) * from.length) % from.length;
      if (j === last) j = (j + 1) % from.length;
      last = j;
      const [x, y] = from[j];
      const bob = o.still ? 0 : Math.max(0, Math.sin(t * 5 + k * 2.1 + seed)) * u * 0.05;
      const dir = inR(room, x - 1, y) ? -1 : inR(room, x + 1, y) ? 1 : (hash01(seed, k) < 0.5 ? -1 : 1);
      workAnt(ctx, px(x) + u * 0.5, py(y) + u * 0.7, u * 0.62, dir, bob);
    }
    const low = from.reduce((a, c) => (c[1] > a[1] ? c : a), from[0]);
    ctx.fillStyle = 'rgba(176,128,78,0.8)';
    ctx.beginPath();
    ctx.ellipse(px(low[0]) + u * 0.5, py(low[1] + 1) - u * 0.02, u * 0.32, u * 0.14, 0, Math.PI, 0);
    ctx.fill();
  }
  return soil.length;
}

// Above-view terrain feature painters (pure; draw into the surface terrain cache in world px, SIZE = HEX.px):
// soft ground shadows, lone stones as a small rock cluster on their ground (C260), and fallen logs drawn as one
// continuous log per chain of log hexes with a snapped limb where the chain bends (C261). Owner: WP8.
// Contract: ARCHITECTURE §13.5, §18 C260–C261. Approved looks: previews/map-stones.html "After B" (single stones),
// previews/map-logs.html "After A".

import { HEX } from '../data/balance.js';
import { hexToPixel, hexQR } from '../core/hex.js';
import { clamp, hash01 } from './geom.js';
import { terrainColor, mix, shade, rgba } from './palette.js';

const SIZE = HEX.px;

/** 2-D value noise in [0, 1] (deterministic). */
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

/** A closed polygon (flat x,y list) added with positive (canvas-clockwise) winding, matching arc()/ellipse(). */
function polyOn(g, pts) {
  let a = 0;
  const m = pts.length;
  for (let j = 0; j < m; j += 2) {
    const k = (j + 2) % m;
    a += pts[j] * pts[k + 1] - pts[k] * pts[j + 1];
  }
  const at = (j) => (a < 0 ? m - 2 - j : j);
  g.moveTo(pts[at(0)], pts[at(0) + 1]);
  for (let j = 2; j < m; j += 2) g.lineTo(pts[at(j)], pts[at(j) + 1]);
  g.closePath();
}

/**
 * Soft ground shadow: a few stacked, growing, faint fills of `build(pad)` (which must begin and add a path), offset
 * by (dx, dy). No canvas filters, so it works everywhere and costs a handful of fills in the cached terrain pass.
 */
export function softShadow(g, build, dx, dy, steps = 4, alpha = 0.1, grow = 0.07) {
  g.save();
  g.translate(dx, dy);
  for (let s = steps; s >= 1; s--) {
    g.fillStyle = `rgba(20,16,10,${alpha})`;
    build(SIZE * grow * s);
    g.fill();
  }
  g.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// C260: lone stones — a main rock and one or two smaller ones on the hex's surrounding ground
// ---------------------------------------------------------------------------------------------------------------

/** One irregular rock outline around (x, y): m jagged vertices, radius rad (x) and rad * squash (y). */
function blobPath(g, x, y, rad, seed, pad, squash = 0.84, m = 9) {
  const poly = [];
  const rot = hash01(seed, 61) * 6.28;
  for (let v = 0; v < m; v++) {
    const a = rot + (v / m) * Math.PI * 2;
    const rr = rad * (0.84 + 0.2 * hash01(seed * 11 + v, 63)) + pad;
    poly.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr * squash);
  }
  polyOn(g, poly);
}

/** A single shaded rock in the boulder style (dark body, lit top face nudged up-left, facet, crack, season dressing). */
function drawRock(g, season, x, y, rad, seed, squash = 0.84) {
  const [base, detail] = terrainColor(season, 'stone');
  const path = (k, pad, dx = 0, dy = 0) => {
    g.beginPath();
    blobPath(g, x + dx, y + dy, rad * k, seed, pad, squash);
  };
  softShadow(g, (pad) => path(1, pad), rad * 0.1, rad * 0.17, 3, 0.1, (0.06 * rad) / SIZE);
  g.fillStyle = shade(base, -0.28);
  path(1, 0);
  g.fill();
  g.save();
  path(1, 0);
  g.clip();
  g.fillStyle = base;
  path(0.97, 0, -rad * 0.07, -rad * 0.12);
  g.fill();
  const r = (q) => hash01(seed * 17 + q, q * 5 + 1);
  g.fillStyle = rgba(mix(base, '#ffffff', 0.35), 0.35);
  g.beginPath();
  g.ellipse(x - rad * (0.18 + 0.08 * r(3)), y - rad * (0.24 + 0.06 * r(4)), rad * (0.36 + 0.1 * r(1)), rad * (0.2 + 0.06 * r(2)),
    -0.5 + 0.4 * r(5), 0, Math.PI * 2);
  g.fill();
  if (season === 'winter') {
    g.fillStyle = 'rgba(250,252,255,0.75)';
    path(0.62, 0, -rad * 0.1, -rad * 0.24);
    g.fill();
  } else if (season !== 'summer' && rad > SIZE * 0.4) {
    g.fillStyle = rgba(mix(detail, '#4f7a2a', 0.6), 0.38);
    g.beginPath();
    g.ellipse(x + rad * 0.25, y + rad * 0.32, rad * 0.24, rad * 0.11, r(8) * 0.6, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(38,38,44,0.5)';
  g.lineWidth = 1.1;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  const a = r(6) * 6.28;
  const L = rad * (0.35 + 0.25 * r(7));
  const sx = x + (r(9) - 0.5) * rad * 0.5;
  const sy = y + (r(10) - 0.5) * rad * 0.4;
  g.moveTo(sx, sy);
  g.lineTo(sx + Math.cos(a) * L * 0.5 + (r(11) - 0.5) * 3, sy + Math.sin(a) * L * 0.5 + (r(12) - 0.5) * 3);
  g.lineTo(sx + Math.cos(a) * L, sy + Math.sin(a) * L);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.save();
  g.translate(-0.8, -0.8);
  g.stroke();
  g.restore();
  g.restore();
  g.strokeStyle = rgba(shade(base, -0.55), 0.55);
  g.lineWidth = 1.1;
  path(1, 0);
  g.stroke();
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
}

/**
 * C260: lone stone hexes (no stone neighbour). The hex itself is painted with its surrounding ground by the caller;
 * this adds a main rock a little off-centre plus one or two smaller ones (layout per hex, deterministic), back to front.
 * @param {CanvasRenderingContext2D} g
 * @param {string} season
 * @param {number[]} hexes
 */
export function paintSingleStones(g, season, hexes) {
  for (const i of hexes) {
    const [x, y] = hexToPixel(i, SIZE);
    const r = (k) => hash01(i * 19 + k, k * 3 + 41);
    const rot = r(1) * Math.PI * 2;
    const n = r(2) > 0.45 ? 3 : 2;
    const rocks = [{ x: x - Math.cos(rot) * SIZE * 0.17, y: y - Math.sin(rot) * SIZE * 0.14, rad: SIZE * (0.6 + 0.06 * r(3)), seed: i }];
    for (let k = 1; k < n; k++) {
      const a = rot + (k === 1 ? 0 : 1.6 + 0.5 * r(4));
      const d = SIZE * (0.5 + 0.06 * r(5 + k));
      rocks.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.9, rad: SIZE * (0.32 + 0.08 * r(8 + k)), seed: i * 7 + k });
    }
    rocks.sort((a, b) => a.y - b.y);
    for (const rk of rocks) drawRock(g, season, rk.x, rk.y, rk.rad, rk.seed);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// C261: fallen logs — one straight log on the longest straight run of each chain, a snapped limb along the rest
// ---------------------------------------------------------------------------------------------------------------

const LIGHT = [-0.6, -0.8];   // toward the light (up-left), as the boulders and stones are lit
const TRUNK_R = SIZE * 0.42;  // half-width at the thick end
const TIP_R = SIZE * 0.34;    // at the thin end

const P = (i) => {
  const [x, y] = hexToPixel(i, SIZE);
  return { x, y };
};

/** Connected components of a linked set (each sorted by index). */
export function logComponents(set) {
  const seen = new Set();
  const out = [];
  for (const i of set.hexes) {
    if (seen.has(i)) continue;
    const comp = [];
    const st = [i];
    seen.add(i);
    while (st.length) {
      const h = st.pop();
      comp.push(h);
      for (const k of set.nb.get(h)) {
        if (k >= 0 && !seen.has(k)) {
          seen.add(k);
          st.push(k);
        }
      }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}

/** BFS inside a linked set from the given sources: distance and parent maps. */
function bfs(set, srcs) {
  const dist = new Map();
  const par = new Map();
  const q = [...srcs];
  for (const s of srcs) {
    dist.set(s, 0);
    par.set(s, -1);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const h = q[qi];
    for (const k of set.nb.get(h)) {
      if (k >= 0 && !dist.has(k)) {
        dist.set(k, dist.get(h) + 1);
        par.set(k, h);
        q.push(k);
      }
    }
  }
  return { dist, par };
}

/** The component's longest hex chain (double BFS; ties broken by index, deterministic). */
export function logSpine(set, comp) {
  const far = (src) => {
    const { dist } = bfs(set, [src]);
    let best = src;
    for (const h of comp) if (dist.get(h) > dist.get(best)) best = h;
    return best;
  };
  const a = far(comp[0]);
  const b = far(a);
  const { par } = bfs(set, [b]);
  const path = [];
  for (let h = a; h >= 0; h = par.get(h)) path.push(h);
  return path;
}

/** Split a hex path into straight runs (index ranges [s, e], e > s) by axial step direction. */
export function straightRuns(path) {
  const runs = [];
  let s = 0;
  const dirOf = (k) => {
    const [q0, r0] = hexQR(path[k]);
    const [q1, r1] = hexQR(path[k + 1]);
    return (q1 - q0) * 7 + (r1 - r0);
  };
  for (let k = 1; k < path.length - 1; k++) {
    if (dirOf(k) !== dirOf(k - 1)) {
      runs.push([s, k]);
      s = k;
    }
  }
  runs.push([s, path.length - 1]);
  return runs;
}

/** A dense centreline through `pts`: corners rounded (quadratic, `round` px), resampled every ~2 px, with normals. */
function centreline(pts, round) {
  const raw = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const c = pts[k + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const l2 = Math.hypot(c.x - b.x, c.y - b.y) || 1;
    const r = Math.min(round, l1 * 0.45, l2 * 0.45);
    const p0 = { x: b.x - ((b.x - a.x) / l1) * r, y: b.y - ((b.y - a.y) / l1) * r };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * r, y: b.y + ((c.y - b.y) / l2) * r };
    raw.push(p0);
    for (let t = 1; t < 8; t++) {
      const u = t / 8;
      raw.push({ x: (1 - u) * (1 - u) * p0.x + 2 * u * (1 - u) * b.x + u * u * p2.x, y: (1 - u) * (1 - u) * p0.y + 2 * u * (1 - u) * b.y + u * u * p2.y });
    }
    raw.push(p2);
  }
  raw.push(pts[pts.length - 1]);
  const out = [{ x: raw[0].x, y: raw[0].y, s: 0 }];
  const step = 2;
  let acc = 0;
  let carry = 0;
  for (let k = 1; k < raw.length; k++) {
    const a = raw[k - 1];
    const b = raw[k];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-6) continue;
    let d = step - carry;
    while (d <= L) {
      const u = d / L;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, s: acc + d });
      d += step;
    }
    carry = L - (d - step);
    acc += L;
  }
  const last = raw[raw.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 0.3) out.push({ x: last.x, y: last.y, s: acc });
  for (let k = 0; k < out.length; k++) {
    const a = out[Math.max(0, k - 1)];
    const b = out[Math.min(out.length - 1, k + 1)];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const p = out[k];
    p.tx = (b.x - a.x) / L;
    p.ty = (b.y - a.y) / L;
    p.nx = -p.ty;
    p.ny = p.tx;
    p.l = clamp((p.nx * LIGHT[0] + p.ny * LIGHT[1]) * 1.8, -1, 1);   // +1 when the +normal faces the light
    p.w = 0;
  }
  return { pts: out, len: acc };
}

/**
 * One fallen log (or limb) along a centreline.
 * o: { r0, r1 (half-widths at start / end), cap0, cap1 ('cut' | 'break' | 'none'), seed }
 */
function drawLogAlong(g, season, line, o) {
  const pts = line.pts;
  if (pts.length < 2) return;
  const L = line.len || 1;
  const [base, detail] = terrainColor(season, 'log');
  const seed = o.seed | 0;
  for (const p of pts) p.w = (o.r0 + (o.r1 - o.r0) * (p.s / L)) * (1 + 0.1 * (noise2(p.s / 9, seed * 0.37, 11) - 0.5));
  const at = (p, f) => [p.x + p.nx * p.w * f, p.y + p.ny * p.w * f];
  const band = (A, B) => {
    g.beginPath();
    for (let k = 0; k < pts.length; k++) {
      const [x, y] = at(pts[k], A(pts[k]));
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let k = pts.length - 1; k >= 0; k--) {
      const [x, y] = at(pts[k], B(pts[k]));
      g.lineTo(x, y);
    }
    g.closePath();
  };
  const outline = (pad) => {
    g.beginPath();
    const a = pts[0];
    const b = pts[pts.length - 1];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const x = p.x + p.nx * (p.w + pad);
      const y = p.y + p.ny * (p.w + pad);
      if (!k) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.ellipse(b.x, b.y, b.w * 0.42 + pad, b.w + pad, Math.atan2(b.ty, b.tx), Math.PI / 2, -Math.PI / 2, true);
    for (let k = pts.length - 1; k >= 0; k--) {
      const p = pts[k];
      g.lineTo(p.x - p.nx * (p.w + pad), p.y - p.ny * (p.w + pad));
    }
    g.ellipse(a.x, a.y, a.w * 0.42 + pad, a.w + pad, Math.atan2(a.ty, a.tx), -Math.PI / 2, Math.PI / 2, true);
    g.closePath();
  };
  softShadow(g, (pad) => outline(pad), SIZE * 0.06, SIZE * 0.13, 4, 0.1, 0.05);
  // body: dark bark, lit half, highlight streak, shadow-side darkening
  g.fillStyle = shade(base, -0.22);
  outline(0);
  g.fill();
  g.save();
  outline(0);
  g.clip();
  g.fillStyle = mix(base, detail, 0.55);
  band((p) => p.l * 1.05, (p) => -p.l * 0.05);
  g.fill();
  g.fillStyle = rgba(shade(detail, 0.12), 0.45);
  band((p) => p.l * 0.62, (p) => p.l * 0.38);
  g.fill();
  g.fillStyle = rgba(shade(base, -0.5), 0.45);
  band((p) => -p.l * 0.62, (p) => -p.l * 1.05);
  g.fill();
  // lengthwise bark grooves: broken lines at fixed fractions of the width, wobbling a little
  g.lineCap = 'round';
  const mid = pts[Math.floor(pts.length / 2)];
  [-0.82, -0.56, -0.3, -0.05, 0.2, 0.45, 0.7].forEach((f, gi) => {
    g.beginPath();
    let on = false;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (hash01(seed * 31 + gi * 977 + Math.floor(p.s / 7), 71) < 0.22) {
        on = false;
        continue;
      }
      const [x, y] = at(p, f + 0.05 * (noise2(p.s / 6, gi * 3.1 + seed, 13) - 0.5));
      if (!on) {
        g.moveTo(x, y);
        on = true;
      } else g.lineTo(x, y);
    }
    g.strokeStyle = rgba(shade(base, -0.5), f * mid.l > 0.2 ? 0.55 : 0.75);
    g.lineWidth = 1;
    g.stroke();
  });
  // fine light ridges on the lit half
  g.strokeStyle = rgba(shade(detail, 0.25), 0.3);
  g.lineWidth = 0.7;
  g.beginPath();
  for (const f of [0.32, 0.58, 0.84]) {
    let on = false;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (hash01(seed * 13 + Math.floor(p.s / 9) + f * 100, 73) < 0.3) {
        on = false;
        continue;
      }
      const [x, y] = at(p, f * p.l);
      if (!on) {
        g.moveTo(x, y);
        on = true;
      } else g.lineTo(x, y);
    }
  }
  g.stroke();
  // knots: about one per hex of length
  const nk = Math.max(1, Math.round(L / (SIZE * 1.4)));
  for (let k = 0; k < nk; k++) {
    const s = L * ((k + 0.3 + 0.4 * hash01(seed * 7 + k, 75)) / nk);
    const p = pts[Math.min(pts.length - 1, Math.round((s / L) * (pts.length - 1)))];
    const [x, y] = at(p, hash01(seed * 7 + k, 77) - 0.5);
    const ang = Math.atan2(p.ty, p.tx);
    g.fillStyle = shade(base, -0.45);
    g.beginPath();
    g.ellipse(x, y, p.w * 0.36, p.w * 0.22, ang, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = mix(base, detail, 0.7);
    g.beginPath();
    g.ellipse(x - 0.4, y - 0.6, p.w * 0.2, p.w * 0.11, ang, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = shade(base, -0.55);
    g.beginPath();
    g.arc(x, y, Math.max(0.8, p.w * 0.06), 0, Math.PI * 2);
    g.fill();
  }
  // season dressing on the top / lit half
  if (season === 'spring' || season === 'summer') {
    const moss = season === 'spring' ? '#5c8f33' : '#7f8c38';
    const nm = Math.max(2, Math.round(L / 15));
    for (let k = 0; k < nm; k++) {
      if (hash01(seed * 3 + k, 81) < 0.45) continue;
      const p = pts[Math.min(pts.length - 1, Math.round(((k + hash01(seed * 3 + k, 83)) / nm) * (pts.length - 1)))];
      const [x, y] = at(p, p.l * (0.15 + 0.6 * hash01(seed * 3 + k, 85)));
      const rr = p.w * (0.32 + 0.3 * hash01(seed * 3 + k, 87));
      g.fillStyle = rgba(moss, 0.8);
      g.beginPath();
      g.ellipse(x, y, rr * 1.4, rr, Math.atan2(p.ty, p.tx), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = rgba(shade(moss, 0.3), 0.7);
      g.beginPath();
      g.arc(x - rr * 0.3, y - rr * 0.3, rr * 0.35, 0, Math.PI * 2);
      g.fill();
    }
  } else if (season === 'winter') {
    // snow cap along the top of the log, wavy edge on the shade side
    const sg = (p) => (p.l >= 0 ? 1 : -1);
    const snowHi = (p) => 0.25 * p.l + 0.42 * sg(p);
    const snowLo = (p) => 0.25 * p.l - sg(p) * (0.02 + 0.3 * noise2(p.s / 5, seed, 17));
    g.fillStyle = 'rgba(247,250,255,0.9)';
    band(snowHi, snowLo);
    g.fill();
    g.strokeStyle = 'rgba(160,182,210,0.6)';
    g.lineWidth = 1;
    g.beginPath();
    pts.forEach((p, k) => {
      const [x, y] = at(p, snowLo(p));
      if (!k) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }
  g.restore();
  // ends
  const wood = season === 'winter' ? mix('#cfb490', '#c9ccd2', 0.35) : mix(detail, '#e2bd84', 0.55);
  const cap = (p, kind, dir) => {
    const ang = Math.atan2(p.ty, p.tx);
    if (kind === 'cut') {
      const cx = p.x + p.tx * dir * 0.6;
      const cy = p.y + p.ty * dir * 0.6;
      g.fillStyle = shade(base, -0.4);
      g.beginPath();
      g.ellipse(p.x, p.y, p.w * 0.46, p.w * 1.02, ang, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = wood;
      g.beginPath();
      g.ellipse(cx, cy, p.w * 0.36, p.w * 0.86, ang, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = rgba(shade(wood, -0.3), 0.75);
      g.lineWidth = 0.8;
      for (const k of [0.62, 0.36]) {
        g.beginPath();
        g.ellipse(cx, cy, p.w * 0.36 * k, p.w * 0.86 * k, ang, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = shade(wood, -0.45);
      g.beginPath();
      g.arc(cx, cy, 0.9, 0, Math.PI * 2);
      g.fill();
      const sd = hash01(seed, 89) > 0.5 ? 1 : -1;   // a radial check crack
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + p.nx * p.w * 0.7 * sd, cy + p.ny * p.w * 0.7 * sd);
      g.stroke();
      if (season === 'winter') {
        g.fillStyle = 'rgba(247,250,255,0.9)';
        g.beginPath();
        g.ellipse(p.x + p.nx * p.w * 0.7 * p.l, p.y + p.ny * p.w * 0.7 * p.l, p.w * 0.3, p.w * 0.3, ang, 0, Math.PI * 2);
        g.fill();
      }
    } else if (kind === 'break') {
      // jagged splintered tip in pale wood
      g.fillStyle = wood;
      g.strokeStyle = rgba(shade(base, -0.4), 0.8);
      g.lineWidth = 0.7;
      g.beginPath();
      const m = 5;
      for (let k = 0; k <= m; k++) {
        const f = -0.95 + (1.9 * k) / m;
        const out = (k % 2 ? 0.9 : 0.25 + 0.4 * hash01(seed * 9 + k, 91)) * p.w * 1.2 * dir;
        if (!k) g.moveTo(p.x + p.nx * p.w * f, p.y + p.ny * p.w * f);
        g.lineTo(p.x + p.nx * p.w * f + p.tx * out, p.y + p.ny * p.w * f + p.ty * out);
      }
      g.lineTo(p.x + p.nx * p.w * 0.95, p.y + p.ny * p.w * 0.95);
      g.closePath();
      g.fill();
      g.stroke();
    }
  };
  cap(pts[0], o.cap0, -1);
  cap(pts[pts.length - 1], o.cap1, 1);
  g.lineCap = 'butt';
}

/** Autumn: leaves fallen on and around a log. */
function leafFall(g, line, seed) {
  const cols = ['#c9783a', '#a9502a', '#d8a23a', '#b8642c'];
  const pts = line.pts;
  const n = Math.max(3, Math.round(line.len / 7));
  for (let k = 0; k < n; k++) {
    const p = pts[Math.min(pts.length - 1, Math.floor(hash01(seed * 5 + k, 93) * pts.length))];
    const f = (hash01(seed * 5 + k, 95) - 0.5) * 3.2;
    g.save();
    g.translate(p.x + p.nx * p.w * f, p.y + p.ny * p.w * f);
    g.rotate(hash01(seed * 5 + k, 97) * 6.28);
    g.fillStyle = cols[k % cols.length];
    g.beginPath();
    g.ellipse(0, 0, 4.2, 2.1, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(60,40,20,0.45)';
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(-3.8, 0);
    g.lineTo(3.8, 0);
    g.stroke();
    g.restore();
  }
}

/** Extend a point list past its first / last points by e0 / e1 px. */
function extendEnds(pts, e0, e1) {
  const a = pts[0];
  const b = pts[1];
  const la = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const c = pts[pts.length - 1];
  const d = pts[pts.length - 2];
  const lc = Math.hypot(c.x - d.x, c.y - d.y) || 1;
  return [{ x: a.x - ((b.x - a.x) / la) * e0, y: a.y - ((b.y - a.y) / la) * e0 }, ...pts.slice(1, -1),
    { x: c.x + ((c.x - d.x) / lc) * e1, y: c.y + ((c.y - d.y) / lc) * e1 }];
}

/**
 * C261: fallen logs. Each connected chain of log hexes (a C111 linked set) is one log: a lone hex keeps its tile's
 * angle; a chain draws one straight trunk (cut rings at both ends, thick butt tapering to the tip) along its longest
 * straight run, the rest of the chain becomes a thinner limb that follows the remaining tiles and ends snapped off, and
 * hexes off the chain's spine get a short broken branch. Drawn unclipped over the hexes' ground, limbs under the trunk.
 * @param {CanvasRenderingContext2D} g
 * @param {string} season
 * @param {{ hexes: number[], nb: Map<number, number[]> }} set
 */
export function paintLogChains(g, season, set) {
  if (!set.hexes.length) return;
  const draws = [];
  for (const comp of logComponents(set)) {
    const seed = comp[0];
    if (comp.length === 1) {
      const { x, y } = P(seed);
      const a = hash01(seed * 13 + 3, 3 * 7 + 3) * Math.PI;   // the tile's old rotation
      const ux = Math.cos(a) * SIZE * 0.82;
      const uy = Math.sin(a) * SIZE * 0.82;
      const line = centreline([{ x: x - ux, y: y - uy }, { x: x + ux, y: y + uy }], 0);
      draws.push(() => drawLogAlong(g, season, line, { r0: TRUNK_R * 0.92, r1: TIP_R * 0.95, cap0: 'cut', cap1: 'cut', seed }));
      if (season === 'autumn') draws.push(() => leafFall(g, line, seed));
      continue;
    }
    const path = logSpine(set, comp);
    const flip = hash01(seed, 99) > 0.5;   // which end is the thick butt
    const onPath = new Set(path);
    const { par } = bfs(set, path);
    const below = [];
    const top = [];
    let best = null;
    for (const r of straightRuns(path)) if (!best || r[1] - r[0] > best[1] - best[0]) best = r;
    const [s0, e0] = best;
    const ext0 = s0 > 0 ? SIZE * 0.3 : SIZE * 0.62;
    const ext1 = e0 < path.length - 1 ? SIZE * 0.3 : SIZE * 0.62;
    const trunk = centreline(extendEnds([P(path[s0]), P(path[e0])], ext0, ext1), 0);
    top.push({ line: trunk, o: { ...(flip ? { r0: TIP_R, r1: TRUNK_R } : { r0: TRUNK_R, r1: TIP_R }), cap0: 'cut', cap1: 'cut', seed } });
    // the chain beyond the trunk on either side: a limb that keeps following it, snapped off at its tip
    const limb = (idx) => {
      if (idx.length < 2) return;
      const pts = idx.map((k) => P(path[k]));
      const a = pts[0];
      const b = pts[1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      pts[0] = { x: a.x + ((b.x - a.x) / L) * SIZE * 0.15, y: a.y + ((b.y - a.y) / L) * SIZE * 0.15 };
      const rr = TRUNK_R * 0.72;
      below.push({ line: centreline(extendEnds(pts, 0, SIZE * 0.3), SIZE * 0.5),
        o: { r0: rr, r1: rr * Math.max(0.45, 0.75 - 0.1 * idx.length), cap0: 'none', cap1: 'break', seed: seed * 7 + idx.length } });
    };
    const before = [];
    for (let k = s0; k >= 0; k--) before.push(k);
    const after = [];
    for (let k = e0; k < path.length; k++) after.push(k);
    limb(before);
    limb(after);
    // hexes off the spine: a short broken branch from the hex it hangs off
    for (const h of comp) {
      if (onPath.has(h)) continue;
      const a = P(par.get(h));
      const b = P(h);
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const st = { x: a.x + ((b.x - a.x) / L) * SIZE * 0.2, y: a.y + ((b.y - a.y) / L) * SIZE * 0.2 };
      const en = { x: b.x + ((b.x - a.x) / L) * SIZE * 0.3, y: b.y + ((b.y - a.y) / L) * SIZE * 0.3 };
      const rr = TRUNK_R * 0.55;
      below.push({ line: centreline([st, en], 0), o: { r0: rr, r1: rr * 0.6, cap0: 'none', cap1: 'break', seed: seed * 3 + h } });
    }
    for (const b of below) draws.push(() => drawLogAlong(g, season, b.line, b.o));
    for (const t of top) draws.push(() => drawLogAlong(g, season, t.line, t.o));
    if (season === 'autumn') for (const t of [...below, ...top]) draws.push(() => leafFall(g, t.line, t.o.seed));
  }
  for (const d of draws) d();
}

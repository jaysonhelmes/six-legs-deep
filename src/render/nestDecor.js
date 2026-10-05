// Below-view chamber decorations (render-internal): one small procedural set dressing per chamber type, drawn inside
// the cavity under its contents and the ants. Each entry has a `layout` (cell units, deterministic per chamber uid and
// footprint, memoised), a static `back` painter (rendered once into a per-chamber offscreen cache at the strata-cache
// resolution and blitted every frame) and, for a few types, a subtle animated `anim` painter (scent wisps, heat
// shimmer, ripples, drips, motes, glints) that draws a still frame under reduced motion. C159: a level adornment layer
// (carvings and supports from L3, ornate trim, lamps and an emblem from L7; decorTier) joins the cached static layer.
// Painters take a CSS-px (or cache-px) box = the cavity interior and `u` = px per cell. Owner: WP8 (ARCHITECTURE §13.5, DESIGN §7.6, §7.13).

import { hash01 } from './geom.js';
import { createOffscreen } from './canvas.js';
import { NEST } from './palette.js';
import { cavityBox } from './nestArt.js';

const TAU = Math.PI * 2;
/** Cache margin around the cavity box (cells): decorations may run into the rounded walls, the cavity clip trims them. */
const PAD = 0.3;
const SLEEPER = '#3a2414';

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------

/** Deterministic random stream for a chamber seed and a salt. */
function rng(seed, salt) {
  let k = 0;
  const a = ((seed | 0) * 7919 + salt * 104729) | 0;
  return () => hash01(a, k++ * 31 + 7);
}

/** Corner radii of the cavity in cell units (mirrors nestArt.cavityShape). */
function radii(bw, bh) {
  let rT = Math.min(bh * 0.55, bw * 0.5, 1.25);
  let rB = Math.min(bh * 0.3, bw * 0.5, 0.6);
  if (rT + rB > bh) {
    const k = bh / (rT + rB);
    rT *= k;
    rB *= k;
  }
  return { rT, rB };
}

/** [lo, hi] horizontal room (cell units from the box's left edge) at height y (cells from the top), with padding. */
function spanAt(bw, bh, y, pad) {
  const { rT, rB } = radii(bw, bh);
  let inset = 0;
  if (y < rT) {
    const d = rT - y;
    inset = rT - Math.sqrt(Math.max(0, rT * rT - d * d));
  } else if (y > bh - rB) {
    const d = Math.min(rB, y - (bh - rB));
    inset = rB - Math.sqrt(Math.max(0, rB * rB - d * d));
  }
  const lo = inset + pad;
  const hi = bw - inset - pad;
  return lo <= hi ? [lo, hi] : [bw / 2, bw / 2];
}

function lw(u, k, min = 0.7) {
  return Math.max(min, u * k);
}

/** Curled sleeping ant (head tucked to gaster) centred at (x, y), size s px; dir ±1 mirrors it. */
function sleeper(g, x, y, s, dir, rim) {
  // gaster, thorax, head tucked under; a pale silhouette rim first (as the Below sprites have), then the body
  const parts = [[-0.18, 0, 0.3, 0.24], [0.12, -0.1, 0.15, 0.12], [0.22, 0.1, 0.14, 0.12]];
  const e = Math.max(0.6, s * 0.07);
  for (const [fill, grow] of [[rim, e], [SLEEPER, 0]]) {
    g.fillStyle = fill;
    g.beginPath();
    for (const [dx, dy, rx, ry] of parts) {
      const cx = x + dir * s * dx;
      const cy = y + s * dy;
      g.moveTo(cx + s * rx + grow, cy);
      g.ellipse(cx, cy, s * rx + grow, s * ry + grow, 0, 0, TAU);
    }
    g.fill();
  }
  // a sheen on the gaster and tucked legs
  g.fillStyle = 'rgba(255,235,200,0.22)';
  g.beginPath();
  g.ellipse(x - dir * s * 0.24, y - s * 0.09, s * 0.11, s * 0.06, 0, 0, TAU);
  g.fill();
}

/** Short curved fibre strands along a band (x0..x1 at floor y, up to h px tall). */
function fibres(g, R, x0, x1, y, h, n, cols, width) {
  g.lineWidth = width;
  g.lineCap = 'round';
  for (let c = 0; c < cols.length; c++) {
    g.strokeStyle = cols[c];
    g.beginPath();
    for (let k = c; k < n; k += cols.length) {
      const x = x0 + (x1 - x0) * R();
      const yy = y - h * R();
      const len = h * (0.8 + R());
      const a = (R() - 0.5) * 0.9;
      g.moveTo(x - Math.cos(a) * len, yy - Math.sin(a) * len);
      g.quadraticCurveTo(x, yy - h * 0.3 * (R() - 0.3), x + Math.cos(a) * len, yy + Math.sin(a) * len);
    }
    g.stroke();
  }
  g.lineCap = 'butt';
}

/** Rounded pebble with a soft top-left highlight. */
function pebble(g, x, y, rx, ry, rot, col, hi = 'rgba(255,255,255,0.18)') {
  g.fillStyle = col;
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, TAU);
  g.fill();
  g.fillStyle = hi;
  g.beginPath();
  g.ellipse(x - rx * 0.3, y - ry * 0.35, rx * 0.4, ry * 0.3, rot, 0, TAU);
  g.fill();
}

/** Four-point sparkle. */
function sparkle(g, x, y, r, col) {
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + r * 0.15, y - r * 0.15, x + r, y);
  g.quadraticCurveTo(x + r * 0.15, y + r * 0.15, x, y + r);
  g.quadraticCurveTo(x - r * 0.15, y + r * 0.15, x - r, y);
  g.quadraticCurveTo(x - r * 0.15, y - r * 0.15, x, y - r);
  g.fill();
}

// ----------------------------------------------------------------------------------------------------------------
// decorations per chamber type. Layouts are in cells (box-relative, origin at the box's top-left; floor at y = bh).
// ----------------------------------------------------------------------------------------------------------------

/** @type {Record<string, { layout: Function, back: Function, anim?: Function }>} */
export const DECOR = {};

// Royal Chamber: a throne-bed of chewed fibre under the queen, a scalloped fibre canopy along the vault, grooming
// marks on the walls, and a tiny crown glint over her head.
DECOR.royal_chamber = {
  layout(bw, bh, seed, o) {
    const R = rng(seed, 1);
    const qx = Math.min(bw - 0.6, Math.max(0.6, (o.qf == null ? 0.36 : o.qf) * bw));
    const grow = o.grow || 1;
    const marks = [];
    for (let k = 0; k < Math.min(10, Math.ceil(bw * 1.2)); k++) {
      const y = 0.35 + R() * Math.max(0.2, bh - 1.1);
      const [lo, hi] = spanAt(bw, bh, y, 0.2);
      const x = lo + (hi - lo) * R();
      if (Math.abs(x - qx) < 1.1 * grow) continue;
      marks.push({ x, y, a: (R() - 0.5) * 0.8 });
    }
    return { qx, grow, marks, swags: Math.max(2, Math.min(6, Math.round(bw / 1.8))), qh: o.qh || 0.6 };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    const qx = box.x + L.qx * u;
    // canopy swags along the vault
    if (box.h > u * 1.3) {
      const y0 = box.y + u * 0.12;
      const [lo, hi] = spanAt(box.w / u, box.h / u, 0.12, 0.35);
      const xa = box.x + lo * u;
      const xb = box.x + hi * u;
      const n = L.swags;
      const dip = Math.min(u * 0.32, box.h * 0.16);
      g.strokeStyle = 'rgba(214,168,104,0.42)';
      g.lineWidth = lw(u, 0.09);
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const a = xa + ((xb - xa) * k) / n;
        const b = xa + ((xb - xa) * (k + 1)) / n;
        g.moveTo(a, y0);
        g.quadraticCurveTo((a + b) / 2, y0 + dip * 2, b, y0);
      }
      g.stroke();
      g.fillStyle = 'rgba(244,206,120,0.7)';
      g.beginPath();
      for (let k = 0; k <= n; k++) {
        const x = xa + ((xb - xa) * k) / n;
        g.moveTo(x + u * 0.06, y0 + u * 0.06);
        g.arc(x, y0 + u * 0.06, u * 0.06, 0, TAU);
      }
      g.fill();
    }
    // grooming marks: paired brush strokes on the walls
    g.strokeStyle = 'rgba(232,200,150,0.11)';
    g.lineWidth = lw(u, 0.05, 0.6);
    g.lineCap = 'round';
    g.beginPath();
    for (const m of L.marks) {
      const x = box.x + m.x * u;
      const y = box.y + m.y * u;
      for (const d of [-0.07, 0.07]) {
        g.moveTo(x + d * u, y - u * 0.1);
        g.quadraticCurveTo(x + d * u + u * 0.06 * Math.cos(m.a), y, x + d * u - u * 0.02, y + u * 0.12);
      }
    }
    g.stroke();
    g.lineCap = 'butt';
    // throne-bed of chewed fibre under the queen
    const rx = Math.min(box.w * 0.34, u * 1.25 * L.grow);
    const ry = u * 0.22;
    g.fillStyle = 'rgba(214,170,110,0.1)';
    g.beginPath();
    g.ellipse(qx, floor - u * 0.1, rx * 1.25, u * 0.55, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = '#6a4527';
    g.beginPath();
    g.ellipse(qx, floor - u * 0.04, rx, ry, 0, Math.PI, 0);
    g.lineTo(qx - rx, floor + u * 0.1);
    g.lineTo(qx + rx, floor + u * 0.1);
    g.fill();
    fibres(g, rng(L.marks.length + 3, 9), qx - rx * 0.9, qx + rx * 0.9, floor - u * 0.02, u * 0.13, Math.ceil(rx / u * 14),
      ['rgba(222,186,122,0.7)', 'rgba(170,122,72,0.75)', 'rgba(240,214,160,0.55)'], lw(u, 0.045, 0.6));
  },
  anim(g, box, u, L, t, still) {
    const x = box.x + Math.min(box.w - u * 0.2, L.qx * u + u * 0.62 * L.grow);
    const y = Math.max(box.y + u * 0.2, box.y + box.h - (L.qh + 0.62 * L.grow) * u);
    const tw = still ? 0.55 : 0.25 + 0.6 * Math.pow(Math.max(0, Math.sin(t * 1.4)), 6);
    const a0 = g.globalAlpha;
    g.globalAlpha = a0 * tw;
    sparkle(g, x, y, u * (0.1 + 0.05 * tw), '#ffe9a8');
    g.globalAlpha = a0;
  },
};

// Gallery: sleeping niches cut into the back wall with fibre pads, a few curled sleepers, a drifting "z".
DECOR.gallery = {
  layout(bw, bh, seed) {
    const R = rng(seed, 2);
    const n = Math.max(1, Math.floor((bw - 0.8) / 1.5));
    const niches = [];
    for (let k = 0; k < n; k++) {
      const x = 0.4 + ((bw - 0.8) * (k + 0.5)) / n + (R() - 0.5) * 0.25;
      niches.push({ x, sleep: R() < 0.55, dir: R() < 0.5 ? -1 : 1, w: 0.42 + 0.1 * R() });
    }
    if (!niches.some((q) => q.sleep)) niches[0].sleep = true;
    const crumbs = [];
    for (let k = 0; k < n * 3; k++) crumbs.push({ x: R() * bw, r: 0.03 + 0.02 * R() });
    return { niches, crumbs };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    const H = Math.min(box.h * 0.5, u * 0.55);
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.beginPath();
    for (const q of L.niches) {
      const x = box.x + q.x * u;
      g.moveTo(x + q.w * u, floor);
      g.ellipse(x, floor, q.w * u, H, 0, Math.PI, 0);
    }
    g.fill();
    g.fillStyle = 'rgba(184,140,88,0.75)';
    g.beginPath();
    for (const q of L.niches) {
      const x = box.x + q.x * u;
      g.moveTo(x + q.w * 0.85 * u, floor - u * 0.04);
      g.ellipse(x, floor - u * 0.04, q.w * 0.85 * u, u * 0.07, 0, 0, TAU);
    }
    g.fill();
    const R = rng(L.niches.length, 21);
    for (const q of L.niches) {
      const x = box.x + q.x * u;
      fibres(g, R, x - q.w * 0.7 * u, x + q.w * 0.7 * u, floor - u * 0.05, u * 0.05, 5, ['rgba(226,196,140,0.55)'], lw(u, 0.03, 0.5));
    }
    for (const q of L.niches) if (q.sleep) sleeper(g, box.x + q.x * u, floor - u * 0.2, u * 0.5, q.dir, 'rgba(238,208,160,0.42)');
    g.fillStyle = 'rgba(220,190,140,0.3)';
    g.beginPath();
    for (const c of L.crumbs) {
      const x = box.x + c.x * u;
      g.moveTo(x + c.r * u, floor - u * 0.04);
      g.arc(x, floor - u * 0.04, c.r * u, 0, TAU);
    }
    g.fill();
  },
  anim(g, box, u, L, t, still) {
    if (still || u < 12) return;
    const q = L.niches.find((n) => n.sleep);
    if (!q) return;
    const ph = (t * 0.28 + q.x * 0.13) % 1;
    const s = u * (0.1 + 0.06 * ph);
    const x = box.x + q.x * u + u * 0.15 + ph * u * 0.25;
    const y = box.y + box.h - u * (0.45 + 0.5 * ph);
    if (y - s < box.y) return;
    const a0 = g.globalAlpha;
    g.globalAlpha = a0 * 0.4 * Math.sin(ph * Math.PI);
    g.strokeStyle = '#f2e2c2';
    g.lineWidth = Math.max(0.8, u * 0.04);
    g.beginPath();
    g.moveTo(x - s, y - s);
    g.lineTo(x + s, y - s);
    g.lineTo(x - s, y + s);
    g.lineTo(x + s, y + s);
    g.stroke();
    g.globalAlpha = a0;
  },
};

// Nursery: a warm silk-lined floor and a few silk threads in the corners (the brood heaps sit on top).
DECOR.nursery = {
  layout(bw, bh, seed) {
    const R = rng(seed, 3);
    const threads = [];
    for (let k = 0; k < 4; k++) threads.push({ side: k % 2, y: 0.3 + R() * 0.5, x: 0.3 + R() * 0.6 });
    return { threads, s: seed };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    const cx = box.x + box.w / 2;
    const gr = g.createRadialGradient(cx, floor, 0, cx, floor, Math.max(u, box.w * 0.6));
    gr.addColorStop(0, 'rgba(255,224,170,0.13)');
    gr.addColorStop(1, 'rgba(255,224,170,0)');
    g.fillStyle = gr;
    g.fillRect(box.x - u, box.y, box.w + 2 * u, box.h + u);
    g.fillStyle = 'rgba(240,228,205,0.14)';
    g.beginPath();
    g.ellipse(cx, floor, box.w * 0.52, u * 0.16, 0, Math.PI, 0);
    g.fill();
    g.strokeStyle = 'rgba(245,238,220,0.22)';
    g.lineWidth = lw(u, 0.025, 0.5);
    g.beginPath();
    for (const th of L.threads) {
      const wx = th.side ? box.x + box.w : box.x;
      const wy = box.y + box.h * th.y;
      const fx = th.side ? box.x + box.w - th.x * u : box.x + th.x * u;
      g.moveTo(wx, wy);
      g.quadraticCurveTo((wx + fx) / 2, (wy + floor) / 2 + u * 0.15, fx, floor);
    }
    g.stroke();
    fibres(g, rng(L.s, 31), box.x + u * 0.1, box.x + box.w - u * 0.1, floor - u * 0.02, u * 0.04, Math.ceil(box.w / u * 4),
      ['rgba(236,222,190,0.35)'], lw(u, 0.03, 0.5));
  },
};

// Granary: chaff and husks along the walls, and a few distinct seeds (striped sunflower, millet, grass) in the corners.
DECOR.granary = {
  layout(bw, bh, seed) {
    const R = rng(seed, 4);
    const chaff = [];
    for (let k = 0; k < Math.min(26, Math.ceil(bw * 4)); k++) {
      const side = k % 2;
      chaff.push({ x: side ? bw - R() * bw * 0.22 : R() * bw * 0.22, y: R() * 0.12, a: R() * Math.PI, l: 0.08 + 0.07 * R() });
    }
    const seeds = [];
    const kinds = ['sun', 'millet', 'grass'];
    for (let k = 0; k < Math.min(9, 3 + Math.floor(bw)); k++) {
      const side = k % 2;
      seeds.push({ k: kinds[k % 3], x: side ? bw - 0.12 - R() * 0.35 : 0.12 + R() * 0.35, y: 0.06 + R() * 0.1, a: (R() - 0.5) * 1.6 });
    }
    // a shallow niche in the back wall holding a spare seed or two
    const nicheY = bh > 1.6 ? 0.45 + R() * 0.2 : -1;
    return { chaff, seeds, nicheY, nicheX: R() < 0.5 ? 0.25 : 0.75 };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    if (L.nicheY > 0) {
      const y = box.y + L.nicheY * u;
      const [lo, hi] = spanAt(box.w / u, box.h / u, L.nicheY, 0.4);
      const x = box.x + (lo + (hi - lo) * L.nicheX) * u;
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath();
      g.ellipse(x, y, u * 0.32, u * 0.2, 0, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(160,120,70,0.5)';
      g.beginPath();
      g.ellipse(x, y + u * 0.13, u * 0.28, u * 0.05, 0, 0, TAU);
      g.fill();
      g.fillStyle = '#ead5a4';
      g.beginPath();
      g.ellipse(x - u * 0.08, y + u * 0.06, u * 0.07, u * 0.045, 0.3, 0, TAU);
      g.moveTo(x + u * 0.15, y + u * 0.07);
      g.ellipse(x + u * 0.09, y + u * 0.07, u * 0.06, u * 0.04, -0.4, 0, TAU);
      g.fill();
    }
    g.strokeStyle = 'rgba(210,180,120,0.55)';
    g.lineWidth = lw(u, 0.035, 0.6);
    g.lineCap = 'round';
    g.beginPath();
    for (const c of L.chaff) {
      const x = box.x + c.x * u;
      const y = floor - u * 0.04 - c.y * u;
      g.moveTo(x - Math.cos(c.a) * c.l * u, y - Math.sin(c.a) * c.l * u * 0.4);
      g.lineTo(x + Math.cos(c.a) * c.l * u, y + Math.sin(c.a) * c.l * u * 0.4);
    }
    g.stroke();
    g.lineCap = 'butt';
    for (const s of L.seeds) {
      const x = box.x + s.x * u;
      const y = floor - u * 0.06 - s.y * u;
      if (s.k === 'sun') {
        g.fillStyle = '#3a2c22';
        g.beginPath();
        g.ellipse(x, y, u * 0.12, u * 0.06, s.a, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(235,225,205,0.75)';
        g.lineWidth = lw(u, 0.018, 0.5);
        g.beginPath();
        g.moveTo(x - Math.cos(s.a) * u * 0.09, y - Math.sin(s.a) * u * 0.09);
        g.lineTo(x + Math.cos(s.a) * u * 0.09, y + Math.sin(s.a) * u * 0.09);
        g.stroke();
      } else if (s.k === 'millet') {
        g.fillStyle = '#f0d98c';
        g.beginPath();
        for (let j = 0; j < 3; j++) {
          const mx = x + (j - 1) * u * 0.07;
          const my = y - (j === 1 ? u * 0.05 : 0);
          g.moveTo(mx + u * 0.045, my);
          g.arc(mx, my, u * 0.045, 0, TAU);
        }
        g.fill();
      } else {
        g.fillStyle = '#c4a66a';
        g.beginPath();
        g.ellipse(x, y, u * 0.15, u * 0.03, s.a * 0.4, 0, TAU);
        g.fill();
      }
    }
  },
};

// Scent library: shelves along the back wall lined with glowing pheromone droplets, trail-mark smears on the walls,
// faint wisps rising.
const SCENTS = ['#9fd4ff', '#b8f0c0', '#e2bcff', '#ffd28a'];
DECOR.scent_library = {
  layout(bw, bh, seed) {
    const R = rng(seed, 5);
    const rows = bh >= 2.6 ? [0.42, 0.7] : bh >= 1.6 ? [0.55] : [0.6];
    const shelves = [];
    const drops = [];
    for (const f of rows) {
      const y = bh * f;
      const [lo, hi] = spanAt(bw, bh, y, 0.3);
      if (hi - lo < 0.5) continue;
      shelves.push({ y, lo, hi });
      const n = Math.max(1, Math.floor((hi - lo) / 0.45));
      for (let k = 0; k < n; k++) {
        if (R() < 0.22) continue;
        drops.push({ x: lo + ((hi - lo) * (k + 0.5)) / n + (R() - 0.5) * 0.12, y: y - 0.09, c: Math.floor(R() * SCENTS.length), r: 0.065 + 0.03 * R() });
      }
    }
    const smears = [];
    for (let k = 0; k < Math.min(6, 2 + Math.floor(bw / 2)); k++) {
      const y = 0.3 + R() * Math.max(0.2, bh - 0.6);
      const [lo, hi] = spanAt(bw, bh, y, 0.25);
      smears.push({ x: lo + (hi - lo) * R(), y, l: 0.35 + 0.4 * R(), c: Math.floor(R() * SCENTS.length), a: (R() - 0.5) * 0.5 });
    }
    const wisps = [];
    for (let k = 0; k < Math.min(3, drops.length); k++) wisps.push({ d: Math.floor(R() * drops.length), ph: R() });
    return { shelves, drops, smears, wisps };
  },
  back(g, box, u, L) {
    g.lineCap = 'round';
    for (const s of L.smears) {
      g.strokeStyle = SCENTS[s.c];
      g.globalAlpha = 0.16;
      g.lineWidth = lw(u, 0.07);
      g.setLineDash([u * 0.12, u * 0.09]);
      const x = box.x + s.x * u;
      const y = box.y + s.y * u;
      g.beginPath();
      g.moveTo(x - s.l * u * 0.5, y);
      g.quadraticCurveTo(x, y + s.a * u * 0.4, x + s.l * u * 0.5, y - s.a * u * 0.2);
      g.stroke();
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
    for (const sh of L.shelves) {
      const y = box.y + sh.y * u;
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = lw(u, 0.08);
      g.beginPath();
      g.moveTo(box.x + sh.lo * u, y + u * 0.05);
      g.lineTo(box.x + sh.hi * u, y + u * 0.05);
      g.stroke();
      g.strokeStyle = 'rgba(176,134,88,0.75)';
      g.lineWidth = lw(u, 0.07);
      g.beginPath();
      g.moveTo(box.x + sh.lo * u, y);
      g.lineTo(box.x + sh.hi * u, y);
      g.stroke();
    }
    g.lineCap = 'butt';
    for (let c = 0; c < SCENTS.length; c++) {
      g.fillStyle = SCENTS[c];
      g.beginPath();
      for (const d of L.drops) {
        if (d.c !== c) continue;
        const x = box.x + d.x * u;
        const y = box.y + d.y * u;
        g.moveTo(x + d.r * u, y);
        g.ellipse(x, y, d.r * u, d.r * u * 1.15, 0, 0, TAU);
      }
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath();
    for (const d of L.drops) {
      const x = box.x + (d.x - d.r * 0.35) * u;
      const y = box.y + (d.y - d.r * 0.4) * u;
      g.moveTo(x + d.r * 0.3 * u, y);
      g.arc(x, y, d.r * 0.3 * u, 0, TAU);
    }
    g.fill();
  },
  anim(g, box, u, L, t, still) {
    const a0 = g.globalAlpha;
    for (let c = 0; c < SCENTS.length; c++) {
      const p = still ? 0.6 : 0.5 + 0.5 * Math.sin(t * 1.7 + c * 1.9);
      g.globalAlpha = a0 * (0.1 + 0.12 * p);
      g.fillStyle = SCENTS[c];
      g.beginPath();
      for (const d of L.drops) {
        if (d.c !== c) continue;
        const x = box.x + d.x * u;
        const y = box.y + d.y * u;
        g.moveTo(x + d.r * 2.6 * u, y);
        g.arc(x, y, d.r * 2.6 * u, 0, TAU);
      }
      g.fill();
    }
    if (!still) {
      g.lineWidth = Math.max(0.8, u * 0.035);
      for (const w of L.wisps) {
        const d = L.drops[w.d];
        if (!d) continue;
        const ph = (t * 0.22 + w.ph) % 1;
        const x = box.x + d.x * u;
        const y = box.y + d.y * u - ph * u * 0.9;
        if (y - u * 0.4 < box.y) continue;
        g.globalAlpha = a0 * 0.35 * Math.sin(ph * Math.PI);
        g.strokeStyle = SCENTS[d.c];
        g.beginPath();
        for (let j = 0; j <= 6; j++) {
          const yy = y - (j / 6) * u * 0.45;
          const xx = x + Math.sin(j * 1.1 + t * 1.3 + w.ph * 6) * u * 0.07;
          if (j === 0) g.moveTo(xx, yy);
          else g.lineTo(xx, yy);
        }
        g.stroke();
      }
    }
    g.globalAlpha = a0;
  },
};

// Midden: a layered refuse heap of seed husks, bits of exoskeleton (heads, legs), soil pellets and chitin glints.
DECOR.midden = {
  layout(bw, bh, seed) {
    const R = rng(seed, 6);
    const items = [];
    const n = Math.min(34, Math.ceil(bw * bh * 6));
    const kinds = ['husk', 'head', 'leg', 'pellet', 'husk', 'pellet'];
    for (let k = 0; k < n; k++) {
      const t = 0.1 + 0.8 * R();
      items.push({ k: kinds[k % kinds.length], t, h: R(), a: R() * TAU, s: 0.8 + 0.4 * R() });
    }
    return { items, peak: 0.42 + 0.12 * R() };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h + u * 0.02;
    const H = Math.min(box.h * 0.72, u * 1.7);
    const px = box.x + box.w * L.peak;
    g.fillStyle = '#35281b';
    g.beginPath();
    g.moveTo(box.x + box.w * 0.03, floor);
    g.quadraticCurveTo(px - box.w * 0.08, floor - H * 1.3, px, floor - H);
    g.quadraticCurveTo(px + box.w * 0.1, floor - H * 1.25, box.x + box.w * 0.97, floor);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(80,62,40,0.7)';
    g.beginPath();
    g.moveTo(box.x + box.w * 0.15, floor);
    g.quadraticCurveTo(px, floor - H * 0.9, box.x + box.w * 0.85, floor);
    g.closePath();
    g.fill();
    for (const it of L.items) {
      const hMax = (1 - Math.abs(it.t - L.peak) / Math.max(L.peak, 1 - L.peak)) * H * 0.85;
      const x = box.x + box.w * it.t;
      const y = floor - u * 0.06 - it.h * Math.max(0, hMax);
      const s = u * it.s;
      if (it.k === 'husk') {
        g.fillStyle = '#a8895c';
        g.beginPath();
        g.ellipse(x, y, s * 0.1, s * 0.05, it.a, 0, Math.PI);
        g.fill();
      } else if (it.k === 'head') {
        g.fillStyle = '#1a120c';
        g.beginPath();
        g.ellipse(x, y, s * 0.075, s * 0.065, 0, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(30,20,12,0.9)';
        g.lineWidth = lw(u, 0.025, 0.5);
        g.beginPath();
        g.moveTo(x - s * 0.03, y - s * 0.05);
        g.quadraticCurveTo(x - s * 0.08, y - s * 0.16, x - s * 0.14, y - s * 0.12);
        g.moveTo(x + s * 0.03, y - s * 0.05);
        g.quadraticCurveTo(x + s * 0.08, y - s * 0.16, x + s * 0.14, y - s * 0.12);
        g.stroke();
        g.fillStyle = 'rgba(255,240,210,0.35)';
        g.beginPath();
        g.arc(x - s * 0.025, y - s * 0.02, s * 0.02, 0, TAU);
        g.fill();
      } else if (it.k === 'leg') {
        g.strokeStyle = '#22170e';
        g.lineWidth = lw(u, 0.03, 0.5);
        g.beginPath();
        g.moveTo(x - Math.cos(it.a) * s * 0.12, y - Math.sin(it.a) * s * 0.05);
        g.lineTo(x, y - s * 0.04);
        g.lineTo(x + s * 0.09, y + s * 0.03);
        g.stroke();
      } else {
        pebble(g, x, y, s * 0.07, s * 0.06, 0, '#4d3a26', 'rgba(255,230,190,0.12)');
      }
    }
  },
};

// Barracks: soldier-sized resting hollows, chitin plates and a mandible trophy on the walls, a crossed-mandibles motif
// scratched into the back wall, a sparring pebble.
DECOR.barracks = {
  layout(bw, bh, seed) {
    const R = rng(seed, 7);
    const n = Math.max(1, Math.floor((bw - 0.6) / 1.7));
    const hollows = [];
    for (let k = 0; k < n; k++) hollows.push({ x: 0.3 + ((bw - 0.6) * (k + 0.5)) / n + (R() - 0.5) * 0.2, sleep: R() < 0.5, dir: R() < 0.5 ? -1 : 1 });
    if (!hollows.some((h) => h.sleep)) hollows[0].sleep = true;
    const plates = [];
    const py = Math.max(0.45, Math.min(bh * 0.4, bh - 1));
    const [lo, hi] = spanAt(bw, bh, py, 0.4);
    const mid = bw / 2;
    const np = Math.max(1, Math.min(6, Math.floor((hi - lo) / 1.2)));
    for (let k = 0; k < np; k++) {
      const x = lo + ((hi - lo) * (k + 0.5)) / np;
      if (Math.abs(x - mid) < 0.75 && bh > 1.6) continue;
      plates.push({ x, y: py + (R() - 0.5) * 0.12, kind: k % 2 ? 'mandible' : 'plate' });
    }
    return { hollows, plates, motif: bh > 1.6 ? { x: mid, y: py } : null, peb: R() < 0.5 ? 0.12 : 0.88 };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    // worn resting hollows, a big soldier asleep in some
    g.fillStyle = 'rgba(160,118,74,0.22)';
    g.beginPath();
    for (const h of L.hollows) {
      const x = box.x + h.x * u;
      g.moveTo(x + u * 0.6, floor);
      g.ellipse(x, floor, u * 0.6, u * 0.14, 0, Math.PI, 0);
    }
    g.fill();
    for (const h of L.hollows) if (h.sleep) sleeper(g, box.x + h.x * u, floor - u * 0.22, u * 0.58, h.dir, 'rgba(238,208,160,0.42)');
    // crossed mandibles scratched into the back wall, with a tally below
    if (L.motif) {
      const x = box.x + L.motif.x * u;
      const y = box.y + L.motif.y * u;
      const s = u * 0.42;
      g.strokeStyle = 'rgba(236,206,156,0.32)';
      g.lineWidth = lw(u, 0.045);
      g.lineCap = 'round';
      g.beginPath();
      for (const d of [-1, 1]) mandiblePath(g, x - d * s * 0.55, y + s * 0.6, s * 1.25, d > 0 ? -Math.PI * 0.27 : -Math.PI * 0.73, d);
      g.stroke();
      g.lineWidth = lw(u, 0.03, 0.5);
      g.beginPath();
      for (let k = 0; k < 4; k++) {
        g.moveTo(x - u * 0.13 + k * u * 0.075, y + s * 0.85);
        g.lineTo(x - u * 0.12 + k * u * 0.075, y + s * 0.85 + u * 0.14);
      }
      g.moveTo(x - u * 0.18, y + s * 0.85 + u * 0.12);
      g.lineTo(x + u * 0.16, y + s * 0.85 + u * 0.02);
      g.stroke();
      g.lineCap = 'butt';
    }
    // trophies: chitin shields and a mounted mandible pair
    for (const p of L.plates) {
      const x = box.x + p.x * u;
      const y = box.y + p.y * u;
      if (p.kind === 'plate') {
        const s = u * 0.27;
        g.fillStyle = '#3f2b1c';
        g.strokeStyle = 'rgba(176,130,80,0.85)';
        g.lineWidth = lw(u, 0.035, 0.6);
        g.beginPath();
        g.moveTo(x - s, y - s * 0.75);
        g.quadraticCurveTo(x, y - s * 1.1, x + s, y - s * 0.75);
        g.quadraticCurveTo(x + s, y + s * 0.45, x, y + s);
        g.quadraticCurveTo(x - s, y + s * 0.45, x - s, y - s * 0.75);
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(x, y - s * 0.85);
        g.lineTo(x, y + s * 0.85);
        g.stroke();
        g.fillStyle = 'rgba(255,230,190,0.3)';
        g.beginPath();
        g.ellipse(x - s * 0.45, y - s * 0.3, s * 0.18, s * 0.38, 0.25, 0, TAU);
        g.fill();
      } else {
        const s = u * 0.36;
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x - s * 0.45, y + s * 0.42, s * 0.9, s * 0.14);
        g.fillStyle = '#6b4424';
        g.strokeStyle = 'rgba(30,18,10,0.6)';
        g.lineWidth = lw(u, 0.02, 0.5);
        for (const d of [-1, 1]) {
          g.beginPath();
          mandiblePath(g, x + d * s * 0.12, y + s * 0.42, s, -Math.PI / 2 + d * 0.15, -d, true);
          g.fill();
          g.stroke();
        }
      }
    }
    pebble(g, box.x + box.w * L.peb, floor - u * 0.13, u * 0.2, u * 0.14, 0.2, '#7d7468');
  },
};

/**
 * A resting supermajor (C136 War Hall): a huge square head with crossed mandibles laid on the floor, the small thorax
 * and gaster behind it, centred at (x, y) (its floor contact), size s px; dir ±1 = which way the head faces.
 */
function bigSleeper(g, x, y, s, dir, rim) {
  const parts = [[-0.34, -0.16, 0.2, 0.16], [-0.08, -0.2, 0.12, 0.1], [0.24, -0.26, 0.26, 0.24]];
  const e = Math.max(0.7, s * 0.05);
  for (const [fill, grow] of [[rim, e], [SLEEPER, 0]]) {
    g.fillStyle = fill;
    g.beginPath();
    for (const [dx, dy, rx, ry] of parts) {
      const cx = x + dir * s * dx;
      const cy = y + s * dy;
      g.moveTo(cx + s * rx + grow, cy);
      g.ellipse(cx, cy, s * rx + grow, s * ry + grow, 0, 0, TAU);
    }
    g.fill();
  }
  // the head's midline groove and a sheen on it
  const hx = x + dir * s * 0.24;
  const hy = y - s * 0.26;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(0.6, s * 0.025);
  g.beginPath();
  g.moveTo(hx, hy - s * 0.22);
  g.lineTo(hx, hy + s * 0.08);
  g.stroke();
  g.fillStyle = 'rgba(255,235,200,0.2)';
  g.beginPath();
  g.ellipse(hx - dir * s * 0.09, hy - s * 0.1, s * 0.08, s * 0.05, 0, 0, TAU);
  g.fill();
  // closed mandibles resting on the floor in front of the head
  g.fillStyle = '#4a2f1a';
  g.strokeStyle = 'rgba(20,10,4,0.6)';
  g.lineWidth = Math.max(0.5, s * 0.02);
  for (const d of [-1, 1]) {
    g.beginPath();
    mandiblePath(g, hx + dir * s * 0.2, hy + s * 0.12 + d * s * 0.04, s * 0.3, dir > 0 ? 0.1 * d : Math.PI - 0.1 * d, -d * dir, true);
    g.fill();
    g.stroke();
  }
}

// War Hall (C136): huge supermajors asleep in deep floor hollows, giant mounted mandible trophies and battle plates on
// the back wall, and a heap of shed head capsules in a corner.
DECOR.war_hall = {
  layout(bw, bh, seed) {
    const R = rng(seed, 17);
    const n = Math.max(1, Math.floor((bw - 0.6) / 2.8));
    const giants = [];
    for (let k = 0; k < n; k++) giants.push({ x: 0.3 + ((bw - 0.6) * (k + 0.5)) / n + (R() - 0.5) * 0.25, dir: R() < 0.5 ? -1 : 1, s: 0.95 + R() * 0.2 });
    const trophies = [];
    const ty = Math.max(0.5, Math.min(bh * 0.36, bh - 1.1));
    const [lo, hi] = spanAt(bw, bh, ty, 0.5);
    const nt = Math.max(1, Math.min(5, Math.floor((hi - lo) / 1.6)));
    for (let k = 0; k < nt; k++) trophies.push({ x: lo + ((hi - lo) * (k + 0.5)) / nt, y: ty + (R() - 0.5) * 0.1, kind: k % 2 ? 'plate' : 'mandibles' });
    return { giants, trophies, heap: R() < 0.5 ? 0.1 : 0.9, tall: bh > 1.7 };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    // deep floor hollows, one per sleeping giant
    g.fillStyle = 'rgba(150,108,66,0.26)';
    g.beginPath();
    for (const gi of L.giants) {
      const x = box.x + gi.x * u;
      g.moveTo(x + u * 0.95, floor);
      g.ellipse(x, floor, u * 0.95, u * 0.2, 0, Math.PI, 0);
    }
    g.fill();
    // giant mandible trophies and battle plates on the back wall (over the sleepers' heads when the hall is tall)
    if (L.tall) {
      for (const t of L.trophies) {
        const x = box.x + t.x * u;
        const y = box.y + t.y * u;
        if (t.kind === 'mandibles') {
          const s = u * 0.62;
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(x - s * 0.5, y + s * 0.42, s, s * 0.12);
          g.fillStyle = '#714a28';
          g.strokeStyle = 'rgba(30,18,10,0.65)';
          g.lineWidth = lw(u, 0.025, 0.5);
          for (const d of [-1, 1]) {
            g.beginPath();
            mandiblePath(g, x + d * s * 0.14, y + s * 0.42, s, -Math.PI / 2 + d * 0.22, -d, true);
            g.fill();
            g.stroke();
          }
          g.fillStyle = 'rgba(255,226,170,0.22)';
          g.beginPath();
          g.ellipse(x - s * 0.3, y - s * 0.15, s * 0.06, s * 0.2, 0.3, 0, TAU);
          g.fill();
        } else {
          const s = u * 0.32;
          g.fillStyle = '#3a281b';
          g.strokeStyle = 'rgba(190,140,86,0.85)';
          g.lineWidth = lw(u, 0.04, 0.6);
          g.beginPath();
          g.moveTo(x - s, y - s * 0.8);
          g.quadraticCurveTo(x, y - s * 1.15, x + s, y - s * 0.8);
          g.quadraticCurveTo(x + s, y + s * 0.5, x, y + s * 1.05);
          g.quadraticCurveTo(x - s, y + s * 0.5, x - s, y - s * 0.8);
          g.fill();
          g.stroke();
          g.strokeStyle = 'rgba(236,206,156,0.4)';
          g.beginPath();
          for (const d of [-1, 1]) mandiblePath(g, x - d * s * 0.35, y + s * 0.5, s * 0.95, d > 0 ? -Math.PI * 0.3 : -Math.PI * 0.7, d);
          g.stroke();
        }
      }
    }
    for (const gi of L.giants) bigSleeper(g, box.x + gi.x * u, floor - u * 0.05, u * Math.min(1.7, box.h / u * 0.75) * gi.s, gi.dir, 'rgba(238,208,160,0.4)');
    // a heap of shed head capsules in a corner
    const hx = box.x + box.w * L.heap;
    for (let k = 0; k < 3; k++) pebble(g, hx + (k - 1) * u * 0.18, floor - u * (0.12 + (k === 1 ? 0.12 : 0)), u * 0.15, u * 0.12, 0.2 * k, '#5e4129', 'rgba(255,230,190,0.2)');
  },
};

/**
 * A sickle-shaped ant mandible from its base (x, y), `len` px long pointing at `ang`, curling toward side `d` (±1),
 * with two teeth on the inner edge; `closed` makes a fillable outline, otherwise just the inner and outer strokes.
 */
function mandiblePath(g, x, y, len, ang, d, closed = false) {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const P = (f, o) => [x + ca * len * f - sa * len * o * d, y + sa * len * f + ca * len * o * d];
  const [ox1, oy1] = P(0.5, -0.32);
  const [tx, ty] = P(1, 0.12);
  const [ix1, iy1] = P(0.55, -0.12);
  const [bx, by] = P(0, 0.16);
  g.moveTo(x, y);
  g.quadraticCurveTo(ox1, oy1, tx, ty);
  const [t1x, t1y] = P(0.78, 0.06);
  const [t2x, t2y] = P(0.62, -0.02);
  g.lineTo(t1x, t1y);
  g.lineTo(...P(0.72, -0.05));
  g.lineTo(t2x, t2y);
  g.quadraticCurveTo(ix1, iy1, bx, by);
  if (closed) g.closePath();
}

// Root aphid pen: plant roots poking through the ceiling with green aphids clustered on them, honeydew beads and a drip.
DECOR.root_aphid_pen = {
  layout(bw, bh, seed) {
    const R = rng(seed, 8);
    const nr = 1 + (bw > 3.4 ? 1 : 0) + (bw > 6 ? 1 : 0);
    const roots = [];
    for (let k = 0; k < nr; k++) {
      const x0 = (bw * (k + 0.5)) / nr + (R() - 0.5) * 0.3;
      const len = Math.min(bh * (0.55 + 0.25 * R()), bh - 0.35);
      const bend = (R() - 0.5) * 0.8;
      const pts = [];
      for (let j = 0; j <= 6; j++) {
        const f = j / 6;
        pts.push({ x: x0 + bend * f * f + Math.sin(f * 4 + k) * 0.06, y: -0.2 + (len + 0.2) * f, w: 0.13 * (1 - f * 0.8) + 0.02 });
      }
      const aphids = [];
      const na = 3 + Math.floor(R() * 3) + Math.floor(len * 1.2);
      for (let a = 0; a < na; a++) {
        const f = 0.18 + 0.75 * (a / na) + (R() - 0.5) * 0.06;
        aphids.push({ f, side: a % 2 ? 1 : -1, s: 0.8 + 0.4 * R(), dew: R() < 0.3, hue: R() < 0.7 ? 0 : 1 });
      }
      roots.push({ pts, aphids, hairs: Array.from({ length: 6 }, () => ({ f: 0.2 + 0.75 * R(), side: R() < 0.5 ? -1 : 1, l: 0.08 + 0.1 * R() })), ph: R() });
    }
    return { roots, puddle: R() * 0.2 };
  },
  back(g, box, u, L) {
    const P = (r, f) => {
      const n = r.pts.length - 1;
      const i = Math.min(n - 1, Math.floor(f * n));
      const t = f * n - i;
      const a = r.pts[i];
      const b = r.pts[i + 1];
      return { x: box.x + (a.x + (b.x - a.x) * t) * u, y: box.y + (a.y + (b.y - a.y) * t) * u, w: (a.w + (b.w - a.w) * t) * u };
    };
    for (const r of L.roots) {
      // tapered root
      g.fillStyle = NEST.root;
      g.beginPath();
      const n = r.pts.length;
      for (let j = 0; j < n; j++) {
        const p = r.pts[j];
        const x = box.x + (p.x - p.w) * u;
        const y = box.y + p.y * u;
        if (j === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      const tip = r.pts[n - 1];
      g.quadraticCurveTo(box.x + tip.x * u, box.y + (tip.y + 0.08) * u, box.x + (tip.x + tip.w) * u, box.y + tip.y * u);
      for (let j = n - 1; j >= 0; j--) {
        const p = r.pts[j];
        g.lineTo(box.x + (p.x + p.w) * u, box.y + p.y * u);
      }
      g.closePath();
      g.fill();
      g.strokeStyle = NEST.rootDark;
      g.lineWidth = lw(u, 0.025, 0.5);
      g.stroke();
      g.beginPath();
      for (const h of r.hairs) {
        const p = P(r, h.f);
        g.moveTo(p.x + h.side * p.w, p.y);
        g.lineTo(p.x + h.side * (p.w + h.l * u), p.y + h.l * u * 0.6);
      }
      g.stroke();
      // aphids
      for (const a of r.aphids) {
        const p = P(r, a.f);
        const s = u * 0.11 * a.s;
        const x = p.x + a.side * (p.w + s * 0.55);
        const y = p.y;
        g.fillStyle = a.hue ? '#8cc63f' : '#a8d95c';
        g.beginPath();
        g.ellipse(x, y, s * 0.75, s, a.side * 0.35, 0, TAU);
        g.fill();
        g.fillStyle = 'rgba(255,255,230,0.45)';
        g.beginPath();
        g.ellipse(x - s * 0.25, y - s * 0.35, s * 0.25, s * 0.3, 0, 0, TAU);
        g.fill();
        g.fillStyle = '#26401a';
        g.beginPath();
        g.arc(x - a.side * s * 0.2, y - s * 0.75, Math.max(0.5, s * 0.17), 0, TAU);
        g.fill();
        if (a.dew) {
          g.fillStyle = '#f0b040';
          g.beginPath();
          g.arc(x + a.side * s * 0.25, y + s * 1.15, Math.max(0.6, s * 0.3), 0, TAU);
          g.fill();
        }
      }
    }
    // honeydew puddle under the first root
    const t0 = L.roots[0];
    if (t0) {
      const tip = t0.pts[t0.pts.length - 1];
      g.fillStyle = 'rgba(240,168,48,0.45)';
      g.beginPath();
      g.ellipse(box.x + (tip.x + L.puddle) * u, box.y + box.h - u * 0.03, u * 0.28, u * 0.06, 0, 0, TAU);
      g.fill();
    }
  },
  anim(g, box, u, L, t, still) {
    const r = L.roots[0];
    if (!r) return;
    const tip = r.pts[r.pts.length - 1];
    const x = box.x + tip.x * u;
    const y0 = box.y + (tip.y + 0.1) * u;
    const y1 = box.y + box.h - u * 0.05;
    const ph = still ? 0 : (t * 0.45 + r.ph) % 1;
    const grow = Math.min(1, ph / 0.55);
    const y = ph < 0.55 ? y0 : y0 + (y1 - y0) * Math.pow((ph - 0.55) / 0.45, 2);
    g.fillStyle = '#f0a830';
    g.beginPath();
    g.ellipse(x, y, u * 0.055 * (0.5 + 0.5 * grow), u * 0.065 * (0.5 + 0.5 * grow), 0, 0, TAU);
    g.fill();
  },
};

// Fungus garden: a stack of fresh leaf cuttings waiting to be chewed and white hyphae threading up the walls.
DECOR.fungus_garden = {
  layout(bw, bh, seed) {
    const R = rng(seed, 9);
    const side = R() < 0.5 ? 0 : 1;
    const leaves = [];
    for (let k = 0; k < Math.min(7, 3 + Math.floor(bw / 1.5)); k++) {
      leaves.push({ x: side ? bw - 0.3 - R() * 0.5 : 0.3 + R() * 0.5, y: 0.1 + k * 0.08 + R() * 0.05, a: (R() - 0.5) * 1.2, s: 0.8 + 0.4 * R(), yel: R() < 0.25 });
    }
    const hyphae = [];
    for (let k = 0; k < Math.min(10, 4 + Math.floor(bw)); k++) hyphae.push({ side: k % 2, y: 0.25 + R() * (bh - 0.6), l: 0.3 + 0.5 * R(), c: R() });
    return { leaves, hyphae };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    g.strokeStyle = 'rgba(245,240,228,0.2)';
    g.lineWidth = lw(u, 0.025, 0.5);
    g.beginPath();
    for (const h of L.hyphae) {
      const [lo, hi] = spanAt(box.w / u, box.h / u, h.y, 0.02);
      const x = box.x + (h.side ? hi : lo) * u;
      const y = box.y + h.y * u;
      const dx = (h.side ? -1 : 1) * h.l * u;
      g.moveTo(x, y);
      g.bezierCurveTo(x + dx * 0.4, y - u * 0.2 * h.c, x + dx * 0.7, y + u * 0.15, x + dx, y + u * 0.05);
      g.moveTo(x + dx * 0.5, y);
      g.lineTo(x + dx * 0.6, y - u * 0.12);
    }
    g.stroke();
    for (const lf of L.leaves) {
      const x = box.x + lf.x * u;
      const y = floor - u * 0.1 - lf.y * u;
      const s = u * 0.22 * lf.s;
      g.fillStyle = lf.yel ? '#a7a040' : '#6f9a3c';
      g.beginPath();
      g.ellipse(x, y, s, s * 0.42, lf.a, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(30,50,15,0.55)';
      g.lineWidth = lw(u, 0.02, 0.5);
      g.beginPath();
      g.moveTo(x - Math.cos(lf.a) * s * 0.9, y - Math.sin(lf.a) * s * 0.9);
      g.lineTo(x + Math.cos(lf.a) * s * 0.9, y + Math.sin(lf.a) * s * 0.9);
      g.stroke();
      // a cut notch
      g.fillStyle = 'rgba(20,12,6,0.6)';
      g.beginPath();
      g.arc(x + Math.cos(lf.a + 1.2) * s * 0.8, y + Math.sin(lf.a + 1.2) * s * 0.35, s * 0.18, 0, TAU);
      g.fill();
    }
  },
};

// Repletion hall: grip marks along the ceiling, amber honey streaks down the walls, a sticky puddle, a warm sheen.
DECOR.repletion_hall = {
  layout(bw, bh, seed) {
    const R = rng(seed, 10);
    const streaks = [];
    for (let k = 0; k < Math.min(7, 2 + Math.floor(bw / 1.2)); k++) {
      const side = k % 2;
      const y = 0.3 + R() * Math.max(0.1, bh * 0.4);
      streaks.push({ side, y, l: 0.25 + 0.45 * R() });
    }
    return { streaks, puddle: 0.25 + 0.5 * R(), grips: Math.max(2, Math.floor(bw / 0.62)) };
  },
  back(g, box, u, L) {
    const gr = g.createLinearGradient(0, box.y, 0, box.y + box.h);
    gr.addColorStop(0, 'rgba(255,186,80,0.13)');
    gr.addColorStop(1, 'rgba(255,186,80,0)');
    g.fillStyle = gr;
    g.fillRect(box.x - u, box.y - u * 0.3, box.w + 2 * u, box.h + u * 0.3);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = lw(u, 0.035, 0.6);
    g.beginPath();
    const [lo, hi] = spanAt(box.w / u, box.h / u, 0.08, 0.2);
    for (let k = 0; k < L.grips; k++) {
      const x = box.x + (lo + ((hi - lo) * (k + 0.5)) / L.grips) * u;
      const y = box.y + u * 0.06;
      g.moveTo(x - u * 0.12, y);
      g.quadraticCurveTo(x, y + u * 0.08, x + u * 0.12, y);
    }
    g.stroke();
    g.fillStyle = 'rgba(232,150,40,0.5)';
    g.beginPath();
    for (const s of L.streaks) {
      const [a, b] = spanAt(box.w / u, box.h / u, s.y, 0.02);
      const x = box.x + (s.side ? b - 0.16 : a + 0.16) * u;
      const y = box.y + s.y * u;
      const w = u * 0.04;
      g.moveTo(x - w, y);
      g.lineTo(x - w * 0.6, y + s.l * u);
      g.arc(x, y + s.l * u, w * 1.4, Math.PI, 0, true);
      g.lineTo(x + w, y);
      g.closePath();
    }
    g.fill();
    const px = box.x + box.w * L.puddle;
    const py = box.y + box.h - u * 0.03;
    g.fillStyle = 'rgba(217,142,31,0.55)';
    g.beginPath();
    g.ellipse(px, py, Math.min(box.w * 0.18, u * 0.45), u * 0.07, 0, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,236,180,0.5)';
    g.beginPath();
    g.ellipse(px - u * 0.1, py - u * 0.02, u * 0.1, u * 0.02, 0, 0, TAU);
    g.fill();
  },
};

// Hibernaculum: a frosty-blue cool tint, a heap of insulating fibre, curled sleepers huddled at the ends and frost
// crystals on the ceiling (more of them in winter).
DECOR.hibernaculum = {
  layout(bw, bh, seed, o) {
    const R = rng(seed, 11);
    const huddles = [];
    for (const side of [0, 1]) {
      const n = 3 + Math.floor(R() * 2);
      const cx = side ? bw - 0.8 : 0.8;
      const ants = [];
      for (let k = 0; k < n; k++) ants.push({ x: cx + (k % 3 - 1) * 0.32 + (R() - 0.5) * 0.1, y: 0.2 + (k > 2 ? 0.2 : 0) + R() * 0.04, dir: R() < 0.5 ? -1 : 1 });
      huddles.push(ants);
    }
    const frost = [];
    const nf = o.winter ? Math.min(12, 4 + Math.floor(bw * 1.3)) : Math.min(5, 2 + Math.floor(bw / 2));
    for (let k = 0; k < nf; k++) {
      const y = 0.12 + R() * 0.3;
      const [lo, hi] = spanAt(bw, bh, y, 0.2);
      frost.push({ x: lo + (hi - lo) * R(), y, r: 0.06 + 0.06 * R() });
    }
    return { huddles, frost, winter: !!o.winter, s: seed };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    g.fillStyle = L.winter ? 'rgba(160,205,255,0.13)' : 'rgba(160,205,255,0.08)';
    g.fillRect(box.x - u, box.y - u, box.w + 2 * u, box.h + 2 * u);
    // fibre heap
    g.fillStyle = 'rgba(112,94,70,0.6)';
    g.beginPath();
    g.moveTo(box.x - u * 0.1, floor + u * 0.05);
    for (let k = 0; k <= 10; k++) g.lineTo(box.x + (box.w * k) / 10, floor - u * (0.16 + 0.08 * Math.sin(k * 1.7 + L.s)));
    g.lineTo(box.x + box.w + u * 0.1, floor + u * 0.05);
    g.closePath();
    g.fill();
    fibres(g, rng(L.s, 41), box.x, box.x + box.w, floor - u * 0.06, u * 0.12, Math.ceil(box.w / u * 10),
      ['rgba(214,196,156,0.6)', 'rgba(176,156,120,0.6)', 'rgba(220,232,240,0.35)'], lw(u, 0.035, 0.5));
    for (const h of L.huddles) {
      for (const a of h) sleeper(g, box.x + a.x * u, floor - a.y * u, u * 0.46, a.dir, 'rgba(205,230,255,0.5)');
    }
    // frost crystals on the ceiling
    g.strokeStyle = 'rgba(228,242,255,0.6)';
    g.lineWidth = lw(u, 0.025, 0.5);
    g.beginPath();
    for (const f of L.frost) {
      const x = box.x + f.x * u;
      const y = box.y + f.y * u;
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3;
        g.moveTo(x - Math.cos(a) * f.r * u, y - Math.sin(a) * f.r * u);
        g.lineTo(x + Math.cos(a) * f.r * u, y + Math.sin(a) * f.r * u);
      }
    }
    g.stroke();
  },
};

// Thermal chimney: a darker vertical flue with striated walls, a warm glow and embers-warm pebbles at the bottom, heat
// lines rising.
DECOR.thermal_chimney = {
  layout(bw, bh, seed, o) {
    const R = rng(seed, 12);
    const peb = [];
    for (let k = 0; k < Math.min(7, 3 + Math.floor(bw * 1.5)); k++) peb.push({ x: 0.15 + R() * (bw - 0.3), s: 0.7 + 0.5 * R() });
    const stri = [];
    for (let k = 0; k < 6; k++) stri.push({ side: k % 2, x: 0.05 + R() * 0.25, y0: R() * bh * 0.4, l: 0.6 + R() * bh * 0.5 });
    return { peb, stri, winter: !!o.winter, ph: R() };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    const cx = box.x + box.w / 2;
    const gf = g.createLinearGradient(box.x, 0, box.x + box.w, 0);
    gf.addColorStop(0, 'rgba(0,0,0,0)');
    gf.addColorStop(0.5, 'rgba(0,0,0,0.22)');
    gf.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gf;
    g.fillRect(box.x, box.y - u, box.w, box.h + u);
    g.strokeStyle = 'rgba(255,220,180,0.1)';
    g.lineWidth = lw(u, 0.03, 0.5);
    g.beginPath();
    for (const s of L.stri) {
      const x = s.side ? box.x + box.w - s.x * u : box.x + s.x * u;
      g.moveTo(x, box.y + s.y0 * u);
      g.lineTo(x + (s.side ? -1 : 1) * u * 0.03, box.y + (s.y0 + s.l) * u);
    }
    g.stroke();
    const R0 = Math.max(box.w * 0.9, u * 1.2);
    const gr = g.createRadialGradient(cx, floor, 0, cx, floor, R0);
    gr.addColorStop(0, L.winter ? 'rgba(255,150,70,0.42)' : 'rgba(255,150,70,0.32)');
    gr.addColorStop(0.5, 'rgba(255,120,50,0.1)');
    gr.addColorStop(1, 'rgba(255,120,50,0)');
    g.fillStyle = gr;
    g.fillRect(box.x - u, floor - R0, box.w + 2 * u, R0 + u);
    for (const p of L.peb) {
      pebble(g, box.x + p.x * u, floor - u * 0.08 * p.s, u * 0.12 * p.s, u * 0.08 * p.s, 0, '#6e3a1e', 'rgba(255,160,80,0.55)');
    }
  },
  anim(g, box, u, L, t, still) {
    const a0 = g.globalAlpha;
    g.strokeStyle = 'rgb(255,206,150)';
    g.lineWidth = Math.max(0.9, u * 0.05);
    for (let k = 0; k < 3; k++) {
      const x = box.x + box.w * (0.28 + 0.22 * k);
      const ph = still ? 0.5 : (t * 0.35 + k / 3 + L.ph) % 1;
      const len = box.h * 0.38;
      const yb = box.y + box.h - u * 0.2 - ph * (box.h - len - u * 0.2);
      g.globalAlpha = a0 * (still ? 0.18 : 0.32 * Math.sin(ph * Math.PI));
      g.beginPath();
      for (let j = 0; j <= 7; j++) {
        const y = yb - (j / 7) * len;
        const xx = x + Math.sin(j * 1.15 + (still ? 0 : t * 2.4) + k) * u * 0.08;
        if (j === 0) g.moveTo(xx, y);
        else g.lineTo(xx, y);
      }
      g.stroke();
    }
    g.globalAlpha = a0;
  },
};

// Gate: a big flat door-stone leaning by the doorway (the colony's plug), a stacked pebble wall on the other side,
// a guard's tally scratched into the wall.
DECOR.gate = {
  layout(bw, bh, seed) {
    const R = rng(seed, 13);
    const side = R() < 0.5 ? 0 : 1;
    const peb = [];
    const rows = bh > 1.5 ? 3 : 2;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < 3 - r; k++) peb.push({ x: 0.18 + k * 0.24 + r * 0.12 + (R() - 0.5) * 0.04, y: 0.1 + r * 0.18, s: 0.85 + 0.3 * R(), a: R() * 3, tone: R() });
    }
    return { side, peb, cracks: [R(), R(), R()] };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    const mirror = (x) => (L.side ? box.x + box.w - x * u : box.x + x * u);
    // packed soil sill
    g.fillStyle = 'rgba(120,88,56,0.55)';
    g.beginPath();
    g.ellipse(box.x + box.w / 2, floor, box.w * 0.55, u * 0.09, 0, Math.PI, 0);
    g.fill();
    // door stone leaning on one wall
    const sx = mirror(0.38);
    const sy = floor - Math.min(box.h * 0.4, u * 0.62);
    const rx = Math.min(box.w * 0.24, u * 0.36);
    const ry = Math.min(box.h * 0.42, u * 0.62);
    const rot = (L.side ? -1 : 1) * 0.18;
    pebble(g, sx, sy, rx, ry, rot, '#8a8274', 'rgba(255,255,255,0.16)');
    g.strokeStyle = 'rgba(40,34,28,0.55)';
    g.lineWidth = lw(u, 0.03, 0.5);
    g.beginPath();
    g.ellipse(sx, sy, rx, ry, rot, 0, TAU);
    g.moveTo(sx - rx * 0.2, sy - ry * 0.5);
    g.lineTo(sx + rx * (0.1 + 0.2 * L.cracks[0]), sy - ry * 0.05);
    g.lineTo(sx - rx * 0.05, sy + ry * (0.3 + 0.2 * L.cracks[1]));
    g.stroke();
    // stacked pebble wall on the other side
    for (const p of L.peb) {
      const x = L.side ? box.x + p.x * u : box.x + box.w - p.x * u;
      pebble(g, x, floor - p.y * u, u * 0.13 * p.s, u * 0.095 * p.s, p.a, p.tone < 0.5 ? '#9a9284' : '#7d7568');
    }
    // guard's tally
    if (box.h > u * 1.2) {
      const tx = L.side ? box.x + u * 0.3 : box.x + box.w - u * 0.3 - u * 0.24;
      const ty = box.y + box.h * 0.4;
      g.strokeStyle = 'rgba(236,206,156,0.3)';
      g.lineWidth = lw(u, 0.03, 0.5);
      g.beginPath();
      for (let k = 0; k < 4; k++) {
        g.moveTo(tx + k * u * 0.06, ty);
        g.lineTo(tx + k * u * 0.06, ty + u * 0.15);
      }
      g.moveTo(tx - u * 0.03, ty + u * 0.12);
      g.lineTo(tx + u * 0.22, ty + u * 0.03);
      g.stroke();
    }
  },
};

// Water well: damp darker walls with wet sheen, a pool with a bright surface, pebbles at the rim and droplets on the
// ceiling; ripples and an occasional drip (an ice rim in winter).
DECOR.water_well = {
  layout(bw, bh, seed, o) {
    const R = rng(seed, 14);
    const drops = [];
    for (let k = 0; k < Math.min(5, 2 + Math.floor(bw)); k++) {
      const y = 0.1 + R() * 0.2;
      const [lo, hi] = spanAt(bw, bh, y, 0.2);
      drops.push({ x: lo + (hi - lo) * R(), y });
    }
    const sheen = [];
    for (let k = 0; k < 4; k++) sheen.push({ side: k % 2, y: 0.3 + R() * bh * 0.3, l: 0.3 + 0.4 * R() });
    return { surf: Math.max(0.5, bh * 0.62), drops, sheen, winter: !!o.winter, ph: R(), dx: 0.35 + 0.3 * R() };
  },
  back(g, box, u, L) {
    const top = box.y + L.surf * u;
    const floor = box.y + box.h;
    const damp = g.createLinearGradient(0, box.y, 0, floor);
    damp.addColorStop(0, 'rgba(10,25,40,0)');
    damp.addColorStop(1, 'rgba(10,25,40,0.4)');
    g.fillStyle = damp;
    g.fillRect(box.x - u, box.y, box.w + 2 * u, box.h + u);
    g.strokeStyle = 'rgba(160,210,240,0.16)';
    g.lineWidth = lw(u, 0.03, 0.5);
    g.beginPath();
    for (const s of L.sheen) {
      const [lo, hi] = spanAt(box.w / u, box.h / u, s.y, 0.08);
      const x = box.x + (s.side ? hi : lo) * u;
      g.moveTo(x, box.y + s.y * u);
      g.lineTo(x + (s.side ? -1 : 1) * u * 0.02, box.y + (s.y + s.l) * u);
    }
    g.stroke();
    const water = g.createLinearGradient(0, top, 0, floor);
    water.addColorStop(0, 'rgba(70,140,185,0.92)');
    water.addColorStop(1, 'rgba(34,80,118,0.95)');
    g.fillStyle = water;
    g.fillRect(box.x - u, top, box.w + 2 * u, floor - top + u);
    g.strokeStyle = 'rgba(160,214,240,0.8)';
    g.lineWidth = lw(u, 0.04, 0.8);
    g.beginPath();
    g.moveTo(box.x - u, top);
    g.lineTo(box.x + box.w + u, top);
    g.stroke();
    if (L.winter) {
      g.strokeStyle = 'rgba(240,250,255,0.85)';
      g.lineWidth = lw(u, 0.06, 1);
      g.beginPath();
      g.moveTo(box.x - u, top);
      g.lineTo(box.x + u * 0.35, top);
      g.moveTo(box.x + box.w - u * 0.35, top);
      g.lineTo(box.x + box.w + u, top);
      g.stroke();
    }
    pebble(g, box.x + u * 0.12, top + u * 0.02, u * 0.16, u * 0.09, 0, '#6f6c6a');
    pebble(g, box.x + box.w - u * 0.1, top + u * 0.03, u * 0.13, u * 0.08, 0.3, '#5f5c5a');
    g.fillStyle = 'rgba(150,205,235,0.75)';
    g.beginPath();
    for (const d of L.drops) {
      const x = box.x + d.x * u;
      const y = box.y + d.y * u;
      g.moveTo(x + u * 0.035, y);
      g.ellipse(x, y, u * 0.035, u * 0.05, 0, 0, TAU);
    }
    g.fill();
  },
  anim(g, box, u, L, t, still) {
    const top = box.y + L.surf * u;
    const cx = box.x + box.w * L.dx;
    const a0 = g.globalAlpha;
    g.strokeStyle = 'rgb(190,228,248)';
    g.lineWidth = Math.max(0.8, u * 0.035);
    if (still) {
      g.globalAlpha = a0 * 0.35;
      g.beginPath();
      g.ellipse(cx, top + u * 0.08, box.w * 0.18, u * 0.04, 0, 0, TAU);
      g.stroke();
      g.globalAlpha = a0;
      return;
    }
    const cyc = (t * 0.42 + L.ph) % 1;
    // drip falls during the first third of the cycle, ripples spread after it lands
    if (cyc < 0.3) {
      const d = L.drops[0];
      const y0 = d ? box.y + d.y * u : box.y + u * 0.15;
      const y = y0 + (top - y0) * Math.pow(cyc / 0.3, 2);
      g.fillStyle = 'rgba(170,220,245,0.85)';
      g.beginPath();
      g.ellipse(cx, y, u * 0.03, u * 0.05, 0, 0, TAU);
      g.fill();
    }
    for (let k = 0; k < 2; k++) {
      const ph = (cyc - 0.3 - k * 0.15) / 0.55;
      if (ph <= 0 || ph >= 1) continue;
      g.globalAlpha = a0 * 0.55 * (1 - ph);
      g.beginPath();
      g.ellipse(cx, top + u * 0.06, Math.max(0.5, box.w * 0.35 * ph), Math.max(0.3, u * 0.07 * ph), 0, 0, TAU);
      g.stroke();
    }
    g.globalAlpha = a0;
  },
};

// Nuptial chamber: a slanting light shaft from its exit, pale veined wing shapes glinting on the walls, dust motes in
// the beam (the alates themselves are drawn by the renderer).
DECOR.nuptial_chamber = {
  layout(bw, bh, seed) {
    const R = rng(seed, 15);
    const wings = [];
    const nw = Math.max(1, Math.min(4, Math.floor(bw / 2.4)));
    for (let k = 0; k < nw; k++) {
      const y = Math.min(bh - 0.9, 0.55 + R() * Math.max(0.1, bh * 0.25));
      const [lo, hi] = spanAt(bw, bh, y, 0.6);
      wings.push({ x: lo + ((hi - lo) * (k + 0.5)) / nw + (R() - 0.5) * 0.3, y, tilt: (R() - 0.5) * 0.3, s: 0.85 + 0.3 * R() });
    }
    const motes = [];
    for (let k = 0; k < 7; k++) motes.push({ f: R(), o: R() - 0.5, ph: R() });
    return { beam: 0.6 + 0.25 * R(), wings, motes };
  },
  back(g, box, u, L) {
    const bx = box.x + box.w * L.beam;
    const floor = box.y + box.h;
    const gr = g.createLinearGradient(0, box.y - u * 0.3, 0, floor);
    gr.addColorStop(0, 'rgba(255,242,205,0.22)');
    gr.addColorStop(1, 'rgba(255,242,205,0.02)');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(bx - u * 0.35, box.y - u * 0.3);
    g.lineTo(bx + u * 0.35, box.y - u * 0.3);
    g.lineTo(bx - box.w * 0.12 + u * 0.7, floor);
    g.lineTo(bx - box.w * 0.12 - u * 0.7, floor);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,240,200,0.08)';
    g.beginPath();
    g.ellipse(bx - box.w * 0.12, floor - u * 0.02, u * 0.85, u * 0.12, 0, 0, TAU);
    g.fill();
    // pale wing silhouettes (fore- and hindwing on each side of one body line) glinting on the walls
    g.lineWidth = lw(u, 0.022, 0.5);
    for (const w of L.wings) {
      const x = box.x + w.x * u;
      const y = box.y + w.y * u;
      g.strokeStyle = 'rgba(240,246,255,0.3)';
      g.beginPath();
      g.moveTo(x, y - u * 0.08);
      g.lineTo(x, y + u * 0.2);
      g.stroke();
      for (const [len, a, wid] of [[0.55, -0.5, 0.28], [0.4, -0.02, 0.26], [0.55, Math.PI + 0.5, 0.28], [0.4, Math.PI + 0.02, 0.26]]) {
        const wd = wid * (Math.cos(a) >= 0 ? 1 : -1);
        const s = u * len * w.s;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const tx = x + ca * s;
        const ty = y + sa * s;
        g.fillStyle = 'rgba(214,232,255,0.13)';
        g.strokeStyle = 'rgba(240,246,255,0.45)';
        g.beginPath();
        g.moveTo(x, y);
        g.bezierCurveTo(x + ca * s * 0.4 + sa * s * wd, y + sa * s * 0.4 - ca * s * wd, tx + sa * s * wd * 0.5, ty - ca * s * wd * 0.5, tx, ty);
        g.bezierCurveTo(tx - sa * s * 0.08, ty + ca * s * 0.08, x + ca * s * 0.5 - sa * s * wd * 0.25, y + sa * s * 0.5 + ca * s * wd * 0.25, x, y);
        g.fill();
        g.stroke();
        g.strokeStyle = 'rgba(240,246,255,0.26)';
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(x + ca * s * 0.5 + sa * s * wd * 0.5, y + sa * s * 0.5 - ca * s * wd * 0.5, tx - ca * s * 0.12, ty - sa * s * 0.12);
        g.moveTo(x + ca * s * 0.45 + sa * s * wd * 0.35, y + sa * s * 0.45 - ca * s * wd * 0.35);
        g.lineTo(x + ca * s * 0.6, y + sa * s * 0.6);
        g.stroke();
      }
    }
  },
  anim(g, box, u, L, t, still) {
    const a0 = g.globalAlpha;
    const bx = box.x + box.w * L.beam;
    g.fillStyle = 'rgb(255,244,214)';
    for (const m of L.motes) {
      const f = still ? m.f : (m.f + t * 0.03) % 1;
      const y = box.y + box.h * (1 - f);
      const cx = bx - box.w * 0.12 * (1 - f) + m.o * u * 0.9 * (0.5 + 0.5 * (1 - f));
      const x = cx + (still ? 0 : Math.sin(t * 0.7 + m.ph * 6) * u * 0.06);
      g.globalAlpha = a0 * 0.5 * Math.sin(Math.min(1, Math.max(0, f)) * Math.PI);
      g.beginPath();
      g.arc(x, y, Math.max(0.6, u * 0.03), 0, TAU);
      g.fill();
    }
    g.globalAlpha = a0;
  },
};

// Deep vault: fitted stone blocks lining walls and floor, stone ribs under the vault, glossy amber nuggets (one with a
// tiny trapped insect) and a heap of resin beads; a slow glint.
DECOR.deep_vault = {
  layout(bw, bh, seed) {
    const R = rng(seed, 16);
    const blocks = [];
    // wall courses
    for (const side of [0, 1]) {
      for (let y = 0.45; y < bh - 0.05; y += 0.32) {
        const [lo, hi] = spanAt(bw, bh, y, 0);
        blocks.push({ x: side ? hi - 0.2 : lo, y, w: 0.2 + 0.06 * R(), h: 0.28, t: R(), side });
      }
    }
    // floor course
    for (let x = 0.05; x < bw - 0.2; x += 0.42 + 0.08 * R()) blocks.push({ x, y: bh - 0.14, w: 0.38, h: 0.16, t: R(), side: 2 });
    const nuggets = [];
    const n = Math.min(9, 3 + Math.floor(bw * 1.1));
    for (let k = 0; k < n; k++) {
      const pts = [];
      const m = 6;
      for (let j = 0; j < m; j++) pts.push(0.7 + 0.3 * R());
      nuggets.push({ x: 0.35 + R() * (bw - 0.7), y: 0.22 + R() * 0.25, r: 0.13 + 0.07 * R(), pts, bug: k === 1 });
    }
    const beads = [];
    for (let k = 0; k < Math.min(14, 5 + Math.floor(bw * 1.5)); k++) beads.push({ x: (R() - 0.5) * 0.9, y: R() * 0.3, r: 0.045 + 0.02 * R() });
    return { blocks, nuggets, beads, heap: 0.4 + 0.2 * R(), ph: R() };
  },
  back(g, box, u, L) {
    const floor = box.y + box.h;
    // ribs under the vault
    g.strokeStyle = 'rgba(150,146,140,0.4)';
    g.lineWidth = lw(u, 0.11);
    g.beginPath();
    const r = Math.min(box.w * 0.48, box.h * 0.95);
    g.arc(box.x + box.w / 2, floor, r, Math.PI, 0);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = lw(u, 0.03, 0.5);
    g.beginPath();
    g.arc(box.x + box.w / 2, floor, r - u * 0.05, Math.PI, 0);
    g.stroke();
    // stone blocks
    g.strokeStyle = 'rgba(20,18,16,0.6)';
    g.lineWidth = lw(u, 0.03, 0.5);
    for (const b of L.blocks) {
      const x = box.x + b.x * u;
      const y = box.y + b.y * u;
      const tone = Math.round(82 + 26 * b.t);
      g.fillStyle = `rgb(${tone},${tone - 6},${tone - 14})`;
      g.beginPath();
      g.rect(x, y - b.h * u * 0.5, b.w * u, b.h * u);
      g.fill();
      g.stroke();
    }
    // resin bead heap
    const hx = box.x + box.w * L.heap;
    g.fillStyle = NEST.amber;
    g.beginPath();
    for (const b of L.beads) {
      const x = hx + b.x * u * (1 - b.y);
      const y = floor - u * 0.2 - b.y * u;
      g.moveTo(x + b.r * u, y);
      g.arc(x, y, b.r * u, 0, TAU);
    }
    g.fill();
    // amber nuggets
    for (const nu of L.nuggets) {
      const x = box.x + nu.x * u;
      const y = floor - u * 0.16 - nu.y * u;
      const rr = nu.r * u;
      const gr = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, rr * 0.1, x, y, rr);
      gr.addColorStop(0, '#ffd27a');
      gr.addColorStop(1, '#b8640f');
      g.fillStyle = gr;
      g.beginPath();
      for (let j = 0; j < nu.pts.length; j++) {
        const a = (j / nu.pts.length) * TAU;
        const px = x + Math.cos(a) * rr * nu.pts[j];
        const py = y + Math.sin(a) * rr * nu.pts[j] * 0.85;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      if (nu.bug) {
        g.fillStyle = 'rgba(50,25,8,0.75)';
        g.beginPath();
        g.ellipse(x, y, rr * 0.3, rr * 0.14, 0.4, 0, TAU);
        g.fill();
        g.strokeStyle = 'rgba(50,25,8,0.6)';
        g.lineWidth = Math.max(0.4, rr * 0.06);
        g.beginPath();
        g.moveTo(x - rr * 0.1, y - rr * 0.05);
        g.lineTo(x - rr * 0.2, y - rr * 0.3);
        g.moveTo(x + rr * 0.1, y + rr * 0.05);
        g.lineTo(x + rr * 0.15, y + rr * 0.3);
        g.stroke();
      }
      g.fillStyle = 'rgba(255,248,220,0.75)';
      g.beginPath();
      g.arc(x - rr * 0.35, y - rr * 0.35, rr * 0.16, 0, TAU);
      g.fill();
    }
  },
  anim(g, box, u, L, t, still) {
    if (still || !L.nuggets.length) return;
    const cyc = t * 0.25 + L.ph * 7;
    const k = Math.floor(cyc) % L.nuggets.length;
    const ph = cyc % 1;
    if (ph > 0.35) return;
    const nu = L.nuggets[k];
    const x = box.x + nu.x * u - nu.r * u * 0.35;
    const y = box.y + box.h - u * 0.16 - nu.y * u - nu.r * u * 0.35;
    const a0 = g.globalAlpha;
    g.globalAlpha = a0 * 0.85 * Math.sin((ph / 0.35) * Math.PI);
    sparkle(g, x, y, u * 0.14, '#fff6d8');
    g.globalAlpha = a0;
  },
};

// ----------------------------------------------------------------------------------------------------------------
// C159: level-scaled adornment. On top of each type's set dressing, chambers grow richer as they level: tier 0 (L1–2)
// is the plain dressing above; tier 1 (L3–6) adds wall carvings (a frieze on the back wall), supports (pillars by the
// walls with capitals) and more of the type's floor items; tier 2 (L7+) adds an ornate beaded trim along the vault,
// glowing wall lamps, an emblem medallion on the back wall, a central arch rib in wide rooms and more items again.
// Deterministic per chamber uid, footprint and tier; painted into the same per-chamber static cache (no per-frame cost).
// ----------------------------------------------------------------------------------------------------------------

/**
 * Decoration tier for a chamber level: 0 = L1–2 (sparse), 1 = L3–6 (carvings, supports, more items), 2 = L7+ (ornate
 * trim, glow details, emblem, extra contents).
 * @param {number} level
 * @returns {0|1|2}
 */
export function decorTier(level) {
  const L = Math.floor(Number(level) || 0);
  return L >= 7 ? 2 : L >= 3 ? 1 : 0;
}

/**
 * Per-type adornment style: accent (carvings, trim; "r,g,b"), glow (lamps; "r,g,b"), the support material and the floor
 * motif. Types without an entry use ADORN_DEFAULT.
 */
export const ADORN = {
  royal_chamber: { accent: '244,206,120', glow: '255,214,130', post: 'wood', motif: 'jewels' },
  gallery: { accent: '226,190,136', glow: '255,206,150', post: 'wood', motif: 'pads' },
  nursery: { accent: '246,226,200', glow: '255,200,180', post: 'silk', motif: 'silk' },
  granary: { accent: '230,200,120', glow: '255,220,140', post: 'wood', motif: 'seeds' },
  scent_library: { accent: '190,214,255', glow: '170,220,255', post: 'wood', motif: 'drops' },
  midden: { accent: '170,150,110', glow: '200,230,140', post: 'wood', motif: 'pebbles' },
  barracks: { accent: '214,120,96', glow: '255,170,120', post: 'chitin', motif: 'thorns' },
  war_hall: { accent: '226,104,84', glow: '255,150,110', post: 'chitin', motif: 'thorns' },
  root_aphid_pen: { accent: '170,210,120', glow: '210,255,160', post: 'root', motif: 'leaves' },
  fungus_garden: { accent: '214,230,220', glow: '150,240,220', post: 'root', motif: 'spores' },
  repletion_hall: { accent: '240,180,90', glow: '255,190,90', post: 'wood', motif: 'drops' },
  hibernaculum: { accent: '200,224,240', glow: '190,230,255', post: 'silk', motif: 'silk' },
  thermal_chimney: { accent: '230,150,100', glow: '255,160,90', post: 'stone', motif: 'pebbles' },
  gate: { accent: '200,190,170', glow: '255,210,150', post: 'stone', motif: 'pebbles' },
  water_well: { accent: '160,210,240', glow: '140,210,255', post: 'stone', motif: 'drops' },
  nuptial_chamber: { accent: '236,214,250', glow: '240,210,255', post: 'silk', motif: 'petals' },
  deep_vault: { accent: '250,200,110', glow: '255,200,110', post: 'stone', motif: 'gems' },
};
const ADORN_DEFAULT = { accent: '226,196,150', glow: '255,214,150', post: 'wood', motif: 'pebbles' };
const POSTS = { wood: ['#6e4426', 'rgba(232,186,128,0.5)'], chitin: ['#3a1e14', 'rgba(255,170,140,0.45)'],
  silk: ['#d8cdb8', 'rgba(255,255,255,0.5)'], root: ['#7a6a3c', 'rgba(220,230,160,0.45)'], stone: ['#7d7266', 'rgba(255,245,230,0.4)'] };

/** Adornment layout (cell units, box-relative) for tier ≥ 1. */
function adornLayout(type, bw, bh, seed, tier) {
  const R = rng(seed, 40 + tier);
  const out = { tier, frieze: null, posts: [], items: [], lamps: [], arch: false, emblem: null };
  if (bh >= 1.5) {
    const y = Math.min(bh * 0.36, bh - 0.75);
    const [lo, hi] = spanAt(bw, bh, y, 0.3);
    if (hi - lo > 0.8) out.frieze = { y, lo, hi, n: Math.max(2, Math.floor((hi - lo) / 0.55)) };
  }
  if (bw >= 2.4 && bh >= 1.4) {
    for (const side of [0, 1]) {
      const yTop = Math.min(0.9, bh * 0.45);
      const [lo, hi] = spanAt(bw, bh, yTop, 0.2);
      out.posts.push({ x: side ? hi - 0.12 : lo + 0.12, top: yTop });
    }
  }
  const n = Math.min(36, Math.round(bw * (tier >= 2 ? 2.4 : 1.3)));
  for (let k = 0; k < n; k++) out.items.push({ x: 0.25 + R() * Math.max(0.1, bw - 0.5), y: R() * 0.14, r: 0.55 + 0.45 * R(), a: R() * Math.PI, c: R() });
  if (tier >= 2) {
    const m = Math.max(2, Math.min(5, Math.round(bw / 2.4)));
    for (let k = 0; k < m; k++) {
      const y = Math.min(bh - 0.5, bh * (0.32 + 0.2 * R()));
      const [lo, hi] = spanAt(bw, bh, y, 0.35);
      out.lamps.push({ x: lo + ((hi - lo) * (k + 0.5)) / m, y, r: 0.11 + 0.04 * R() });
    }
    out.arch = bw >= 6.5 && bh >= 2.4;
    if (bw >= 3 && bh >= 2) out.emblem = { x: bw / 2, y: Math.min(bh * 0.3, 0.85), r: Math.min(0.32, bh * 0.14) };
  }
  return out;
}

/** One floor item of a motif at (x, y), size s px. */
function motifItem(g, motif, x, y, s, it, A) {
  switch (motif) {
    case 'jewels':
      pebble(g, x, y, s * 0.55, s * 0.45, it.a, it.c < 0.5 ? '#e8a640' : '#f4cf6a', 'rgba(255,255,230,0.55)');
      break;
    case 'seeds':
      g.fillStyle = it.c < 0.4 ? '#e8d29a' : it.c < 0.7 ? '#c7a468' : '#3c2c20';
      g.beginPath();
      g.ellipse(x, y, s * 0.6, s * 0.32, it.a, 0, TAU);
      g.fill();
      break;
    case 'drops':
      g.fillStyle = `rgba(${A.glow},0.55)`;
      g.beginPath();
      g.moveTo(x, y - s * 0.75);
      g.quadraticCurveTo(x + s * 0.5, y, x, y + s * 0.3);
      g.quadraticCurveTo(x - s * 0.5, y, x, y - s * 0.75);
      g.fill();
      break;
    case 'silk':
      g.fillStyle = 'rgba(246,240,226,0.62)';
      g.beginPath();
      g.ellipse(x, y, s * 0.5, s * 0.32, it.a * 0.3, 0, TAU);
      g.fill();
      break;
    case 'thorns':
      g.fillStyle = '#4a261a';
      g.beginPath();
      g.moveTo(x - s * 0.3, y + s * 0.2);
      g.lineTo(x + s * 0.1, y - s * 0.9);
      g.lineTo(x + s * 0.3, y + s * 0.2);
      g.fill();
      break;
    case 'leaves':
      g.fillStyle = it.c < 0.5 ? 'rgba(120,170,80,0.7)' : 'rgba(160,190,90,0.65)';
      g.beginPath();
      g.ellipse(x, y, s * 0.6, s * 0.22, it.a, 0, TAU);
      g.fill();
      break;
    case 'spores':
      g.fillStyle = 'rgba(236,244,236,0.7)';
      g.beginPath();
      g.arc(x, y - s * 0.1, s * 0.22, 0, TAU);
      g.fill();
      break;
    case 'petals':
      g.fillStyle = 'rgba(236,222,250,0.42)';
      g.beginPath();
      g.ellipse(x, y, s * 0.7, s * 0.24, it.a, 0, TAU);
      g.fill();
      break;
    case 'gems':
      g.fillStyle = it.c < 0.5 ? '#7fd0e8' : '#e88fb0';
      g.beginPath();
      g.moveTo(x, y - s * 0.55);
      g.lineTo(x + s * 0.4, y);
      g.lineTo(x, y + s * 0.3);
      g.lineTo(x - s * 0.4, y);
      g.closePath();
      g.fill();
      break;
    case 'pads':
      fibres(g, rng(Math.round(x * 7 + y), 5), x - s * 0.5, x + s * 0.5, y, s * 0.25, 3, ['rgba(226,196,140,0.6)'], Math.max(0.5, s * 0.1));
      break;
    default:
      pebble(g, x, y, s * 0.45, s * 0.32, it.a, it.c < 0.5 ? '#6b5a48' : '#857260');
  }
}

/**
 * Paint the level adornment of a chamber (tier ≥ 1) into the static decoration layer: frieze carvings and pillars
 * (tier 1+), more floor items, then the beaded vault trim, a central arch rib, wall lamps with a soft glow and the
 * emblem (tier 2).
 */
function paintAdorn(g, type, box, u, L) {
  if (!L || !(L.tier > 0)) return;
  const A = ADORN[type] || ADORN_DEFAULT;
  const floor = box.y + box.h;
  const bw = box.w / u;
  const bh = box.h / u;
  // wall carvings: a frieze of chevrons between two incised lines
  if (L.frieze) {
    const f = L.frieze;
    const y = box.y + f.y * u;
    const x0 = box.x + f.lo * u;
    const x1 = box.x + f.hi * u;
    const hgt = Math.min(u * 0.22, box.h * 0.12);
    g.strokeStyle = `rgba(${A.accent},${L.tier >= 2 ? 0.34 : 0.22})`;
    g.lineWidth = lw(u, 0.035, 0.6);
    g.beginPath();
    g.moveTo(x0, y - hgt);
    g.lineTo(x1, y - hgt);
    g.moveTo(x0, y + hgt);
    g.lineTo(x1, y + hgt);
    const step = (x1 - x0) / f.n;
    for (let k = 0; k < f.n; k++) {
      const a = x0 + step * k;
      g.moveTo(a + step * 0.15, y + hgt * 0.6);
      g.lineTo(a + step * 0.5, y - hgt * 0.6);
      g.lineTo(a + step * 0.85, y + hgt * 0.6);
    }
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.moveTo(x0, y + hgt + 1);
    g.lineTo(x1, y + hgt + 1);
    g.stroke();
  }
  // supports: pillars by the walls, with a capital and a base
  const [pc, ph] = POSTS[A.post] || POSTS.wood;
  const pw = Math.max(1.5, u * 0.16);
  for (const p of L.posts) {
    const x = box.x + p.x * u - pw / 2;
    const top = box.y + p.top * u;
    g.fillStyle = pc;
    g.fillRect(x, top, pw, floor - top);
    g.fillRect(x - pw * 0.6, top - pw * 0.25, pw * 2.2, pw * 0.6);
    g.fillRect(x - pw * 0.4, floor - pw * 0.5, pw * 1.8, pw * 0.5);
    g.fillStyle = ph;
    g.fillRect(x, top, Math.max(0.6, pw * 0.3), floor - top);
  }
  // more of the type's floor items
  const motif = A.motif;
  for (const it of L.items) motifItem(g, motif, box.x + it.x * u, floor - u * (0.06 + it.y), u * 0.16 * it.r, it, A);
  if (L.tier < 2) return;
  // ornate trim: beads along the vault
  {
    const n = Math.max(4, Math.floor(bw / 0.45));
    g.fillStyle = `rgba(${A.accent},0.7)`;
    g.beginPath();
    for (let k = 0; k <= n; k++) {
      const yy = 0.16 + 0.02 * (k % 2);
      const [lo, hi] = spanAt(bw, bh, yy, 0.18);
      const x = box.x + (lo + ((hi - lo) * k) / n) * u;
      const y = box.y + yy * u;
      const r = u * (k % 2 ? 0.045 : 0.065);
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
    g.fill();
    g.strokeStyle = `rgba(${A.accent},0.38)`;
    g.lineWidth = lw(u, 0.03, 0.6);
    g.beginPath();
    const [lo, hi] = spanAt(bw, bh, 0.16, 0.18);
    g.moveTo(box.x + lo * u, box.y + 0.16 * u);
    g.lineTo(box.x + hi * u, box.y + 0.16 * u);
    g.stroke();
  }
  // a central arch rib in wide rooms
  if (L.arch) {
    g.strokeStyle = pc;
    g.lineWidth = Math.max(1.5, u * 0.12);
    g.beginPath();
    const cx = box.x + box.w / 2;
    const r = Math.min(box.w * 0.22, box.h * 0.8);
    g.arc(cx, floor, r, Math.PI, 0);
    g.stroke();
  }
  // glow details: lamps in small wall niches
  for (const lp of L.lamps) {
    const x = box.x + lp.x * u;
    const y = box.y + lp.y * u;
    const gr = g.createRadialGradient(x, y, 0, x, y, u * 0.75);
    gr.addColorStop(0, `rgba(${A.glow},0.32)`);
    gr.addColorStop(1, `rgba(${A.glow},0)`);
    g.fillStyle = gr;
    g.fillRect(x - u * 0.75, y - u * 0.75, u * 1.5, u * 1.5);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.ellipse(x, y + u * 0.04, u * 0.17, u * 0.2, 0, 0, TAU);
    g.fill();
    g.fillStyle = `rgba(${A.glow},0.95)`;
    g.beginPath();
    g.arc(x, y, u * lp.r, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,255,240,0.8)';
    g.beginPath();
    g.arc(x - u * lp.r * 0.3, y - u * lp.r * 0.3, u * lp.r * 0.35, 0, TAU);
    g.fill();
  }
  // emblem: a medallion on the back wall
  if (L.emblem) {
    const x = box.x + L.emblem.x * u;
    const y = box.y + L.emblem.y * u;
    const r = L.emblem.r * u;
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath();
    g.arc(x, y + 1, r * 1.15, 0, TAU);
    g.fill();
    g.strokeStyle = `rgba(${A.accent},0.75)`;
    g.lineWidth = lw(u, 0.05, 0.7);
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.stroke();
    g.fillStyle = `rgba(${A.accent},0.55)`;
    sparkle(g, x, y, r * 0.7, `rgba(${A.accent},0.6)`);
  }
}

// ----------------------------------------------------------------------------------------------------------------
// public API
// ----------------------------------------------------------------------------------------------------------------

const LAYOUTS = new Map();

/**
 * Memoised decoration layout for a chamber type in a bw × bh cell cavity.
 * @returns {any|null}
 */
export function decorLayout(type, bw, bh, seed, o = {}) {
  const def = DECOR[type];
  if (!def) return null;
  const key = `${type}|${seed | 0}|${bw.toFixed(3)}|${bh.toFixed(3)}|${o.winter ? 1 : 0}|${o.key || ''}`;
  let L = LAYOUTS.get(key);
  if (!L) {
    L = def.layout(bw, bh, seed | 0, o);
    if (LAYOUTS.size > 300) LAYOUTS.clear();
    LAYOUTS.set(key, L);
  }
  return L;
}

/** Does this chamber type have an animated decoration layer? */
export function hasDecorAnim(type) {
  return !!(DECOR[type] && DECOR[type].anim);
}

/**
 * C159: memoised adornment layout for a tier (null at tier 0).
 * @returns {Object|null}
 */
export function adornmentLayout(type, bw, bh, seed, tier) {
  const k = Math.max(0, Math.min(2, Math.floor(Number(tier) || 0)));
  if (!k || !DECOR[type]) return null;
  const key = `adorn|${type}|${seed | 0}|${bw.toFixed(3)}|${bh.toFixed(3)}|${k}`;
  let L = LAYOUTS.get(key);
  if (!L) {
    L = adornLayout(type, bw, bh, seed | 0, k);
    if (LAYOUTS.size > 300) LAYOUTS.clear();
    LAYOUTS.set(key, L);
  }
  return L;
}

/**
 * Paint a chamber's static decoration directly (uncached): the type's set dressing, then (C159) its level adornment
 * for o.tier (decorTier of the chamber's level).
 * @param {CanvasRenderingContext2D} g
 * @param {string} type
 * @param {{ x: number, y: number, w: number, h: number }} box cavity interior, px
 * @param {number} u px per cell
 * @param {number} seed chamber uid
 * @param {{ winter?: boolean, qf?: number, qh?: number, grow?: number, key?: string, tier?: number }} [o]
 */
export function paintDecor(g, type, box, u, seed, o = {}) {
  const def = DECOR[type];
  if (!def || !(u > 0) || !(box.w > 0) || !(box.h > 0)) return;
  def.back(g, box, u, decorLayout(type, box.w / u, box.h / u, seed, o), o);
  if (o.tier > 0) paintAdorn(g, type, box, u, adornmentLayout(type, box.w / u, box.h / u, seed, o.tier));
}

/**
 * Draw a chamber's animated decoration layer (a still frame when `still`, i.e. reduced motion).
 * @param {CanvasRenderingContext2D} g
 * @param {string} type
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {number} u
 * @param {number} t seconds
 * @param {number} seed
 * @param {{ still?: boolean, winter?: boolean, qf?: number, qh?: number, grow?: number, key?: string }} [o]
 */
export function drawDecorAnim(g, type, box, u, t, seed, o = {}) {
  const def = DECOR[type];
  if (!def || !def.anim || !(u > 0) || !(box.w > 0) || !(box.h > 0)) return;
  def.anim(g, box, u, decorLayout(type, box.w / u, box.h / u, seed, o), Number.isFinite(t) ? t : 0, !!o.still);
}

/**
 * Per-chamber offscreen cache of the static decorations, rendered at `cpp` device px per cell and blitted scaled.
 * Entries are keyed by uid and rebuilt when the type, footprint, resolution, season flag, level tier (C159) or extra key
 * changes.
 */
export function createDecorCache(max = 96) {
  const map = new Map();
  return {
    /**
     * @param {CanvasRenderingContext2D} ctx target (already clipped to the cavity)
     * @param {{ uid: number, type: string, x: number, y: number, w: number, h: number }} c
     * @param {{ x: number, y: number, w: number, h: number }} box cavity interior, CSS px
     * @param {number} u CSS px per cell
     * @param {number} cpp cache resolution, device px per cell
     */
    draw(ctx, c, box, u, cpp, o = {}) {
      if (!c || !DECOR[c.type] || !(u > 0) || !(cpp > 0)) return false;
      const b = cavityBox(c);
      const bw = b.x1 - b.x0;
      const bh = b.y1 - b.y0;
      if (!(bw > 0) || !(bh > 0)) return false;
      const key = `${c.type}|${c.w}|${c.h}|${cpp}|${o.winter ? 1 : 0}|${o.tier | 0}|${o.key || ''}`;
      let e = map.get(c.uid);
      if (!e || e.key !== key) {
        const ow = Math.max(1, Math.ceil((bw + 2 * PAD) * cpp));
        const oh = Math.max(1, Math.ceil((bh + 2 * PAD) * cpp));
        const off = e && e.off && e.ow === ow && e.oh === oh ? e.off : createOffscreen(ow, oh);
        if (!off || !off.ctx || !off.canvas) return false;
        off.ctx.setTransform(1, 0, 0, 1, 0, 0);
        off.ctx.clearRect(0, 0, ow, oh);
        off.ctx.globalAlpha = 1;
        paintDecor(off.ctx, c.type, { x: PAD * cpp, y: PAD * cpp, w: bw * cpp, h: bh * cpp }, cpp, c.uid, o);
        if (map.size >= max && !map.has(c.uid)) map.clear();
        e = { key, off, ow, oh };
        map.set(c.uid, e);
      }
      const k = u / cpp;
      ctx.drawImage(e.off.canvas, box.x - PAD * u, box.y - PAD * u, e.ow * k, e.oh * k);
      return true;
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

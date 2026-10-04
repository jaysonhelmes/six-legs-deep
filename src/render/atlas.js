// Procedural sprite atlas: ants by kind × 8 rotations × 2 leg frames (optionally carrying an item or tinted for a
// rival), plus static icons for sources, event objects, brood and markers. Everything is painted with canvas paths at
// startup/first use; no image files. Owner: WP8. Contract: ARCHITECTURE §13.1, §13.4 (render/atlas.js).

import { createOffscreen } from './canvas.js';
import { ANT, CARRY, CARRY_CODES, shade, rgba, mix } from './palette.js';
import { KIND_NAMES } from './sprites.js';
import { rotIndex } from './geom.js';

/** Device pixels per sprite unit (one minor-worker cell). */
const UNIT_PX = 40;
/** Rotations per ant strip. */
export const ROTATIONS = 8;
/** Outline thickness of outlined strips, as a fraction of the strip cell (≈ 1 CSS px at the nest's 12 px cells). */
const OUTLINE_FRAC = 0.045;

/** Size scale of each kind relative to a minor (strip cell spans this many units). */
export const KIND_SCALE = Object.freeze({
  minor: 1, soldier: 1.25, supermajor: 1.6, replete: 1.1, alate: 1.3, queen: 2.3, golden: 1, militia: 1, rival: 1, ghost: 1,
});

/** Icon names the atlas can paint. */
export const ICON_NAMES = Object.freeze([
  'crumb_scatter', 'seed_patch', 'flower_patch', 'dead_insect', 'leaf_plant', 'aphid_colony', 'prey_caterpillar',
  'prey_cricket', 'prey_beetle', 'fallen_fruit', 'picnic_spill', 'termite_mound', 'lycaenid_caterpillar',
  'harvester_stash', 'termite_swarm', 'golden_beetle', 'gift', 'ladybug', 'molehill', 'antlion', 'lizard',
  'golden_aphid', 'rival_alate', 'phengaris', 'myrmecophile', 'wandering_queen', 'army_column', 'egg', 'larva', 'pupa',
  'flag', 'fruit', 'footstep', 'unknown',
]);

let ATLAS = null;

/** Kinds the cosmetic ant tint applies to (the player's own ants; C149). */
const TINTABLE = new Set(['minor', 'soldier', 'supermajor', 'replete', 'alate', 'queen', 'militia']);

/**
 * The shared atlas (created lazily on first use; safe to call before any canvas exists).
 * @returns {ReturnType<typeof createAtlas>}
 */
export function getAtlas() {
  if (!ATLAS) ATLAS = createAtlas();
  return ATLAS;
}

/** Drop every cached strip and icon (e.g. after a cosmetic palette change). */
export function resetAtlas() {
  ATLAS = null;
}

/** C149 worker tint of the equipped palette cosmetic (Royal Amber), or null. Part of every strip key. */
let antTint = null;

/**
 * Set the cosmetic ant tint (render/cosmetics.syncAntTint calls it each frame). Player kinds (not rivals, ghosts or the
 * golden beetle ant) are painted mixed toward it; strips are cached per tint, so switching back costs nothing.
 * @param {string|null} color
 */
export function setAntTint(color) {
  antTint = typeof color === 'string' && color ? color : null;
}

/** @returns {string|null} the current cosmetic ant tint */
export function getAntTint() {
  return antTint;
}

function createAtlas() {
  /** @type {Map<string, { canvas: any, cell: number } | null>} */
  const strips = new Map();
  /** @type {Map<string, { canvas: any, px: number } | null>} */
  const icons = new Map();

  function strip(kind, carry, color, outline) {
    const tint = TINTABLE.has(kind) ? antTint : null;
    const key = `${kind}|${carry}|${color || ''}|${outline || ''}|${tint || ''}`;
    if (strips.has(key)) return strips.get(key);
    const k = KIND_SCALE[kind] || 1;
    const cell = Math.round(UNIT_PX * k);
    const off = createOffscreen(cell * ROTATIONS, cell * 2);
    let out = null;
    if (off.ctx && off.canvas) {
      const g = off.ctx;
      // outlined variant: paint each cell on a scratch canvas, stamp its silhouette in the outline colour around it,
      // then the ant on top (keeps dark ants readable on dark tunnels without any per-frame cost)
      const tmp = outline ? createOffscreen(cell, cell) : null;
      const sil = outline ? createOffscreen(cell, cell) : null;
      const useTmp = !!(tmp && tmp.ctx && sil && sil.ctx);
      const o = Math.max(1, Math.round(cell * OUTLINE_FRAC));
      for (let fr = 0; fr < 2; fr++) {
        for (let r = 0; r < ROTATIONS; r++) {
          const pg = useTmp ? tmp.ctx : g;
          if (useTmp) {
            pg.setTransform(1, 0, 0, 1, 0, 0);
            pg.clearRect(0, 0, cell, cell);
          }
          pg.save();
          if (useTmp) pg.translate(cell / 2, cell / 2);
          else pg.translate(r * cell + cell / 2, fr * cell + cell / 2);
          pg.rotate((r * Math.PI * 2) / ROTATIONS);
          pg.scale(UNIT_PX, UNIT_PX);
          paintAnt(pg, kind, carry, fr, color, tint);
          pg.restore();
          if (useTmp) {
            const sg = sil.ctx;
            sg.setTransform(1, 0, 0, 1, 0, 0);
            sg.globalCompositeOperation = 'source-over';
            sg.clearRect(0, 0, cell, cell);
            sg.drawImage(tmp.canvas, 0, 0);
            sg.globalCompositeOperation = 'source-in';
            sg.fillStyle = outline;
            sg.fillRect(0, 0, cell, cell);
            sg.globalCompositeOperation = 'source-over';
            const dx = r * cell;
            const dy = fr * cell;
            for (const [ox, oy] of [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]]) g.drawImage(sil.canvas, dx + ox, dy + oy);
            g.drawImage(tmp.canvas, dx, dy);
          }
        }
      }
      out = { canvas: off.canvas, cell };
    }
    strips.set(key, out);
    return out;
  }

  function icon(name) {
    if (icons.has(name)) return icons.get(name);
    const px = 64;
    const off = createOffscreen(px, px);
    let out = null;
    if (off.ctx && off.canvas) {
      const g = off.ctx;
      g.save();
      g.translate(px / 2, px / 2);
      g.scale(px, px);
      const painter = ICON_PAINTERS[name] || ICON_PAINTERS.unknown;
      try {
        painter(g);
      } catch {
        // a failing painter leaves a blank icon
      }
      g.restore();
      out = { canvas: off.canvas, px };
    }
    icons.set(name, out);
    return out;
  }

  return {
    /**
     * Draw an ant centred at (x, y). `unit` = CSS px of one minor-worker cell; heading `angle` in radians.
     * @param {CanvasRenderingContext2D} ctx
     * @param {string|number} kind kind name or KIND code
     * @param {string|number} carry CARRY key or code
     * @param {number} angle
     * @param {number} frame 0|1
     * @param {number} x
     * @param {number} y
     * @param {number} unit
     * @param {string} [color] rival tint (kind 'rival'); body colour of the queen (golden queen cosmetic, C149)
     * @param {string} [outline] optional silhouette outline colour (Below view: keeps dark ants readable on dark soil)
     */
    drawAnt(ctx, kind, carry, angle, frame, x, y, unit, color, outline) {
      const kn = typeof kind === 'number' ? KIND_NAMES[kind] || 'minor' : kind || 'minor';
      const cn = typeof carry === 'number' ? CARRY_CODES[carry] || 'none' : carry || 'none';
      const st = strip(kn, cn, kn === 'rival' ? color || '#7a2a1a' : kn === 'queen' && color ? color : null, outline || null);
      const k = KIND_SCALE[kn] || 1;
      const size = unit * k;
      if (!st) {
        ctx.fillStyle = (ANT[kn] || ANT.minor).body;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size * 0.18), 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const r = rotIndex(angle, ROTATIONS);
      const f = frame ? 1 : 0;
      ctx.drawImage(st.canvas, r * st.cell, f * st.cell, st.cell, st.cell, x - size / 2, y - size / 2, size, size);
    },
    /**
     * Draw an icon centred at (x, y) with the given CSS size.
     * @param {CanvasRenderingContext2D} ctx
     * @param {string} name
     * @param {number} x
     * @param {number} y
     * @param {number} size
     */
    drawIcon(ctx, name, x, y, size) {
      const ic = icon(name);
      if (!ic) {
        ctx.fillStyle = '#c8b27a';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size * 0.3), 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.drawImage(ic.canvas, 0, 0, ic.px, ic.px, x - size / 2, y - size / 2, size, size);
    },
    /** Pre-build the common strips (optional warm-up). */
    warm() {
      for (const k of ['minor', 'soldier', 'supermajor', 'replete', 'alate', 'golden']) strip(k, 'none', null, null);
      for (const c of ['seed', 'honeydew', 'leaf', 'pellet']) strip('minor', c, null, null);
    },
  };
}

// ----------------------------------------------------------------------------------------------------------------
// Ant painter (unit space: one minor cell = 1, ant faces +x, centred on its waist)
// ----------------------------------------------------------------------------------------------------------------

function ell(g, x, y, rx, ry, rot = 0) {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.001, rx), Math.max(0.001, ry), rot, 0, Math.PI * 2);
}

/**
 * Paint one ant facing +x.
 * @param {CanvasRenderingContext2D} g
 * @param {string} kind
 * @param {string} carry
 * @param {number} frame
 * @param {string|null} color
 */
function paintAnt(g, kind, carry, frame, color, tint = null) {
  let pal = ANT[kind] || ANT.minor;
  if (kind === 'rival' && color) pal = { body: shade(color, -0.45), head: shade(color, -0.55), leg: shade(color, -0.7) };
  else if (kind === 'queen' && color) pal = { ...pal, body: shade(color, -0.15), head: shade(color, -0.25), gaster: color, leg: shade(color, -0.5) };
  if (tint && TINTABLE.has(kind)) {
    pal = { ...pal, body: mix(pal.body, tint, 0.5), head: mix(pal.head, tint, 0.45), gaster: mix(pal.gaster || pal.body, tint, 0.55) };
  }
  const k = KIND_SCALE[kind] || 1;
  g.save();
  g.scale(k, k);
  const headR = kind === 'supermajor' ? 0.105 : kind === 'soldier' ? 0.085 : kind === 'queen' ? 0.06 : 0.062;
  const gasR = kind === 'replete' ? 0.15 : kind === 'queen' ? 0.15 : 0.12;
  const gasX = kind === 'queen' ? -0.2 : kind === 'replete' ? -0.19 : -0.16;
  const rim = kind === 'ghost' ? 'rgba(255,255,255,0.5)' : 'rgba(255,226,190,0.35)';
  const alpha = kind === 'ghost' ? 0.55 : 1;
  g.globalAlpha = alpha;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // legs (tripod gait: frame 0 = L1 R2 L3 forward, frame 1 = R1 L2 R3 forward)
  g.strokeStyle = pal.leg;
  g.lineWidth = kind === 'supermajor' ? 0.026 : 0.02;
  const attach = [0.085, 0.045, 0.005];
  for (let p = 0; p < 3; p++) {
    for (const side of [-1, 1]) {
      const fwd = ((p % 2 === 0) === (side < 0)) === (frame === 0) ? 1 : -1;
      const ax = attach[p];
      const baseAng = [-0.75, -0.05, 0.75][p];
      const swing = 0.28 * fwd;
      const a1 = baseAng - swing;
      const kx = ax + Math.sin(a1) * -0.09 + 0.01;
      const ky = side * (0.06 + Math.cos(a1) * 0.06);
      const fx = kx + Math.sin(a1) * -0.07 + (p === 0 ? 0.04 : p === 2 ? -0.04 : 0);
      const fy = ky + side * 0.07;
      g.beginPath();
      g.moveTo(ax, side * 0.02);
      g.lineTo(kx, ky);
      g.lineTo(fx, fy);
      g.stroke();
    }
  }

  // wings (alates: folded back over the gaster; queen: stubs)
  if (kind === 'alate') {
    g.fillStyle = rgba(pal.wing || '#dceaff', 0.5);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 0.008;
    for (const side of [-1, 1]) {
      ell(g, -0.14, side * 0.07, 0.24, 0.07, side * 0.18);
      g.fill();
      g.stroke();
    }
  } else if (kind === 'queen') {
    g.fillStyle = 'rgba(210,225,245,0.25)';
    for (const side of [-1, 1]) {
      ell(g, -0.02, side * 0.07, 0.07, 0.03, side * 0.5);
      g.fill();
    }
  }

  // gaster
  const gasCol = pal.gaster || pal.body;
  g.fillStyle = gasCol;
  ell(g, gasX, 0, gasR * (kind === 'replete' ? 1 : 1.12), gasR * (kind === 'replete' ? 1 : 0.8));
  g.fill();
  g.strokeStyle = rim;
  g.lineWidth = 0.012;
  g.stroke();
  if (kind === 'replete') {
    g.fillStyle = 'rgba(255,240,190,0.55)';
    ell(g, gasX + 0.04, -0.05, 0.05, 0.035, -0.4);
    g.fill();
    g.strokeStyle = shade(gasCol, -0.25);
    g.lineWidth = 0.008;
    for (const dx of [-0.06, 0, 0.06]) {
      g.beginPath();
      g.arc(gasX + dx, 0, gasR * 0.95, -0.5, 0.5);
      g.stroke();
    }
  } else {
    g.fillStyle = 'rgba(255,235,210,0.18)';
    ell(g, gasX + 0.03, -0.035, gasR * 0.45, gasR * 0.25, -0.3);
    g.fill();
  }
  // petiole node
  g.fillStyle = pal.body;
  ell(g, -0.03, 0, 0.028, 0.026);
  g.fill();
  // mesosoma
  ell(g, 0.045, 0, kind === 'queen' ? 0.1 : 0.075, kind === 'queen' ? 0.055 : 0.042);
  g.fill();
  g.strokeStyle = rim;
  g.lineWidth = 0.01;
  g.stroke();
  // head
  const hx = 0.045 + (kind === 'queen' ? 0.1 : 0.075) + headR * 0.85;
  g.fillStyle = pal.head;
  ell(g, hx, 0, headR, headR * 0.92);
  g.fill();
  g.strokeStyle = rim;
  g.stroke();
  // eyes
  g.fillStyle = 'rgba(0,0,0,0.6)';
  for (const side of [-1, 1]) {
    ell(g, hx + headR * 0.25, side * headR * 0.6, headR * 0.18, headR * 0.14);
    g.fill();
  }
  // mandibles
  g.strokeStyle = shade(pal.head, -0.3);
  g.lineWidth = kind === 'supermajor' || kind === 'soldier' ? 0.022 : 0.014;
  const mand = kind === 'supermajor' ? 0.075 : kind === 'soldier' ? 0.06 : 0.035;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(hx + headR * 0.8, side * headR * 0.35);
    g.quadraticCurveTo(hx + headR + mand, side * headR * 0.45, hx + headR + mand * 0.6, side * 0.004);
    g.stroke();
  }
  // antennae (elbowed)
  g.strokeStyle = pal.leg;
  g.lineWidth = 0.013;
  const wig = frame === 0 ? 0.012 : -0.012;
  for (const side of [-1, 1]) {
    const bx = hx + headR * 0.5;
    const by = side * headR * 0.5;
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx + 0.05, by + side * (0.06 + wig));
    g.lineTo(bx + 0.13, by + side * (0.035 - wig));
    g.stroke();
  }
  // golden sheen
  if (kind === 'golden') {
    g.fillStyle = 'rgba(255,250,200,0.6)';
    ell(g, gasX + 0.02, -0.04, 0.05, 0.02, -0.3);
    g.fill();
  }
  // carried item at the mandibles
  const cc = CARRY[carry];
  if (cc) {
    const ix = hx + headR + 0.06;
    g.lineWidth = 0.01;
    switch (carry) {
      case 'leaf':
        g.fillStyle = cc;
        g.beginPath();
        g.moveTo(ix - 0.02, 0);
        g.quadraticCurveTo(ix - 0.05, -0.2, ix + 0.08, -0.22);
        g.quadraticCurveTo(ix + 0.12, -0.05, ix - 0.02, 0);
        g.fill();
        g.strokeStyle = shade(cc, -0.3);
        g.beginPath();
        g.moveTo(ix - 0.02, 0);
        g.lineTo(ix + 0.07, -0.18);
        g.stroke();
        break;
      case 'honeydew':
        g.fillStyle = cc;
        ell(g, ix, 0, 0.05, 0.05);
        g.fill();
        g.fillStyle = 'rgba(255,245,200,0.7)';
        ell(g, ix - 0.015, -0.018, 0.015, 0.012);
        g.fill();
        break;
      case 'chitin':
        g.fillStyle = cc;
        g.beginPath();
        g.moveTo(ix - 0.03, -0.04);
        g.lineTo(ix + 0.06, -0.02);
        g.lineTo(ix + 0.03, 0.05);
        g.lineTo(ix - 0.04, 0.03);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(160,200,255,0.5)';
        g.stroke();
        break;
      case 'pupa':
        g.fillStyle = cc;
        ell(g, ix + 0.01, 0, 0.07, 0.04);
        g.fill();
        g.strokeStyle = 'rgba(160,140,110,0.6)';
        g.stroke();
        break;
      case 'pellet':
        g.fillStyle = cc;
        ell(g, ix, 0, 0.045, 0.042);
        g.fill();
        g.fillStyle = shade(cc, 0.2);
        ell(g, ix - 0.012, -0.012, 0.015, 0.012);
        g.fill();
        break;
      case 'golden':
        g.fillStyle = cc;
        ell(g, ix, 0, 0.045, 0.04);
        g.fill();
        g.fillStyle = '#fffbe0';
        ell(g, ix - 0.01, -0.012, 0.014, 0.01);
        g.fill();
        break;
      case 'seed':
      default:
        g.fillStyle = cc;
        ell(g, ix, 0, 0.055, 0.035, 0.3);
        g.fill();
        g.strokeStyle = shade(cc, -0.35);
        g.stroke();
        break;
    }
  }
  g.restore();
}

// ----------------------------------------------------------------------------------------------------------------
// Icon painters (unit box −0.5..0.5, facing the viewer from above)
// ----------------------------------------------------------------------------------------------------------------

function shadow(g, rx = 0.32, ry = 0.12, y = 0.3) {
  g.fillStyle = 'rgba(0,0,0,0.22)';
  ell(g, 0, y, rx, ry);
  g.fill();
}

function petals(g, x, y, r, n, col, center) {
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ell(g, x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.75, r * 0.45, a);
    g.fill();
  }
  g.fillStyle = center;
  ell(g, x, y, r * 0.5, r * 0.5);
  g.fill();
}

function bugBody(g, col, x, y, len, wid, rot = 0) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.fillStyle = col;
  ell(g, 0, 0, len, wid);
  g.fill();
  g.restore();
}

const ICON_PAINTERS = {
  unknown(g) {
    g.fillStyle = '#c8b27a';
    ell(g, 0, 0, 0.25, 0.25);
    g.fill();
  },
  crumb_scatter(g) {
    shadow(g, 0.34, 0.1, 0.22);
    const pts = [[-0.2, 0.05, 0.1], [0.08, -0.12, 0.12], [0.18, 0.12, 0.08], [-0.05, 0.18, 0.07], [-0.22, -0.16, 0.06], [0.25, -0.05, 0.05]];
    for (const [x, y, r] of pts) {
      g.fillStyle = '#d9b77a';
      g.beginPath();
      g.moveTo(x - r, y);
      g.lineTo(x - r * 0.3, y - r);
      g.lineTo(x + r, y - r * 0.4);
      g.lineTo(x + r * 0.6, y + r * 0.8);
      g.lineTo(x - r * 0.5, y + r * 0.7);
      g.closePath();
      g.fill();
      g.fillStyle = '#f2dcaa';
      ell(g, x - r * 0.2, y - r * 0.3, r * 0.35, r * 0.25);
      g.fill();
    }
  },
  seed_patch(g) {
    g.fillStyle = 'rgba(70,45,25,0.55)';
    ell(g, 0, 0.05, 0.4, 0.3);
    g.fill();
    g.strokeStyle = '#6fae46';
    g.lineWidth = 0.025;
    for (const [x, h] of [[-0.3, 0.25], [0.32, 0.2], [0.05, 0.28]]) {
      g.beginPath();
      g.moveTo(x, 0.15);
      g.quadraticCurveTo(x + 0.05, 0.15 - h / 2, x + 0.02, 0.15 - h);
      g.stroke();
    }
    const seeds = [[-0.15, 0], [0, -0.08], [0.14, 0.02], [-0.05, 0.12], [0.1, 0.15], [-0.2, 0.16], [0.22, -0.1]];
    for (const [x, y] of seeds) {
      g.fillStyle = '#d6b36c';
      ell(g, x, y, 0.06, 0.04, 0.6);
      g.fill();
      g.fillStyle = '#8a6a36';
      ell(g, x + 0.02, y + 0.01, 0.02, 0.012, 0.6);
      g.fill();
    }
  },
  flower_patch(g) {
    g.strokeStyle = '#4c8a34';
    g.lineWidth = 0.03;
    for (const [x, y] of [[-0.18, -0.1], [0.15, -0.16], [0.02, 0.1]]) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x * 0.6, 0.35);
      g.stroke();
    }
    g.fillStyle = '#5c9c3e';
    ell(g, -0.12, 0.25, 0.1, 0.04, -0.5);
    g.fill();
    ell(g, 0.12, 0.27, 0.1, 0.04, 0.5);
    g.fill();
    petals(g, -0.18, -0.1, 0.08, 5, '#f4a6c8', '#ffd84a');
    petals(g, 0.15, -0.16, 0.07, 5, '#fff4f0', '#f0b030');
    petals(g, 0.02, 0.1, 0.08, 6, '#c9a2f0', '#ffe066');
  },
  dead_insect(g) {
    shadow(g, 0.3, 0.1, 0.22);
    g.strokeStyle = '#3a3a3a';
    g.lineWidth = 0.025;
    for (const s of [-1, 1]) {
      for (const x of [-0.08, 0.02, 0.12]) {
        g.beginPath();
        g.moveTo(x, s * 0.08);
        g.quadraticCurveTo(x + 0.06, s * 0.22, x + 0.12, s * 0.16);
        g.stroke();
      }
    }
    bugBody(g, '#4a4f55', -0.08, 0, 0.18, 0.12);
    bugBody(g, '#5c6168', 0.12, 0, 0.09, 0.08);
    g.fillStyle = 'rgba(220,230,240,0.35)';
    ell(g, -0.1, -0.04, 0.12, 0.04, -0.2);
    g.fill();
  },
  leaf_plant(g) {
    shadow(g, 0.3, 0.1, 0.32);
    const leaves = [[0, -0.22, -1.57], [-0.2, -0.05, -2.6], [0.2, -0.05, -0.55], [-0.12, 0.15, 2.4], [0.13, 0.16, 0.75]];
    for (const [x, y, a] of leaves) {
      g.save();
      g.translate(x * 0.4, y * 0.4);
      g.rotate(a);
      g.fillStyle = '#3f9a3a';
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(0.18, -0.12, 0.36, 0);
      g.quadraticCurveTo(0.18, 0.12, 0, 0);
      g.fill();
      g.strokeStyle = '#2c6f2a';
      g.lineWidth = 0.015;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0.34, 0);
      g.stroke();
      g.restore();
    }
    g.fillStyle = '#6a4a2a';
    ell(g, 0, 0, 0.05, 0.05);
    g.fill();
  },
  aphid_colony(g) {
    g.strokeStyle = '#6b8a3a';
    g.lineWidth = 0.06;
    g.beginPath();
    g.moveTo(-0.35, 0.3);
    g.quadraticCurveTo(0, 0.05, 0.35, -0.3);
    g.stroke();
    const pts = [[-0.2, 0.12], [-0.08, 0.06], [0.05, -0.02], [0.16, -0.1], [-0.12, 0.2], [0.08, 0.08], [0.24, -0.2]];
    for (const [x, y] of pts) {
      g.fillStyle = '#9fd25a';
      ell(g, x, y, 0.05, 0.035, -0.6);
      g.fill();
      g.fillStyle = '#d9f5a0';
      ell(g, x - 0.012, y - 0.012, 0.015, 0.01);
      g.fill();
    }
  },
  prey_caterpillar(g) {
    shadow(g, 0.33, 0.08, 0.2);
    for (let i = 0; i < 7; i++) {
      const x = -0.3 + i * 0.09;
      const y = Math.sin(i * 0.9) * 0.06;
      g.fillStyle = i % 2 ? '#78c04a' : '#8fd45a';
      ell(g, x, y, 0.075, 0.075);
      g.fill();
    }
    g.fillStyle = '#3d6a24';
    ell(g, 0.32, Math.sin(6.3) * 0.06, 0.07, 0.07);
    g.fill();
    g.fillStyle = '#ffe066';
    for (let i = 0; i < 6; i++) {
      ell(g, -0.3 + i * 0.09, Math.sin(i * 0.9) * 0.06 - 0.03, 0.015, 0.015);
      g.fill();
    }
  },
  prey_cricket(g) {
    shadow(g, 0.32, 0.08, 0.22);
    g.strokeStyle = '#5a3d1e';
    g.lineWidth = 0.03;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(-0.05, s * 0.05);
      g.lineTo(-0.15, s * 0.22);
      g.lineTo(-0.38, s * 0.12);
      g.stroke();
      g.beginPath();
      g.moveTo(0.15, s * 0.04);
      g.quadraticCurveTo(0.35, s * 0.2, 0.45, s * 0.3);
      g.lineWidth = 0.012;
      g.stroke();
      g.lineWidth = 0.03;
    }
    bugBody(g, '#7a5228', -0.06, 0, 0.22, 0.09);
    bugBody(g, '#5e3d1d', 0.16, 0, 0.07, 0.07);
  },
  prey_beetle(g) {
    shadow(g, 0.33, 0.1, 0.25);
    g.strokeStyle = '#1e2a1e';
    g.lineWidth = 0.03;
    for (const s of [-1, 1]) {
      for (const x of [-0.1, 0.02, 0.14]) {
        g.beginPath();
        g.moveTo(x, s * 0.1);
        g.lineTo(x + 0.04, s * 0.26);
        g.stroke();
      }
    }
    bugBody(g, '#24452e', -0.04, 0, 0.24, 0.17);
    g.fillStyle = '#1b3322';
    ell(g, 0.24, 0, 0.08, 0.08);
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 0.012;
    g.beginPath();
    g.moveTo(0.18, 0);
    g.lineTo(-0.27, 0);
    g.stroke();
    g.fillStyle = 'rgba(180,255,210,0.35)';
    ell(g, -0.08, -0.08, 0.12, 0.04, -0.15);
    g.fill();
  },
  fallen_fruit(g) {
    shadow(g, 0.3, 0.1, 0.3);
    g.fillStyle = '#d6322e';
    ell(g, -0.07, 0.02, 0.24, 0.26);
    g.fill();
    ell(g, 0.08, 0.02, 0.24, 0.26);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    ell(g, -0.1, -0.1, 0.07, 0.1, -0.4);
    g.fill();
    g.strokeStyle = '#5a3b1e';
    g.lineWidth = 0.03;
    g.beginPath();
    g.moveTo(0, -0.2);
    g.lineTo(0.03, -0.32);
    g.stroke();
    g.fillStyle = '#4c9a3a';
    ell(g, 0.12, -0.3, 0.1, 0.04, -0.4);
    g.fill();
  },
  fruit(g) {
    ICON_PAINTERS.fallen_fruit(g);
  },
  picnic_spill(g) {
    g.save();
    g.rotate(-0.2);
    const n = 4;
    const s = 0.8 / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        g.fillStyle = (i + j) % 2 ? '#e8e2d8' : '#d94a42';
        g.fillRect(-0.4 + i * s, -0.4 + j * s, s, s);
      }
    }
    g.restore();
    for (const [x, y] of [[0.1, 0.05], [-0.12, -0.08], [0.02, -0.15], [-0.05, 0.14]]) {
      g.fillStyle = '#e0b56e';
      ell(g, x, y, 0.06, 0.045, 0.4);
      g.fill();
    }
  },
  termite_mound(g) {
    shadow(g, 0.34, 0.1, 0.36);
    g.fillStyle = '#b07a4a';
    g.beginPath();
    g.moveTo(-0.32, 0.36);
    g.quadraticCurveTo(-0.22, -0.1, -0.12, -0.2);
    g.lineTo(-0.06, -0.44);
    g.lineTo(0.02, -0.25);
    g.lineTo(0.1, -0.36);
    g.quadraticCurveTo(0.22, 0.0, 0.32, 0.36);
    g.closePath();
    g.fill();
    g.fillStyle = '#8a5a32';
    for (const [x, y] of [[-0.1, 0.1], [0.08, 0.0], [-0.02, -0.15], [0.14, 0.2]]) {
      ell(g, x, y, 0.035, 0.05);
      g.fill();
    }
    g.fillStyle = 'rgba(255,230,200,0.25)';
    ell(g, -0.12, 0.0, 0.05, 0.2, 0.15);
    g.fill();
  },
  lycaenid_caterpillar(g) {
    shadow(g, 0.3, 0.08, 0.18);
    g.fillStyle = '#9fd0c8';
    ell(g, 0, 0, 0.3, 0.13);
    g.fill();
    g.strokeStyle = 'rgba(60,110,110,0.6)';
    g.lineWidth = 0.012;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * 0.1, -0.12);
      g.lineTo(i * 0.1, 0.12);
      g.stroke();
    }
    g.fillStyle = '#6aa8a0';
    ell(g, 0.26, 0, 0.06, 0.06);
    g.fill();
    g.fillStyle = '#ffe08a';
    ell(g, -0.05, -0.02, 0.03, 0.03);
    g.fill();
  },
  harvester_stash(g) {
    ICON_PAINTERS.seed_patch(g);
    g.strokeStyle = '#3a2a1a';
    g.lineWidth = 0.025;
    g.beginPath();
    g.moveTo(0.22, 0.2);
    g.lineTo(0.22, -0.35);
    g.stroke();
    g.fillStyle = '#f2b134';
    g.beginPath();
    g.moveTo(0.22, -0.35);
    g.lineTo(0.42, -0.27);
    g.lineTo(0.22, -0.19);
    g.closePath();
    g.fill();
  },
  termite_swarm(g) {
    for (const [x, y, a] of [[-0.18, -0.12, 0.3], [0.12, -0.2, -0.4], [0.05, 0.1, 0.8], [-0.1, 0.2, -0.2], [0.25, 0.12, 0.1]]) {
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.fillStyle = 'rgba(230,240,255,0.55)';
      ell(g, -0.06, -0.035, 0.12, 0.03, 0.2);
      g.fill();
      ell(g, -0.06, 0.035, 0.12, 0.03, -0.2);
      g.fill();
      g.fillStyle = '#e8d2a6';
      ell(g, 0, 0, 0.07, 0.025);
      g.fill();
      g.fillStyle = '#9a6a3a';
      ell(g, 0.07, 0, 0.025, 0.025);
      g.fill();
      g.restore();
    }
  },
  golden_beetle(g) {
    g.fillStyle = 'rgba(255,220,80,0.25)';
    ell(g, 0, 0, 0.45, 0.45);
    g.fill();
    g.strokeStyle = '#8a6410';
    g.lineWidth = 0.03;
    for (const s of [-1, 1]) {
      for (const y of [-0.1, 0.02, 0.14]) {
        g.beginPath();
        g.moveTo(s * 0.1, y);
        g.lineTo(s * 0.27, y + 0.05);
        g.stroke();
      }
    }
    g.fillStyle = '#e8b923';
    ell(g, 0, 0.04, 0.17, 0.22);
    g.fill();
    g.fillStyle = '#c99a12';
    ell(g, 0, -0.2, 0.09, 0.07);
    g.fill();
    g.strokeStyle = '#8a6410';
    g.lineWidth = 0.012;
    g.beginPath();
    g.moveTo(0, -0.14);
    g.lineTo(0, 0.25);
    g.stroke();
    g.fillStyle = '#fff6c2';
    ell(g, -0.06, -0.04, 0.04, 0.08, 0.2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.moveTo(0.28, -0.3);
    g.lineTo(0.31, -0.22);
    g.lineTo(0.39, -0.19);
    g.lineTo(0.31, -0.16);
    g.lineTo(0.28, -0.08);
    g.lineTo(0.25, -0.16);
    g.lineTo(0.17, -0.19);
    g.lineTo(0.25, -0.22);
    g.closePath();
    g.fill();
  },
  gift(g) {
    shadow(g, 0.3, 0.08, 0.32);
    g.fillStyle = '#e85d75';
    g.fillRect(-0.25, -0.12, 0.5, 0.4);
    g.fillStyle = '#d0465e';
    g.fillRect(-0.28, -0.22, 0.56, 0.12);
    g.fillStyle = '#ffe08a';
    g.fillRect(-0.04, -0.22, 0.08, 0.5);
    g.beginPath();
    g.ellipse(-0.08, -0.27, 0.08, 0.05, -0.5, 0, Math.PI * 2);
    g.ellipse(0.08, -0.27, 0.08, 0.05, 0.5, 0, Math.PI * 2);
    g.fill();
  },
  ladybug(g) {
    shadow(g, 0.24, 0.08, 0.22);
    g.fillStyle = '#1a1a1a';
    ell(g, 0.18, 0, 0.09, 0.09);
    g.fill();
    g.fillStyle = '#e0302a';
    ell(g, -0.03, 0, 0.22, 0.19);
    g.fill();
    g.strokeStyle = '#1a1a1a';
    g.lineWidth = 0.02;
    g.beginPath();
    g.moveTo(0.18, 0);
    g.lineTo(-0.25, 0);
    g.stroke();
    g.fillStyle = '#1a1a1a';
    for (const [x, y] of [[-0.1, -0.09], [-0.12, 0.09], [0.05, -0.1], [0.05, 0.1], [-0.2, 0]]) {
      ell(g, x, y, 0.035, 0.035);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.4)';
    ell(g, 0.0, -0.08, 0.05, 0.02);
    g.fill();
  },
  molehill(g) {
    g.fillStyle = '#5a3a20';
    g.beginPath();
    g.moveTo(-0.4, 0.3);
    g.quadraticCurveTo(-0.15, -0.35, 0.05, -0.3);
    g.quadraticCurveTo(0.3, -0.2, 0.4, 0.3);
    g.closePath();
    g.fill();
    g.fillStyle = '#7a5232';
    for (const [x, y] of [[-0.15, 0.0], [0.05, -0.12], [0.15, 0.12], [-0.05, 0.18]]) {
      ell(g, x, y, 0.06, 0.04);
      g.fill();
    }
  },
  antlion(g) {
    for (let i = 4; i >= 1; i--) {
      g.fillStyle = mix('#e0c88a', '#8a6a3a', 1 - i / 4);
      ell(g, 0, 0, 0.1 * i, 0.08 * i);
      g.fill();
    }
    g.strokeStyle = '#3a2a14';
    g.lineWidth = 0.03;
    g.beginPath();
    g.moveTo(-0.06, 0);
    g.quadraticCurveTo(-0.04, -0.08, 0.03, -0.06);
    g.moveTo(0.06, 0);
    g.quadraticCurveTo(0.04, 0.08, -0.03, 0.06);
    g.stroke();
  },
  lizard(g) {
    shadow(g, 0.35, 0.1, 0.25);
    g.fillStyle = '#b8945a';
    ell(g, 0, 0, 0.22, 0.15);
    g.fill();
    g.beginPath();
    g.moveTo(-0.2, 0);
    g.quadraticCurveTo(-0.38, 0.05, -0.46, 0.2);
    g.lineTo(-0.42, 0.21);
    g.quadraticCurveTo(-0.34, 0.08, -0.18, 0.05);
    g.fill();
    ell(g, 0.25, 0, 0.1, 0.09);
    g.fill();
    g.fillStyle = '#8a6a3a';
    for (const [x, y] of [[0.3, -0.09], [0.34, 0.08], [0.22, -0.1], [-0.05, -0.12], [0.05, 0.12], [-0.12, 0.1]]) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 0.03, y + (y < 0 ? -0.05 : 0.05));
      g.lineTo(x + 0.06, y);
      g.fill();
    }
    g.strokeStyle = '#8a6a3a';
    g.lineWidth = 0.03;
    for (const [x, s] of [[0.1, -1], [0.1, 1], [-0.12, -1], [-0.12, 1]]) {
      g.beginPath();
      g.moveTo(x, s * 0.1);
      g.lineTo(x + 0.06, s * 0.24);
      g.stroke();
    }
  },
  golden_aphid(g) {
    g.fillStyle = 'rgba(255,220,80,0.3)';
    ell(g, 0, 0, 0.4, 0.4);
    g.fill();
    g.fillStyle = '#f2c230';
    ell(g, 0, 0.02, 0.18, 0.14, -0.4);
    g.fill();
    g.fillStyle = '#fff3b0';
    ell(g, -0.05, -0.04, 0.06, 0.035, -0.4);
    g.fill();
  },
  rival_alate(g) {
    g.fillStyle = 'rgba(230,240,255,0.55)';
    ell(g, -0.06, -0.12, 0.22, 0.07, 0.3);
    g.fill();
    ell(g, -0.06, 0.12, 0.22, 0.07, -0.3);
    g.fill();
    bugBody(g, '#7a2a1a', -0.08, 0, 0.12, 0.07);
    bugBody(g, '#6a2414', 0.06, 0, 0.06, 0.04);
    bugBody(g, '#5a1e10', 0.16, 0, 0.05, 0.045);
  },
  phengaris(g) {
    shadow(g, 0.3, 0.08, 0.18);
    g.fillStyle = '#d8a8b8';
    ell(g, 0, 0, 0.28, 0.12);
    g.fill();
    g.strokeStyle = 'rgba(140,90,110,0.6)';
    g.lineWidth = 0.012;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * 0.1, -0.11);
      g.lineTo(i * 0.1, 0.11);
      g.stroke();
    }
    g.fillStyle = '#5a6ac8';
    ell(g, 0.27, 0, 0.05, 0.05);
    g.fill();
  },
  myrmecophile(g) {
    shadow(g, 0.3, 0.08, 0.2);
    bugBody(g, '#3a2a22', -0.08, 0, 0.2, 0.07);
    bugBody(g, '#5a3a2a', 0.08, 0, 0.08, 0.075);
    bugBody(g, '#2a1a12', 0.2, 0, 0.06, 0.055);
    g.strokeStyle = '#2a1a12';
    g.lineWidth = 0.02;
    g.beginPath();
    g.moveTo(-0.26, 0);
    g.quadraticCurveTo(-0.34, -0.1, -0.28, -0.18);
    g.stroke();
  },
  wandering_queen(g) {
    g.fillStyle = 'rgba(255,230,150,0.3)';
    ell(g, 0, 0, 0.42, 0.42);
    g.fill();
    g.fillStyle = 'rgba(220,235,255,0.5)';
    ell(g, -0.1, -0.12, 0.2, 0.06, 0.25);
    g.fill();
    ell(g, -0.1, 0.12, 0.2, 0.06, -0.25);
    g.fill();
    bugBody(g, '#3a2216', -0.12, 0, 0.16, 0.1);
    bugBody(g, '#2a1810', 0.06, 0, 0.08, 0.06);
    bugBody(g, '#21130b', 0.2, 0, 0.06, 0.055);
    g.fillStyle = '#ffd447';
    g.beginPath();
    g.moveTo(0.14, -0.1);
    g.lineTo(0.18, -0.18);
    g.lineTo(0.2, -0.11);
    g.lineTo(0.23, -0.18);
    g.lineTo(0.26, -0.1);
    g.closePath();
    g.fill();
  },
  army_column(g) {
    for (let i = 0; i < 9; i++) {
      const x = -0.36 + i * 0.09;
      const y = Math.sin(i * 1.3) * 0.12;
      bugBody(g, '#2a1a12', x, y, 0.05, 0.025, 0.3);
    }
  },
  egg(g) {
    g.fillStyle = '#fbf6ea';
    ell(g, 0, 0, 0.16, 0.22);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    ell(g, -0.05, -0.07, 0.04, 0.06);
    g.fill();
  },
  larva(g) {
    g.strokeStyle = '#f3ead4';
    g.lineWidth = 0.18;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, 0, 0.16, 0.6, Math.PI * 1.85);
    g.stroke();
    g.fillStyle = '#d8b88a';
    ell(g, 0.12, -0.1, 0.05, 0.05);
    g.fill();
  },
  pupa(g) {
    g.fillStyle = '#e9dcc0';
    ell(g, 0, 0, 0.16, 0.28);
    g.fill();
    g.strokeStyle = 'rgba(150,120,80,0.5)';
    g.lineWidth = 0.02;
    for (const y of [-0.12, 0, 0.12]) {
      g.beginPath();
      g.moveTo(-0.14, y);
      g.lineTo(0.14, y);
      g.stroke();
    }
  },
  flag(g) {
    g.strokeStyle = '#3a2a1a';
    g.lineWidth = 0.05;
    g.beginPath();
    g.moveTo(-0.1, 0.4);
    g.lineTo(-0.1, -0.38);
    g.stroke();
    g.fillStyle = '#ff7a3d';
    g.beginPath();
    g.moveTo(-0.1, -0.38);
    g.lineTo(0.32, -0.24);
    g.lineTo(-0.1, -0.1);
    g.closePath();
    g.fill();
  },
  footstep(g) {
    g.fillStyle = 'rgba(0,0,0,0.5)';
    ell(g, 0, 0.08, 0.2, 0.36, 0.1);
    g.fill();
    ell(g, 0.02, -0.33, 0.14, 0.12, 0.1);
    g.fill();
  },
};

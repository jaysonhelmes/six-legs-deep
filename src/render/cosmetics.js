// Cosmetic rendering (C149): what each equipped cosmetic draws. The renderers call these small helpers (queen crown /
// golden queen in the nest, snow cap, flag and ladybug pet on the surface mound, trail colours, the amber ant tint), and
// Settings draws a preview of each cosmetic with drawCosmeticPreview. Owner: WP8. Contract: ARCHITECTURE §18 C149.
// Equipped ids are looked up by slot through data/cosmetics.js, so older saves whose ids sit under another slot key
// (e.g. equipped.misc = 'cos_royal_amber' from before C149) still render.

import { COSMETICS } from '../data/cosmetics.js';
import { getAtlas, setAntTint } from './atlas.js';
import { nowMs } from './canvas.js';

/** Render variants each slot knows how to draw (the test checks every cosmetic maps to one of these). */
export const RENDER_VARIANTS = Object.freeze({
  crown: Object.freeze(['crown', 'golden_queen']),
  palette: Object.freeze(['royal_amber']),
  mound: Object.freeze(['snowcap']),
  flag: Object.freeze(['white_flag']),
  trail: Object.freeze(['gold', 'picasso']),
  pet: Object.freeze(['ladybug']),
  cursor: Object.freeze(['winged']),
  title: Object.freeze(['underdog']),
  frame: Object.freeze(['amber']),
});

/** Gold of the golden queen's body. */
export const GOLDEN_QUEEN = '#f0be3a';

/**
 * The equipped cosmetic def of a slot, or null. equipped[slot] wins when it holds a cosmetic of that slot; otherwise any
 * equipped id whose slot matches (legacy keys) is used.
 * @param {Object} s
 * @param {string} slot
 * @returns {Object|null}
 */
export function equippedCosmetic(s, slot) {
  const c = s && s.meta && s.meta.cosmetics;
  const eq = c && c.equipped;
  if (!eq || typeof eq !== 'object') return null;
  const owned = c.owned && typeof c.owned === 'object' ? c.owned : null;
  const ok = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(COSMETICS, id) && COSMETICS[id].slot === slot
    && (!owned || owned[id] === true);
  if (ok(eq[slot])) return COSMETICS[eq[slot]];
  for (const k of Object.keys(eq)) if (ok(eq[k])) return COSMETICS[eq[k]];
  return null;
}

/**
 * Variant string of a slot ('' when nothing is equipped).
 * @param {Object} s
 * @param {string} slot
 * @returns {string}
 */
export function equippedVariant(s, slot) {
  const def = equippedCosmetic(s, slot);
  return def ? def.variant : '';
}

/** Body colour of the queen sprite (golden queen) or null. */
export function queenTint(s) {
  return equippedVariant(s, 'crown') === 'golden_queen' ? GOLDEN_QUEEN : null;
}

/** Worker tint of the equipped palette (Royal Amber) or null. */
export function antTint(s) {
  const def = equippedCosmetic(s, 'palette');
  return def && def.tint ? def.tint : null;
}

/** Push the palette's ant tint into the shared atlas (cheap when unchanged; called once per frame by the renderers). */
export function syncAntTint(s) {
  setAntTint(antTint(s));
}

/**
 * Trail stroke colour: the equipped trail cosmetic's colour (Picasso: one colour per trail index), else `base`.
 * @param {Object} s
 * @param {number} index trail index
 * @param {string} base
 * @returns {string}
 */
export function trailColour(s, index, base) {
  const def = equippedCosmetic(s, 'trail');
  if (!def) return base;
  if (def.variant === 'picasso' && Array.isArray(def.colors) && def.colors.length) return def.colors[Math.abs(index | 0) % def.colors.length];
  return def.color || base;
}

/** Five-point crown centred at (cx, cy) with half-width w. */
function crownPath(ctx, cx, cy, w) {
  ctx.beginPath();
  ctx.moveTo(cx - w, cy + w * 0.45);
  ctx.lineTo(cx - w * 0.85, cy - w * 0.55);
  ctx.lineTo(cx - w * 0.4, cy - w * 0.05);
  ctx.lineTo(cx, cy - w * 0.8);
  ctx.lineTo(cx + w * 0.4, cy - w * 0.05);
  ctx.lineTo(cx + w * 0.85, cy - w * 0.55);
  ctx.lineTo(cx + w, cy + w * 0.45);
  ctx.closePath();
}

/**
 * Draw a crown (with jewels for the golden queen) at (cx, cy), w = half-width in CSS px.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {boolean} jewelled
 */
export function drawCrown(ctx, cx, cy, w, jewelled) {
  ctx.save();
  crownPath(ctx, cx, cy, w);
  ctx.fillStyle = '#ffd447';
  ctx.fill();
  ctx.lineWidth = Math.max(1, w * 0.12);
  ctx.strokeStyle = '#7a5410';
  ctx.stroke();
  if (jewelled) {
    const jw = Math.max(1, w * 0.16);
    for (const [dx, col] of [[-0.55, '#e0405a'], [0, '#3fb4e8'], [0.55, '#e0405a']]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(cx + dx * w, cy + w * 0.15, jw, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Nest view: the queen's crown cosmetic (crown, or golden queen: glow + jewelled crown). Call after the queen sprite.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} s
 * @param {number} x queen centre
 * @param {number} y
 * @param {number} size queen sprite scale (unit × grow)
 * @param {number} [time] seconds (sparkle phase)
 */
export function drawQueenCosmetic(ctx, s, x, y, size, time = nowMs() / 1000) {
  const v = equippedVariant(s, 'crown');
  if (!v) return;
  const golden = v === 'golden_queen';
  if (golden) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, size * 0.1, x, y, size * 1.4);
    g.addColorStop(0, 'rgba(255,214,90,0.32)');
    g.addColorStop(1, 'rgba(255,214,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, size * 1.4, 0, Math.PI * 2);
    ctx.fill();
    for (let k = 0; k < 4; k++) {
      const a = time * 0.9 + k * (Math.PI / 2);
      const r = size * (0.9 + 0.15 * Math.sin(time * 2 + k));
      const tw = 0.5 + 0.5 * Math.sin(time * 4 + k * 1.7);
      ctx.fillStyle = `rgba(255,240,170,${0.35 + 0.5 * tw})`;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.6, Math.max(1, size * 0.05 * (0.6 + tw)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  drawCrown(ctx, x + size * 0.55, y - size * 0.42, Math.max(3, size * (golden ? 0.24 : 0.2)), golden);
}

/**
 * Surface view: the mound cosmetics (snow cap, white flag, ladybug pet) on the main mound at p with radius r / height h.
 * Also syncs the ant tint (drawMound runs every frame before the ants are drawn).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} s
 * @param {{ x: number, y: number }} p
 * @param {number} r mound radius (CSS px)
 * @param {number} h mound height (CSS px)
 * @param {number} [time] seconds
 */
export function drawMoundCosmetics(ctx, s, p, r, h, time = nowMs() / 1000) {
  syncAntTint(s);
  if (equippedVariant(s, 'mound') === 'snowcap') {
    ctx.save();
    ctx.fillStyle = 'rgba(248,252,255,0.92)';
    ctx.beginPath();
    ctx.ellipse(p.x - r * 0.08, p.y - r * 0.18, r * 0.72, r * 0.5, 0, Math.PI * 0.95, Math.PI * 2.05);
    // scalloped melt line along the bottom of the cap
    const n = 6;
    for (let k = n; k >= 0; k--) {
      const t = k / n;
      const x = p.x - r * 0.08 + (t * 2 - 1) * r * 0.72;
      const y = p.y - r * 0.18 + r * (0.08 + 0.08 * Math.sin(t * Math.PI * 3));
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(190,220,245,0.55)';
    ctx.beginPath();
    ctx.ellipse(p.x + r * 0.15, p.y - r * 0.3, r * 0.22, r * 0.1, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // the entrance stays dark on top of the snow
    ctx.fillStyle = '#1e120a';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - h * 0.15, r * 0.24, r * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (equippedVariant(s, 'flag') === 'white_flag') {
    const px = p.x + r * 0.55;
    const top = p.y - r * 1.25;
    ctx.save();
    ctx.strokeStyle = '#3a2a1a';
    ctx.lineWidth = Math.max(1.5, r * 0.06);
    ctx.beginPath();
    ctx.moveTo(px, p.y - r * 0.1);
    ctx.lineTo(px, top);
    ctx.stroke();
    const wave = Math.sin(time * 3) * r * 0.06;
    ctx.fillStyle = '#fbfaf4';
    ctx.strokeStyle = 'rgba(60,50,40,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.quadraticCurveTo(px + r * 0.35, top - r * 0.06 + wave, px + r * 0.7, top + r * 0.04);
    ctx.lineTo(px + r * 0.7, top + r * 0.42);
    ctx.quadraticCurveTo(px + r * 0.35, top + r * 0.32 - wave, px, top + r * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  if (equippedVariant(s, 'pet') === 'ladybug') {
    const a = time * 0.45;
    const rr = r * 1.55;
    const x = p.x + Math.cos(a) * rr;
    const y = p.y + Math.sin(a) * rr * 0.7;
    const size = Math.max(8, r * 0.55);
    try {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a + Math.PI);  // facing along its walk
      getAtlas().drawIcon(ctx, 'ladybug', 0, 0, size);
      ctx.restore();
    } catch {
      ctx.restore();
    }
  }
}

/**
 * Draw a small preview of a cosmetic (Settings → Cosmetics) on a canvas. Returns false when the canvas has no 2D context.
 * @param {HTMLCanvasElement} canvas
 * @param {string} id cosmetic id
 * @returns {boolean}
 */
export function drawCosmeticPreview(canvas, id) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  const def = COSMETICS[id];
  if (!ctx || !def) return false;
  const W = canvas.width || 64;
  const H = canvas.height || 40;
  ctx.clearRect(0, 0, W, H);
  const fake = { meta: { cosmetics: { owned: { [id]: true }, equipped: { [def.slot]: id } } } };
  const bg = (c) => { ctx.fillStyle = c; ctx.fillRect(0, 0, W, H); };
  try {
    switch (def.slot) {
      case 'crown': {
        bg('#2a1c11');
        const unit = H * 0.42;
        getAtlas().drawAnt(ctx, 'queen', 'none', 0, 0, W * 0.45, H * 0.58, unit, queenTint(fake));
        drawQueenCosmetic(ctx, fake, W * 0.45, H * 0.58, unit, 0.6);
        break;
      }
      case 'palette': {
        bg('#2b1a0e');
        setAntTint(def.tint);
        getAtlas().drawAnt(ctx, 'minor', 'none', 0, 0, W * 0.3, H * 0.55, H * 0.7);
        getAtlas().drawAnt(ctx, 'minor', 'seed', 0.4, 1, W * 0.68, H * 0.5, H * 0.7);
        setAntTint(null);
        ctx.fillStyle = '#ff9f1c';
        ctx.fillRect(0, H - 4, W, 4);
        break;
      }
      case 'mound': case 'flag': case 'pet': {
        bg('#26341c');
        const p = { x: W * 0.42, y: H * 0.68 };
        const r = H * 0.34;
        ctx.fillStyle = '#7a5532';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1e120a';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - r * 0.06, r * 0.24, r * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        drawMoundCosmetics(ctx, fake, p, r, r * 0.4, 1.2);
        setAntTint(null);
        break;
      }
      case 'trail': {
        bg('#26341c');
        const cols = def.variant === 'picasso' ? [0, 1, 2] : [0];
        cols.forEach((k, i) => {
          ctx.strokeStyle = trailColour(fake, k, '#e6c27a');
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          const y0 = H * (0.3 + 0.2 * i) + (cols.length === 1 ? H * 0.2 : 0);
          ctx.moveTo(4, y0);
          ctx.quadraticCurveTo(W * 0.5, y0 - H * 0.25, W - 4, y0 + H * 0.05);
          ctx.stroke();
        });
        break;
      }
      case 'cursor': {
        bg('#26341c');
        ctx.fillStyle = '#2a1806';
        ctx.strokeStyle = '#f2c76c';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = '#eef5ff';
        ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.35, W * 0.16, H * 0.14, -0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(W * 0.34, H * 0.52, W * 0.13, H * 0.12, 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2a1806';
        ctx.beginPath();
        ctx.moveTo(W * 0.3, H * 0.15); ctx.lineTo(W * 0.3, H * 0.8); ctx.lineTo(W * 0.42, H * 0.65); ctx.lineTo(W * 0.5, H * 0.88);
        ctx.lineTo(W * 0.56, H * 0.84); ctx.lineTo(W * 0.48, H * 0.62); ctx.lineTo(W * 0.62, H * 0.62); ctx.closePath();
        ctx.fill(); ctx.stroke();
        break;
      }
      case 'title': {
        bg('#241a12');
        ctx.fillStyle = '#f2c76c';
        ctx.font = 'italic ' + Math.round(H * 0.32) + 'px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(def.title || def.name, W / 2, H / 2);
        break;
      }
      case 'frame': {
        bg('#2a1c11');
        ctx.strokeStyle = '#d89a2b';
        ctx.lineWidth = 4;
        ctx.strokeRect(3, 3, W - 6, H - 6);
        ctx.strokeStyle = '#ffd27a';
        ctx.lineWidth = 1;
        ctx.strokeRect(6, 6, W - 12, H - 12);
        break;
      }
      default: return false;
    }
  } catch {
    return false;
  }
  return true;
}

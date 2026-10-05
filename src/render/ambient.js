// Above-view ambient life (C161): purely visual idle animation for map objects, drawn per frame for the visible
// sources / event objects only (the terrain cache stays static). Plants (seed, flower and leaf patches, aphid stems)
// sway in a wind field that travels across the map (stronger in autumn and in rain, almost still in deep winter);
// live prey crawls a little and twitches its antennae; caterpillars inch (a body wave); a fly buzzes over a dead
// insect; termites mill round their mound and alates flutter over a swarm; a molehill now and then puffs soil.
// Every object has a deterministic phase from its uid, so nothing moves in lockstep; no game state is read or
// written beyond the object's type and uid. Callers skip all of it under reduced motion. Owner: WP8.
// Contract: ARCHITECTURE §13.5 (C161).

import { hash01 } from './geom.js';

/** How each source / object type moves. */
export const AMBIENT_KIND = Object.freeze({
  seed_patch: 'sway', flower_patch: 'sway', leaf_plant: 'sway', aphid_colony: 'sway',
  prey_beetle: 'crawl', prey_cricket: 'crawl', myrmecophile: 'crawl',
  prey_caterpillar: 'inch', lycaenid_caterpillar: 'inch', phengaris: 'inch',
  dead_insect: 'fly',
  termite_mound: 'termites', termite_swarm: 'swarm',
  molehill: 'puff',
});

/** Sway amplitude (horizontal skew of the plant's top per unit of wind) per plant type. */
const SWAY_AMP = Object.freeze({ flower_patch: 0.16, leaf_plant: 0.11, seed_patch: 0.09, aphid_colony: 0.06 });

/**
 * Deterministic phase in [0, 1) for an object uid (and a salt).
 * @param {number} uid
 * @param {number} [salt]
 * @returns {number}
 */
export function ambientPhase(uid, salt = 0) {
  return hash01((Number(uid) | 0) + 7, 9173 + salt);
}

/**
 * Wind in about [−1, 1] at a world point: a slow wave rolling across the map in +x with a faster flutter on top and a
 * gust envelope, so neighbouring plants lean together and the lean travels.
 * @param {number} x world px
 * @param {number} y world px
 * @param {number} t seconds
 * @returns {number}
 */
export function windAt(x, y, t) {
  const gust = 0.65 + 0.35 * Math.sin(t * 0.23 - x * 0.0021 + 1.3);
  const wave = 0.68 * Math.sin(t * 1.15 - x * 0.0062 - y * 0.0021) + 0.32 * Math.sin(t * 2.7 - x * 0.017 + y * 0.0093);
  return gust * wave;
}

/**
 * Wind strength multiplier from the weather this frame: 1 normally, up to 1.8 in a rainstorm, up to 1.6 at the
 * height of autumn (falling leaves), down to 0.1 in deep winter (full snow).
 * @param {{ rain?: number, snow?: number, leaves?: number }} w
 * @returns {number}
 */
export function windStrength(w) {
  const rain = Math.max(0, Math.min(1, (w && w.rain) || 0));
  const snow = Math.max(0, Math.min(1, (w && w.snow) || 0));
  const leaves = Math.max(0, Math.min(1, (w && w.leaves) || 0));
  if (rain > 0) return 1 + 0.8 * rain;
  return (1 + 0.6 * leaves) * (1 - 0.9 * snow);
}

/**
 * Draw an icon with its ambient motion (sway / crawl / inch) or plainly. Returns the kind handled ('' = plain).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ drawIcon: Function }} atlas
 * @param {string} type icon / source type
 * @param {number} x screen px (icon centre)
 * @param {number} y
 * @param {number} size icon CSS size
 * @param {{ t: number, uid: number, wind?: number, wx?: number, wy?: number }} o time, uid, wind strength and the
 *   object's world position (for the wind field)
 * @returns {string}
 */
export function drawIconAmbient(ctx, atlas, type, x, y, size, o) {
  const kind = AMBIENT_KIND[type] || '';
  const t = o.t;
  const ph = ambientPhase(o.uid);
  if (kind === 'sway') {
    const k = (SWAY_AMP[type] || 0.08) * (o.wind ?? 1) * windAt(o.wx ?? x, o.wy ?? y, t + ph * 0.6);
    if (Math.abs(k) < 1e-3) {
      atlas.drawIcon(ctx, type, x, y, size);
      return kind;
    }
    const by = y + size * 0.36;
    ctx.save();
    ctx.translate(x, by);
    ctx.transform(1, 0, k, 1, 0, 0);
    atlas.drawIcon(ctx, type, 0, y - by, size);
    ctx.restore();
    return kind;
  }
  if (kind === 'crawl') {
    // a few px forward and back along the heading with a slow wander of the heading; the cricket also hops now and then
    const w = t * 0.55 + ph * 6.28;
    const dx = Math.sin(w) * size * 0.05;
    const rot = Math.sin(t * 0.31 + ph * 9) * 0.16 + Math.sin(t * 7.3 + ph * 3) * 0.012;
    let hop = 0;
    if (type === 'prey_cricket') {
      const c = (t * 0.21 + ph) % 1;
      if (c < 0.06) hop = Math.sin((c / 0.06) * Math.PI) * size * 0.1;
    }
    ctx.save();
    ctx.translate(x, y - hop);
    ctx.rotate(rot);
    ctx.translate(dx, 0);
    atlas.drawIcon(ctx, type, 0, 0, size);
    if (type === 'prey_beetle' || type === 'myrmecophile') antennae(ctx, size, t, ph);
    ctx.restore();
    return kind;
  }
  if (kind === 'inch') {
    // inchworm wave: the body bunches up (shorter, taller) and stretches out again from the tail, then creeps on
    const w = (t * 0.9 + ph) % 1;
    const bunch = Math.sin(w * Math.PI) ** 2;
    const sx = 1 - 0.12 * bunch;
    const sy = 1 + 0.1 * bunch;
    const tail = -size * 0.32;
    const creep = Math.sin(t * 0.17 + ph * 6.28) * size * 0.04;
    ctx.save();
    ctx.translate(x + tail + creep, y);
    ctx.scale(sx, sy);
    atlas.drawIcon(ctx, type, -tail, 0, size);
    ctx.restore();
    return kind;
  }
  atlas.drawIcon(ctx, type, x, y, size);
  return kind;
}

/** Twitching antennae on a crawler's head (icon space faces +x; the head sits near +0.3). */
function antennae(ctx, size, t, ph) {
  const burst = Math.sin(t * 0.8 + ph * 5) > 0.55 ? Math.sin(t * 15 + ph * 7) * 0.05 : 0;
  ctx.strokeStyle = 'rgba(20,28,20,0.85)';
  ctx.lineWidth = Math.max(0.8, size * 0.018);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const sgn of [-1, 1]) {
    const tw = sgn > 0 ? burst : -burst * 0.6;
    ctx.moveTo(size * 0.3, sgn * size * 0.03);
    ctx.quadraticCurveTo(size * 0.38, sgn * size * (0.06 + tw), size * 0.45, sgn * size * (0.13 + tw * 1.6));
  }
  ctx.stroke();
}

/**
 * Extras drawn over a source / object after its icon: a fly buzzing over a dead insect, termites milling round
 * their mound, alates fluttering over a swarm, soil puffs from a molehill.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type
 * @param {number} x screen px
 * @param {number} y
 * @param {number} size icon CSS size
 * @param {{ t: number, uid: number }} o
 * @returns {void}
 */
export function drawAmbientExtras(ctx, type, x, y, size, o) {
  const kind = AMBIENT_KIND[type];
  if (!kind || kind === 'sway' || kind === 'crawl' || kind === 'inch') return;
  const t = o.t;
  const ph = ambientPhase(o.uid);
  if (kind === 'fly') {
    // a figure-of-eight over the carcass; it lands for a moment now and then
    const c = (t * 0.12 + ph) % 1;
    if (c > 0.82) return;
    const a = t * 2.4 + ph * 6.28;
    const fx = x + Math.sin(a) * size * 0.34;
    const fy = y - size * 0.22 + Math.sin(a * 2) * size * 0.14;
    const r = Math.max(1, size * 0.032);
    const flap = 0.5 + 0.5 * Math.sin(t * 60 + ph * 11);
    ctx.fillStyle = `rgba(235,240,250,${0.35 + 0.35 * flap})`;
    ctx.beginPath();
    ctx.ellipse(fx - r * 0.9, fy - r * 0.9, r * 1.2, r * 0.6, -0.6, 0, Math.PI * 2);
    ctx.ellipse(fx + r * 0.9, fy - r * 0.9, r * 1.2, r * 0.6, 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(25,25,30,0.95)';
    ctx.beginPath();
    ctx.arc(fx, fy, r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (kind === 'termites') {
    // pale workers milling round the mound's foot, each on its own little loop
    const r0 = Math.max(0.9, size * 0.028);
    for (let k = 0; k < 6; k++) {
      const dir = k % 2 ? 1 : -1;
      const a = t * (0.35 + 0.08 * k) * dir + k * 1.05 + ph * 6.28;
      const rr = size * (0.3 + 0.06 * Math.sin(t * 1.3 + k * 2.1));
      const tx = x + Math.cos(a) * rr;
      const ty = y + size * 0.3 + Math.sin(a) * rr * 0.3;
      const hx = Math.cos(a + dir * Math.PI / 2) * r0 * 1.4;
      const hy = Math.sin(a + dir * Math.PI / 2) * r0 * 0.5;
      ctx.fillStyle = 'rgba(240,226,196,0.95)';
      ctx.beginPath();
      ctx.arc(tx, ty, r0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(150,90,40,0.95)';
      ctx.beginPath();
      ctx.arc(tx + hx, ty + hy, r0 * 0.75, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === 'swarm') {
    // winged alates fluttering up from the swarm
    const r0 = Math.max(0.9, size * 0.03);
    ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      const q = ph * 6.28 + k * 2.3;
      const ax = x + Math.sin(t * 1.7 + q) * size * 0.5;
      const ay = y - size * 0.1 + Math.cos(t * 2.3 + q * 1.3) * size * 0.32;
      const flap = Math.sin(t * 38 + k * 1.7);
      ctx.strokeStyle = `rgba(240,245,255,${0.45 + 0.3 * flap})`;
      ctx.lineWidth = Math.max(0.8, r0 * 0.9);
      ctx.beginPath();
      ctx.moveTo(ax - r0 * 2.4, ay - r0 * (0.6 + flap));
      ctx.lineTo(ax, ay);
      ctx.lineTo(ax + r0 * 2.4, ay - r0 * (0.6 + flap));
      ctx.stroke();
      ctx.fillStyle = 'rgba(120,80,40,0.95)';
      ctx.beginPath();
      ctx.arc(ax, ay, r0, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  if (kind === 'puff') {
    // every 6–9 s a little cloud of soil crumbs pops out of the top and falls back
    const period = 6 + 3 * ph;
    const local = (t + ph * period) % period;
    const dur = 1.1;
    if (local > dur) return;
    const u = local / dur;
    const r0 = Math.max(0.9, size * 0.03);
    for (let k = 0; k < 6; k++) {
      const spread = (k - 2.5) / 2.5;
      const px = x + spread * size * (0.06 + 0.22 * u);
      const py = y - size * 0.12 - Math.sin(u * Math.PI) * size * (0.22 + 0.08 * ((k * 7) % 3));
      ctx.fillStyle = `rgba(${96 + k * 6},${66 + k * 4},${40},${0.9 * (1 - u)})`;
      ctx.beginPath();
      ctx.arc(px, py, r0 * (1 + 0.4 * (k % 2)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = `rgba(150,120,90,${0.25 * (1 - u)})`;
    ctx.beginPath();
    ctx.arc(x, y - size * 0.2 - u * size * 0.15, size * (0.1 + 0.18 * u), 0, Math.PI * 2);
    ctx.fill();
  }
}
